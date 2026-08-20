"""Missing-information agent for GitHub reports.

Usage:
    python missing_info_agent.py --repo owner/name --issue 513

The workflow only drafts a comment. It never posts to GitHub automatically.
Configure credentials in a local .env file or in the process environment.
"""

from __future__ import annotations

import argparse
import base64
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

# Fields that make a report actionable, per issue type. Every type gets checked,
# so the agent always produces a meaningful assessment instead of passing through.
REQUIRED_BY_TYPE = {
    "bug": ["os", "version", "reproduction_steps", "expected_actual"],
    "feature": ["use_case", "expected_behavior"],
    "question": ["context"],
    "other": ["context"],
}

FIELD_LABELS = {
    "os": "your operating system",
    "version": "the app or package version",
    "reproduction_steps": "the exact steps to reproduce the issue",
    "expected_actual": "what you expected to happen and what actually happened",
    "use_case": "the use case or problem this feature solves",
    "expected_behavior": "the expected behavior of the feature",
    "context": "more context about what you are trying to do",
}

# Human-readable section headers that count as evidence a field is present.
FIELD_MARKERS = {
    "os": r"(?m)^\s*(?:#+\s*)?(?:os|operating system|platform)(?:\s*[:\-]|\s*$)",
    "version": r"(?m)^\s*(?:#+\s*)?(?:version|release)(?:\s*[:\-]|\s*$)",
    "reproduction_steps": r"(?m)^\s*(?:#+\s*)?(?:repro(duction)? steps?|steps to reproduce|steps)(?:\s*[:\-]|\s*$)",
    "expected_actual": r"(?m)^\s*(?:#+\s*)?(?:expected|actual|what happened|what should happen)(?:\s*[:\-]|\s*$)",
    "use_case": r"(?m)^\s*(?:#+\s*)?(?:use case|use-case|motivation|problem|why)(?:\s*[:\-]|\s*$)",
    "expected_behavior": r"(?m)^\s*(?:#+\s*)?(?:expected behavior|expected behaviour|desired behavior|acceptance criteria)(?:\s*[:\-]|\s*$)",
    "context": r"(?m)^\s*(?:#+\s*)?(?:context|background|details|environment)(?:\s*[:\-]|\s*$)",
}

# Patterns looked for in the repo's issue template / CONTRIBUTING.md.
GUIDANCE_PATTERNS = {
    "bug": {
        "os": r"\b(os|operating system|platform)\b",
        "version": r"\b(version|release)\b",
        "reproduction_steps": r"\b(repro|reproduction|steps to reproduce|steps)\b",
        "expected_actual": r"\b(expected|actual|behavior|behaviour)\b",
    },
    "feature": {
        "use_case": r"\b(use case|use-case|motivation|problem|why)\b",
        "expected_behavior": r"\b(expected behavior|expected behaviour|desired|acceptance)\b",
    },
}

FIELD_REQUEST = {
    "os": "your operating system",
    "version": "the app or package version",
    "reproduction_steps": "the exact steps to reproduce the issue",
    "expected_actual": "what you expected to happen and what actually happened",
    "use_case": "the use case or problem this feature solves",
    "expected_behavior": "the expected behavior of the feature",
    "context": "more context about what you are trying to do",
}

TEMPLATE_PATHS = (
    ".github/ISSUE_TEMPLATE/bug_report.md",
    ".github/ISSUE_TEMPLATE/feature_request.md",
    "CONTRIBUTING.md",
)


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


def _heuristic_type(title: str, body: str) -> str:
    """Deterministic classification used when no model key is configured or the
    model call fails. Never guesses: matches on explicit vocabulary."""
    text = f"{title} {body}".lower()
    if re.search(r"\b(bug|error|crash|broken|fail|failing|not work|doesn'?t work|exception)\b", text):
        return "bug"
    if re.search(r"\b(feature|enhancement|request|please add|would be nice|support for|new option|allow)\b", text):
        return "feature"
    if re.search(r"\b(how do|how can|is it possible|question|what is|help me)\b", text):
        return "question"
    return "other"


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
        return {"issue": issue, "action": "pass-through", "issue_type": "other"}

    guidance_parts = []
    for path in TEMPLATE_PATHS:
        try:
            file_data = github_request(
                f"/repos/{state['owner']}/{state['repo']}/contents/{path}", token
            )
            guidance_parts.append(
                f"{path}:\n{base64.b64decode(file_data['content']).decode('utf-8')}"
            )
        except requests.HTTPError as error:
            if error.response is None or error.response.status_code != 404:
                raise

    return {"issue": issue, "guidance": "\n\n".join(guidance_parts)}


def classify_issue(state: AgentState) -> AgentState:
    issue = state["issue"]
    title = issue.get("title", "")
    body = issue.get("body") or ""
    issue_type = _heuristic_type(title, body)

    model_key = os.getenv("NVIDIA_API_KEY")
    if model_key:
        try:
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
                        "Classify the GitHub issue into exactly one of: bug, feature, "
                        "question, other.\n"
                        "- bug: reports unexpected behavior, crashes, errors, or failures.\n"
                        "- feature: requests a new capability, enhancement, or support.\n"
                        "- question: asks how to do something.\n"
                        "- other: anything else.\n"
                        "Reply with JSON only.",
                    ),
                    ("human", "Title and body:\n{issue_text}"),
                ]
            )
            assessment = (prompt | client).invoke({"issue_text": f"{title}\n{body}"})
            issue_type = assessment.issue_type.lower()
        except Exception:
            issue_type = _heuristic_type(title, body)

    if issue_type not in REQUIRED_BY_TYPE:
        issue_type = "other"
    return {"issue_type": issue_type}


def find_required_fields(state: AgentState) -> AgentState:
    issue_type = state.get("issue_type", "other")
    required = list(REQUIRED_BY_TYPE.get(issue_type, ["context"]))
    guidance = (state.get("guidance") or "").lower()

    # Prefer the repo's own template when it explicitly asks for fields.
    patterns = GUIDANCE_PATTERNS.get(issue_type, {})
    if patterns and guidance:
        requested = [field for field in required if re.search(patterns[field], guidance)]
        if requested:
            required = requested

    if issue_type == "bug" and not guidance:
        # No repo template: learn from project memory — fields that similar past
        # bug reports in this repo were missing.
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
    present = [field for field in required if re.search(FIELD_MARKERS[field], body)]
    return {
        "required_fields": required,
        "present_fields": present,
        "missing_fields": [field for field in required if field not in present],
    }


def _draft_comment(issue_type: str, missing: List[str]) -> str:
    points = [f"- {FIELD_REQUEST[field]}" for field in missing if field in FIELD_REQUEST]
    if not points:
        return ""
    if issue_type == "bug":
        intro = "Thanks for reporting this! To help us reproduce and fix it, could you share the following details?"
    elif issue_type == "feature":
        intro = "Thanks for the suggestion! To help us evaluate it, could you share the following details?"
    else:
        intro = "Thanks for reaching out! To help you, could you add the following details?"
    return intro + "\n\n" + "\n".join(points)


def draft_follow_up(state: AgentState) -> AgentState:
    issue_type = state.get("issue_type", "other")
    missing = state.get("missing_fields", [])
    _remember(state)

    if not missing:
        return {"action": "pass-through", "draft_comment": ""}

    comment = _draft_comment(issue_type, missing)
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