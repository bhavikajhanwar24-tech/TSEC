"""
Backlog Agent — server entrypoint for the RepoGuardian backend.

Reads a JSON request from stdin (written by the Express backend), fetches the
repository's REAL open issues + comment history from the GitHub API, runs the
LangGraph backlog sweep, and prints a JSON result to stdout.

Request (stdin):
  {"owner": "...", "repo": "...", "repo_norms": { ... }}

Response (stdout):
  {"report": "<markdown sweep report>", "analysis_results": [...]}

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

from agent import create_backlog_graph

load_dotenv()

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv(os.path.join(BASE_DIR, ".env"))

API = "https://api.github.com"
MAINTAINER_ASSOCIATIONS = {"OWNER", "COLLABORATOR", "MEMBER"}


def github_headers(token):
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": "RepoGuardian-BacklogAgent",
        "Accept": "application/vnd.github+json",
    }


def _gh_get(url, headers, params=None):
    items = []
    while url:
        resp = requests.get(url, headers=headers, params=params, timeout=30)
        resp.raise_for_status()
        items.extend(resp.json())
        params = None
        url = resp.links.get("next", {}).get("url", "")
    return items


def fetch_open_issues(owner, repo, token, limit=100):
    """Fetch open issues (no PRs) plus comment history, mapped to the shape the
    backlog agent's LangGraph expects."""
    headers = github_headers(token)
    raw = _gh_get(
        f"{API}/repos/{owner}/{repo}/issues",
        headers,
        {"state": "open", "per_page": 100, "sort": "updated", "direction": "desc"},
    )
    issues = [i for i in raw if "pull_request" not in i][:limit]

    now = datetime.now(timezone.utc)
    out = []
    for issue in issues:
        comments = _gh_get(issue["comments_url"], headers) if issue.get("comments", 0) else []
        mapped_comments = []
        last_activity = datetime.fromisoformat(issue["created_at"].replace("Z", "+00:00"))
        for c in comments:
            created = datetime.fromisoformat(c["created_at"].replace("Z", "+00:00"))
            if created > last_activity:
                last_activity = created
            mapped_comments.append(
                {
                    "author": (c.get("user") or {}).get("login", "unknown"),
                    "created_at": c["created_at"],
                    "body": c.get("body") or "",
                    "is_maintainer": (c.get("author_association") or "").upper() in MAINTAINER_ASSOCIATIONS,
                }
            )
        last_activity_days = max(0, int((now - last_activity).total_seconds() // 86400))
        out.append(
            {
                "number": issue["number"],
                "title": issue["title"],
                "last_activity_days": last_activity_days,
                "description": issue.get("body") or "",
                "comments": mapped_comments,
            }
        )
    return out


def main():
    payload = json.load(sys.stdin)
    owner = payload.get("owner")
    repo = payload.get("repo")
    repo_norms = payload.get("repo_norms") or {}
    token = os.environ.get("GITHUB_TOKEN", "")

    if not owner or not repo:
        print(json.dumps({"error": "owner and repo are required"}), file=sys.stderr)
        sys.exit(1)
    if not token:
        print(json.dumps({"error": "GITHUB_TOKEN is required"}), file=sys.stderr)
        sys.exit(1)

    issues = fetch_open_issues(owner, repo, token)

    graph = create_backlog_graph()
    # agent.py logs progress to stdout; route those to stderr so stdout stays
    # pure JSON for the backend to parse.
    with redirect_stdout(sys.stderr):
        final_state = graph.invoke(
            {
                "issues": issues,
                "repo_norms": repo_norms,
                "analysis_results": [],
                "current_index": 0,
                "summary_report": "",
            }
        )

    result = {
        "repository": f"{owner}/{repo}",
        "issues_analyzed": len(issues),
        "analysis_results": final_state["analysis_results"],
        "report": final_state["summary_report"],
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()