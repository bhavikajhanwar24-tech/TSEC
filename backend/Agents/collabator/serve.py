"""Contributor Agent server entrypoint for RepoGuardian."""

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List

import requests
from dotenv import load_dotenv

from collaborator_agent import create_collaborator_graph

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv(os.path.join(BASE_DIR, ".env"))

API = "https://api.github.com"
MAX_CONTRIBUTORS = 30
MAX_COMMITS = 12
MAX_MERGED_PRS = 12
HISTORY_DAYS = 90


def github_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "User-Agent": "RepoGuardian-ContributorAgent",
        "Accept": "application/vnd.github+json",
    }


def _gh_get(url: str, headers: Dict[str, str], params: Dict[str, Any] | None = None, max_pages: int = 3) -> Any:
    items: List[Any] = []
    pages = 0
    while url and pages < max_pages:
        pages += 1
        response = requests.get(url, headers=headers, params=params, timeout=30)
        response.raise_for_status()
        payload = response.json()
        if isinstance(payload, list):
            items.extend(payload)
        elif isinstance(payload, dict) and isinstance(payload.get("items"), list):
            items.extend(payload["items"])
        else:
            return payload
        params = None
        url = response.links.get("next", {}).get("url", "")
    return items


def _gh_search(query: str, headers: Dict[str, str], per_page: int = 30) -> List[Dict[str, Any]]:
    return _gh_get(f"{API}/search/issues", headers, {"q": query, "per_page": per_page}, max_pages=2)


def _iso_days(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    try:
        left = datetime.fromisoformat(start.replace("Z", "+00:00"))
        right = datetime.fromisoformat(end.replace("Z", "+00:00"))
        return round(max(0, (right - left).total_seconds() / 86400), 1)
    except (TypeError, ValueError):
        return None


def _first_activity(pr: Dict[str, Any], comments: List[Dict[str, Any]]) -> str | None:
    dates = [pr.get("created_at")]
    dates.extend(comment.get("created_at") for comment in comments)
    dates = [date for date in dates if date]
    return min(dates) if dates else None


def fetch_issue(owner: str, repo: str, issue_number: int, headers: Dict[str, str]) -> Dict[str, Any]:
    issue = _gh_get(f"{API}/repos/{owner}/{repo}/issues/{issue_number}", headers)
    comments = _gh_get(issue.get("comments_url", ""), headers) if issue.get("comments") else []
    issue["comments"] = [{"author": (c.get("user") or {}).get("login", "unknown"), "body": c.get("body") or "", "created_at": c.get("created_at", "")} for c in comments]
    body = issue.get("body") or ""
    issue["changed_file_hints"] = list(dict.fromkeys(re.findall(r"(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:py|js|jsx|ts|tsx|java|go|rb|rs|json|yml|yaml|md|css|html)", body)))
    return issue


def fetch_contributor(owner: str, repo: str, contributor: Dict[str, Any], headers: Dict[str, str], since: str) -> Dict[str, Any]:
    login = contributor.get("login", "")
    result = {"login": login, "languages": {}, "commits": [], "merged_prs": [], "open_assigned_issues": 0, "open_authored_prs": 0}
    try:
        commit_list = _gh_get(f"{API}/repos/{owner}/{repo}/commits", headers, {"author": login, "since": since, "per_page": MAX_COMMITS}, max_pages=1)
        # Commit details contain changed paths; fetch these bounded details in parallel.
        with ThreadPoolExecutor(max_workers=8) as pool:
            details = list(pool.map(lambda commit: _gh_get(commit["url"], headers), commit_list[:MAX_COMMITS]))
        result["commits"] = [{"sha": detail.get("sha"), "message": (detail.get("commit") or {}).get("message", ""), "paths": [file.get("filename", "") for file in detail.get("files", [])]} for detail in details]
    except requests.RequestException:
        pass
    try:
        prs = _gh_search(f"repo:{owner}/{repo} is:pr is:merged author:{login}", headers, MAX_MERGED_PRS)
        # Pull requests, files, and comments are independent GitHub calls; parallelize them to avoid N sequential calls.
        with ThreadPoolExecutor(max_workers=8) as pool:
            details = list(pool.map(lambda item: _gh_get(item["pull_request"]["url"], headers), prs[:MAX_MERGED_PRS]))
        def enrich(detail: Dict[str, Any]) -> Dict[str, Any]:
            comments = _gh_get(detail.get("comments_url", ""), headers) if detail.get("comments") else []
            files = _gh_get(detail.get("url", "") + "/files", headers, {"per_page": 100})
            start = _first_activity(detail, comments)
            return {"title": detail.get("title", ""), "body": detail.get("body") or "", "labels": [label.get("name", "") for label in detail.get("labels", [])], "turnaround_days": _iso_days(start, detail.get("merged_at")), "comments": comments, "paths": [file.get("filename", "") for file in files]}
        with ThreadPoolExecutor(max_workers=8) as pool:
            result["merged_prs"] = list(pool.map(enrich, details))
    except requests.RequestException:
        pass
    try:
        result["open_assigned_issues"] = len(_gh_search(f"repo:{owner}/{repo} is:issue is:open assignee:{login}", headers, 30))
        result["open_authored_prs"] = len(_gh_search(f"repo:{owner}/{repo} is:pr is:open author:{login}", headers, 30))
    except requests.RequestException:
        pass
    return result


def main() -> None:
    payload = json.load(sys.stdin)
    owner = payload.get("owner")
    repo = payload.get("repo")
    issue_number = payload.get("issue_number")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not owner or not repo or not issue_number:
        print(json.dumps({"error": "owner, repo, and issue_number are required"}), file=sys.stderr)
        sys.exit(1)
    if not token:
        print(json.dumps({"error": "GITHUB_TOKEN is required"}), file=sys.stderr)
        sys.exit(1)

    headers = github_headers(token)
    since = (datetime.now(timezone.utc) - timedelta(days=HISTORY_DAYS)).isoformat()
    try:
        # These repository and issue calls are independent; parallelize them to avoid N sequential GitHub calls.
        with ThreadPoolExecutor(max_workers=8) as pool:
            contributors_future = pool.submit(_gh_get, f"{API}/repos/{owner}/{repo}/contributors", headers, {"per_page": MAX_CONTRIBUTORS}, 1)
            languages_future = pool.submit(_gh_get, f"{API}/repos/{owner}/{repo}/languages", headers)
            issue_future = pool.submit(fetch_issue, owner, repo, int(issue_number), headers)
            contributors = contributors_future.result()[:MAX_CONTRIBUTORS]
            languages = languages_future.result() or {}
            issue = issue_future.result()
        # Each contributor's bounded history is independent; parallelize the calls to keep the run fast.
        with ThreadPoolExecutor(max_workers=8) as pool:
            evidence = list(pool.map(lambda contributor: fetch_contributor(owner, repo, contributor, headers, since), contributors))
    except requests.RequestException as error:
        print(json.dumps({"error": f"GitHub API request failed: {error}"}), file=sys.stderr)
        sys.exit(1)

    for candidate in evidence:
        candidate["languages"] = languages
    graph = create_collaborator_graph()
    with redirect_stdout(sys.stderr):
        final_state = graph.invoke({"issue": issue, "contributors": evidence, "repository": {"owner": owner, "repo": repo}, "memory_context": "", "matches": []})
    matches = final_state.get("matches", [])
    result = {"repository": f"{owner}/{repo}", "issue_number": int(issue_number), "candidates": matches, "recommended": matches[0]["login"] if matches else None}
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
