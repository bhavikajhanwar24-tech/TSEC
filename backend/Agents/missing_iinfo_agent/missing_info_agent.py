"""Missing-information agent for GitHub bug reports.

Usage:
    python missing_info_agent.py --repo owner/name --issue 513

The workflow only drafts a comment. It never posts to GitHub automatically.
Configure credentials in a local .env file or in the process environment.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, TypedDict

import requests
from dotenv import load_dotenv
from langchain_core.prompts import ChatPromptTemplate
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from langgraph.graph import END, StateGraph
from pydantic import BaseModel, Field

COMMON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common")
if COMMON_DIR not in sys.path:
    sys.path.insert(0, COMMON_DIR)
import memory_store  # noqa: E402  (shared persistent Chroma memory)


GITHUB_API = "https://api.github.com"
BUG_TERMS = ("bug", "error", "crash", "broken", "fail", "not work", "issue")
FIELD_LABELS = {
    "os": "your operating system",
    "version": "the app or package version",
    "reproduction_steps": "the exact steps to reproduce the issue",
    "expected_actual": "what you expected to happen and what actually happened",
}


class IssueAssessment(BaseModel):
    """Small structured response produced by the model."""

    issue_type: str = Field(description="One of: bug, feature, question, other")
    confidence: float = Field(ge=0, le=1)


class AgentState(TypedDict, total=False):
    owner: str
    repo: str
    issue_number: int
    issue: Dict[str, Any]
    guidance: str
    issue_type: str
    required_fields: List[str]
    present_fields: List[str]
    missing_fields: List[str]
    draft_comment: str
    action: str
    error: str


def github_request(path: str, token: str) -> Any:
    response = requests.get(
        f"{GITHUB_API}{path}",
        headers={
            "Accept": "application/vnd.github+json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "missing-information-agent",
        },
        timeout=30,
    )
    response.raise_for_status()
    return response.json()


def fetch_issue(state: AgentState) -> AgentState:
    token = os.environ["GITHUB_TOKEN"]
    issue = github_request(
        f"/repos/{state['owner']}/{state['repo']}/issues/{state['issue_number']}",
        token,
    )
    if "pull_request" in issue:
        return {"issue": issue, "action": "pass-through"}

    guidance_parts = []
    for path in (".github/ISSUE_TEMPLATE/bug_report.md", "CONTRIBUTING.md"):
        try:
            file_data = github_request(
                f"/repos/{state['owner']}/{state['repo']}/contents/{path}", token
            )
            import base64

            guidance_parts.append(
                f"{path}:\n{base64.b64decode(file_data['content']).decode('utf-8')}"
            )
        except requests.HTTPError as error:
            if error.response is None or error.response.status_code != 404:
                raise

    return {"issue": issue, "guidance": "\n\n".join(guidance_parts)}


def classify_issue(state: AgentState) -> AgentState:
    issue = state["issue"]
    text = f"{issue.get('title', '')}\n{issue.get('body') or ''}".lower()
    issue_type = "bug" if any(term in text for term in BUG_TERMS) else "other"

    model_key = os.getenv("NVIDIA_API_KEY")
    if model_key:
        client = ChatNVIDIA(
            model=os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b"),
            api_key=model_key,
            temperature=0,
            max_completion_tokens=256,
        ).with_structured_output(IssueAssessment)
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "Classify the GitHub issue as bug, feature, question, or other.",
                ),
                ("human", "Title and body:\n{issue_text}"),
            ]
        )
        assessment = (prompt | client).invoke(
            {"issue_text": f"{issue.get('title', '')}\n{issue.get('body') or ''}"}
        )
        issue_type = assessment.issue_type.lower()

    return {"issue_type": issue_type}


def find_required_fields(state: AgentState) -> AgentState:
    if state.get("issue_type") != "bug":
        return {"required_fields": [], "present_fields": [], "missing_fields": []}

    guidance = state.get("guidance", "").lower()
    required = ["os", "version", "reproduction_steps", "expected_actual"]
    if guidance:
        required = []
        if re.search(r"\b(os|operating system|platform)\b", guidance):
            required.append("os")
        if re.search(r"\b(version|release)\b", guidance):
            required.append("version")
        if re.search(r"\b(repro|reproduction|steps to reproduce|steps)\b", guidance):
            required.append("reproduction_steps")
        if re.search(r"\b(expected|actual|behavior|behaviour)\b", guidance):
            required.append("expected_actual")
        required = required or ["os", "version", "reproduction_steps", "expected_actual"]
    else:
        # No repo template: learn from the project memory — fields that similar
        # past bug reports in this repo were missing.
        try:
            embedder = memory_store.build_embedder()
            issue = state["issue"]
            query_text = f"{issue.get('title', '')}\n{issue.get('body') or ''}"
            hits = memory_store.retrieve(
                state.get("owner", ""), state.get("repo", ""), embedder.embed_query(query_text), k=3,
                where={"kind": "issue", "issue_type": "bug"},
            )
            remembered: List[str] = []
            for hit in hits:
                for field in (hit["metadata"].get("missing_fields") or "").split(","):
                    field = field.strip()
                    if field in FIELD_LABELS and field not in remembered:
                        remembered.append(field)
            if remembered:
                required = remembered
        except Exception:
            pass

    body = (state["issue"].get("body") or "").lower()
    markers = {
        "os": r"(?m)^\s*(?:#+\s*)?(?:os|operating system|platform)(?:\s*[:\-]|\s*$)",
        "version": r"(?m)^\s*(?:#+\s*)?(?:version|release)(?:\s*[:\-]|\s*$)",
        "reproduction_steps": r"(?m)^\s*(?:#+\s*)?(?:repro(duction)? steps?|steps to reproduce|steps)(?:\s*[:\-]|\s*$)",
        "expected_actual": r"(?m)^\s*(?:#+\s*)?(?:expected|actual|what happened|what should happen)(?:\s*[:\-]|\s*$)",
    }
    present = [field for field in required if re.search(markers[field], body)]
    return {
        "required_fields": required,
        "present_fields": present,
        "missing_fields": [field for field in required if field not in present],
    }


def draft_follow_up(state: AgentState) -> AgentState:
    missing = state.get("missing_fields", [])
    if state.get("issue_type") != "bug" or not missing:
        # Still remember the issue in the shared project memory so future runs
        # can learn what this repo's reports look like. Never blocks.
        _remember(state)
        return {"action": "pass-through", "draft_comment": ""}

    # Remember this report and what it was missing (used as learning signal for
    # future issues when the repo has no issue template). Never blocks.
    _remember(state)

    requested = [FIELD_LABELS[field] for field in missing]
    if len(requested) == 1:
        request_text = requested[0]
    elif len(requested) == 2:
        request_text = f"{requested[0]} and {requested[1]}"
    else:
        request_text = ", ".join(requested[:-1]) + f", and {requested[-1]}"

    comment = (
        "Thanks for reporting this! To help us investigate, could you share "
        f"{request_text}? This will help us reproduce the issue quickly."
    )
    return {"action": "needs-info", "draft_comment": comment}


def _remember(state: AgentState) -> None:
    """Persist the analyzed issue into the shared project memory (best-effort)."""
    owner, repo = state.get("owner", ""), state.get("repo", "")
    if not (owner and repo):
        return
    try:
        issue = state.get("issue") or {}
        text = f"{issue.get('title', '')}\n{issue.get('body') or ''}"
        embedder = memory_store.build_embedder()
        memory_store.ingest(
            owner,
            repo,
            [
                {
                    "id": f"issue-{issue.get('number', '')}",
                    "text": text,
                    "embedding": embedder.embed_query(text),
                    "metadata": {
                        "kind": "issue",
                        "number": issue.get("number", 0),
                        "issue_type": state.get("issue_type", ""),
                        "action": state.get("action", ""),
                        "missing_fields": ",".join(state.get("missing_fields", [])),
                        "created_at": issue.get("created_at", ""),
                    },
                }
            ],
        )
    except Exception:
        pass


def build_graph() -> Any:
    graph = StateGraph(AgentState)
    graph.add_node("fetch_issue", fetch_issue)
    graph.add_node("classify_issue", classify_issue)
    graph.add_node("find_required_fields", find_required_fields)
    graph.add_node("draft_follow_up", draft_follow_up)
    graph.set_entry_point("fetch_issue")
    graph.add_conditional_edges(
        "fetch_issue",
        lambda state: "draft_follow_up" if state.get("action") == "pass-through" else "classify_issue",
        {"classify_issue": "classify_issue", "draft_follow_up": "draft_follow_up"},
    )
    graph.add_edge("classify_issue", "find_required_fields")
    graph.add_edge("find_required_fields", "draft_follow_up")
    graph.add_edge("draft_follow_up", END)
    return graph.compile()


def main() -> None:
    BASE_DIR = os.path.dirname(os.path.abspath(__file__))
    BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
    load_dotenv(os.path.join(BACKEND_DIR, ".env"))   # shared backend credentials
    load_dotenv(os.path.join(BASE_DIR, ".env"))      # optional local overrides
    parser = argparse.ArgumentParser(description="Draft targeted GitHub missing-info requests")
    parser.add_argument("--repo", required=True, help="Repository in owner/name format")
    parser.add_argument("--issue", required=True, type=int, help="GitHub issue number")
    args = parser.parse_args()
    if "/" not in args.repo:
        parser.error("--repo must use owner/name format")
    if not os.getenv("GITHUB_TOKEN"):
        parser.error("GITHUB_TOKEN is missing from the environment")

    owner, repo = args.repo.split("/", 1)
    result = build_graph().invoke(
        {"owner": owner, "repo": repo, "issue_number": args.issue}
    )
    print(json.dumps({key: result.get(key) for key in (
        "issue_type", "required_fields", "present_fields", "missing_fields", "action", "draft_comment"
    )}, indent=2))


if __name__ == "__main__":
    main()
