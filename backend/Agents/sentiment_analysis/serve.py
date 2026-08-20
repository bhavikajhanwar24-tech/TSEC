"""
Contention & Sentiment Agent — server entrypoint for the RepoGuardian backend.

Reads a JSON request from stdin (written by the Express backend), fetches the
real PR/issue thread + comment history from the GitHub API, runs the LangGraph
sentiment workflow, and prints a JSON result to stdout.

Request (stdin):
  {"owner": "...", "repo": "...", "issueNumber": 515, "repo_norms": {...}}

Response (stdout):
  {"analysis_results": {...}, "rag_precedents": [...], "report": "..."}

Auth: GITHUB_TOKEN is read from the environment (the backend passes the
user's session GitHub token when spawning this process).
"""

import json
import os
import sys
from contextlib import redirect_stdout
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

from agent import create_sentiment_graph

load_dotenv()

API = "https://api.github.com"
MAINTAINER_ASSOCIATIONS = {"OWNER", "COLLABORATOR", "MEMBER"}


def github_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": "RepoGuardian-SentimentAgent",
        "Accept": "application/vnd.github+json",
    }


def fetch_thread(owner, repo, number, token):
    """Fetch the real issue/PR plus its comment thread, shaped for the graph."""
    headers = github_headers(token)
    resp = requests.get(f"{API}/repos/{owner}/{repo}/issues/{number}", headers=headers, timeout=30)
    resp.raise_for_status()
    issue = resp.json()

    comments_resp = requests.get(issue["comments_url"], headers=headers, timeout=30)
    comments_resp.raise_for_status()
    comments = []
    for c in comments_resp.json():
        comments.append(
            {
                "author": (c.get("user") or {}).get("login", "unknown"),
                "created_at": c["created_at"],
                "body": c.get("body") or "",
                "is_maintainer": (c.get("author_association") or "").upper() in MAINTAINER_ASSOCIATIONS,
            }
        )

    created = datetime.fromisoformat(issue["created_at"].replace("Z", "+00:00"))
    days_open = max(0, int((datetime.now(timezone.utc) - created).total_seconds() // 86400))
    return {
        "number": issue["number"],
        "title": issue["title"],
        "days_open": days_open,
        "state": issue.get("state", "open"),
        "description": issue.get("body") or "",
        "comments": comments,
    }


def main():
    payload = json.load(sys.stdin)
    owner = payload.get("owner")
    repo = payload.get("repo")
    issue_number = payload.get("issueNumber")
    repo_norms = payload.get("repo_norms") or {}
    token = os.environ.get("GITHUB_TOKEN", "")

    if not (owner and repo and issue_number):
        print(json.dumps({"error": "owner, repo, and issueNumber are required"}), file=sys.stderr)
        sys.exit(1)
    if not token:
        print(json.dumps({"error": "GITHUB_TOKEN is required"}), file=sys.stderr)
        sys.exit(1)

    thread = fetch_thread(owner, repo, int(issue_number), token)

    graph = create_sentiment_graph()
    # agent.py logs progress to stdout; route those to stderr so stdout stays
    # pure JSON for the backend to parse.
    with redirect_stdout(sys.stderr):
        final_state = graph.invoke(
            {
                "pr_or_issue": thread,
                "repo_norms": repo_norms,
                "rag_precedents": [],
                "analysis_results": {},
                "summary_report": "",
                "owner": owner,
                "repo": repo,
            }
        )

    result = {
        "repository": f"{owner}/{repo}",
        "target": thread["number"],
        "analysis_results": final_state["analysis_results"],
        "rag_precedents": final_state["rag_precedents"],
        "report": final_state["summary_report"],
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()