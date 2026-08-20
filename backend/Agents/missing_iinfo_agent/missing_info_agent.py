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
import postgres_store  # noqa: E402  (optional Postgres run history)


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

# Field keys the LLM is allowed to report. Everything it returns is validated
# against this set, so output stays stable and never invents new categories.
ALLOWED_FIELD_KEYS = (
    "os", "version", "reproduction_steps", "expected_actual",
    "logs", "error_message", "use_case", "expected_behavior", "context",
)


class IssueAssessment(BaseModel):
    """Small structured response produced by the model."""

    issue_type: str = Field(description="One of: bug, feature, question, other")
    confidence: float = Field(ge=0, le=1)


class FieldAssessment(BaseModel):
    """Structured field analysis produced by the model for one issue."""

    required_fields: List[str] = Field(
        description=f"Field keys the report should contain, from this set only: {', '.join(ALLOWED_FIELD_KEYS)}"
    )
    present_fields: List[str] = Field(
        description=f"Required field keys that ARE covered in the issue text, from this set only: {', '.join(ALLOWED_FIELD_KEYS)}"
    )
    missing_details: List[str] = Field(
        description="Short concrete phrases describing exactly what is missing from the actual issue text, "
        "e.g. 'OS version not mentioned', 'No reproduction steps', 'Error logs not attached'. "
        "Base every item strictly on the issue text and template; never invent missing items."
    )


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
    missing_details: List[str]
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


def fetch_issue_comments(owner: str, repo: str, issue_number: int, token: str) -> List[Dict[str, Any]]:
    """Return the complete discussion so answers and previous requests are visible."""
    try:
        return github_request(
            f"/repos/{owner}/{repo}/issues/{issue_number}/comments?per_page=100",
            token,
        )
    except requests.HTTPError:
        return []


def _comment_context(comments: List[Dict[str, Any]]) -> str:
    return "\n\n".join(
        f"[{('AUTOMATION' if comment.get('user', {}).get('type') in {'Bot', 'Integration'} else 'REPORTER')}] "
        f"{comment.get('user', {}).get('login', 'unknown')}:\n{comment.get('body') or ''}"
        for comment in comments
    )


def fetch_issue(state: AgentState) -> AgentState:
    token = os.environ["GITHUB_TOKEN"]
    issue = github_request(
        f"/repos/{state['owner']}/{state['repo']}/issues/{state['issue_number']}",
        token,
    )
    if "pull_request" in issue:
        return {"issue": issue, "action": "pass-through", "issue_type": "other"}

    comments = fetch_issue_comments(
        state["owner"], state["repo"], state["issue_number"], token
    )
    if comments:
        discussion = _comment_context(comments)
        issue = {**issue, "body": f"{issue.get('body') or ''}\n\nGitHub discussion:\n{discussion}"}

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


def _memory_context(state: AgentState) -> str:
    """Similar past issues from the shared Chroma memory, as prompt context."""
    try:
        embedder = memory_store.build_embedder()
        issue = state["issue"]
        query_text = f"{issue.get('title', '')}\n{issue.get('body') or ''}"
        hits = memory_store.retrieve(
            state.get("owner", ""), state.get("repo", ""), embedder.embed_query(query_text), k=3,
            where={"kind": "issue"},
        )
        lines = []
        for hit in hits:
            meta = hit.get("metadata") or {}
            missing = [f for f in (meta.get("missing_fields") or "").split(",") if f]
            lines.append(
                f"- #{meta.get('number', '?')} ({meta.get('issue_type', '?')}) "
                f"{meta.get('title', '')[:80]!r} — was missing: {', '.join(missing) or 'nothing'}"
            )
        return "\n".join(lines)
    except Exception:
        return ""


def _history_context(state: AgentState) -> str:
    """Recent analyses of this repo from Postgres, as prompt context."""
    try:
        rows = postgres_store.recent_analyses(state.get("owner", ""), state.get("repo", ""), limit=5)
        lines = []
        for row in rows:
            details = row.get("missing_details") or []
            lines.append(
                f"- #{row.get('issue_number')} ({row.get('issue_type', '?')}) "
                f"{row.get('title', '')[:80]!r} — missing: {'; '.join(details) or 'nothing'} → {row.get('action', '')}"
            )
        return "\n".join(lines)
    except Exception:
        return ""


def _analyze_with_llm(state: AgentState, defaults: List[str]) -> Optional[Dict[str, Any]]:
    """LLM analysis grounded in the actual issue text, the repo template, and
    both memory stores. Returns None (→ deterministic fallback) on any failure
    or if the model output is not usable — never fabricates."""
    model_key = os.getenv("NVIDIA_API_KEY")
    if not model_key:
        return None
    try:
        issue = state["issue"]
        title = issue.get("title", "")
        body = issue.get("body") or ""
        text = f"# {title}\n\n{body}"[:12000]
        guidance = (state.get("guidance") or "")[:2000]
        client = ChatNVIDIA(
            model=os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b"),
            api_key=model_key,
            temperature=0,
            max_completion_tokens=512,
        ).with_structured_output(FieldAssessment)
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "You assess whether a GitHub issue contains enough actionable information "
                    "to triage it. Allowed field keys: " + ", ".join(ALLOWED_FIELD_KEYS) + ".\n"
                    "- required_fields: keys the report should contain for its type "
                    "(bug: os, version, reproduction_steps, expected_actual, plus logs/error_message if relevant; "
                    "feature: use_case, expected_behavior; question/other: context).\n"
                    "- present_fields: required keys that ARE actually covered by the original issue OR "
                    "a [REPORTER] comment. Treat a reporter's plain-language answer as valid even if it "
                    "does not use the requested heading.\n"
                    "- missing_details: short concrete phrases for what is genuinely absent after reading "
                    "the entire discussion. Never request a field already answered by a [REPORTER] comment. "
                    "[AUTOMATION] comments are previous questions, not evidence that a field is missing. "
                    "Return an empty missing_details list when the report is actionable.\n"
                    "Reply with JSON only.",
                ),
                (
                    "human",
                    "Repo issue template / CONTRIBUTING guidance (may be empty):\n{guidance}\n\n"
                    "Similar past issues in this repo (Chroma memory):\n{memory}\n\n"
                    "Recent analyses of this repo (Postgres history):\n{history}\n\n"
                    "Issue to assess:\n{issue_text}",
                ),
            ]
        )
        assessment = (prompt | client).invoke(
            {
                "guidance": guidance or "(no template found)",
                "memory": _memory_context(state) or "(none)",
                "history": _history_context(state) or "(none)",
                "issue_text": text,
            }
        )
        allowed = set(ALLOWED_FIELD_KEYS)
        required = [f for f in assessment.required_fields if f in allowed] or defaults
        present = [f for f in assessment.present_fields if f in allowed and f in required]
        details = list(dict.fromkeys(d.strip() for d in assessment.missing_details if d and d.strip()))
        missing_keys = set(required) - set(present)
        details = details[:len(missing_keys)]
        return {"required_fields": required, "present_fields": present, "missing_details": details}
    except Exception:
        return None


def find_required_fields(state: AgentState) -> AgentState:
    issue_type = state.get("issue_type", "other")
    defaults = list(REQUIRED_BY_TYPE.get(issue_type, ["context"]))
    body = (state["issue"].get("body") or "").lower()

    analysis = _analyze_with_llm(state, defaults)
    if analysis is None:
        # Deterministic fallback: template-aware defaults + section-header scan.
        required = defaults
        guidance = (state.get("guidance") or "").lower()
        patterns = GUIDANCE_PATTERNS.get(issue_type, {})
        if patterns and guidance:
            requested = [field for field in required if re.search(patterns[field], guidance)]
            if requested:
                required = requested
        present = [field for field in required if _field_is_present(field, body)]
        missing_details = [
            _detail_for(field) for field in required if field not in present
        ]
    else:
        required = analysis["required_fields"]
        present = analysis["present_fields"]
        missing_details = analysis["missing_details"]

    return {
        "required_fields": required,
        "present_fields": present,
        "missing_fields": [field for field in required if field not in present],
        "missing_details": missing_details,
    }


def _field_is_present(field: str, body: str) -> bool:
    """Recognize common natural-language answers when the LLM is unavailable."""
    if re.search(FIELD_MARKERS[field], body):
        return True
    patterns = {
        "os": r"\b(?:windows\s*\d*|mac(?:os)?|linux|ubuntu|debian|android|ios|iphone|ipad)\b",
        "version": r"\b(?:v?\d+\.\d+(?:\.\d+)?|version\s*[:#]?\s*\S+)\b",
        "reproduction_steps": r"\b(?:step\s*\d+|first,|then,|reproduce|reproduc|steps? to)\b",
        "expected_actual": r"\b(?:expected|expect|actual|instead|but got|should have)\b",
        "use_case": r"\b(?:use case|because|so that|would help|motivat)\b",
        "expected_behavior": r"\b(?:should|would like|desired|acceptance|expected behavior)\b",
        "context": r"\b(?:context|background|trying to|using this|environment)\b",
        "logs": r"```[\s\S]+```|\b(?:log|stack trace|traceback|console output)\b",
        "error_message": r"\b(?:error|exception|failure|failed)\b",
    }
    return bool(re.search(patterns.get(field, r"$^"), body, re.IGNORECASE))


def _detail_for(field: str) -> str:
    labels = {
        "os": "OS not mentioned",
        "version": "App/package version not mentioned",
        "reproduction_steps": "No reproduction steps",
        "expected_actual": "Expected vs actual behavior not described",
        "use_case": "Use case not described",
        "expected_behavior": "Expected behavior not described",
        "context": "No context given",
        "logs": "Logs not attached",
        "error_message": "Error message not included",
    }
    return labels.get(field, f"{field} not mentioned")


def _draft_comment(issue_type: str, missing: List[str]) -> str:
    questions = {
        "os": "What operating system and version are you using?",
        "version": "What app, package, or project version is affected?",
        "reproduction_steps": "What exact steps reproduce the problem?",
        "expected_actual": "What did you expect to happen, and what happened instead?",
        "use_case": "What use case or problem would this feature solve?",
        "expected_behavior": "What behavior or outcome should the feature provide?",
        "context": "What additional context would help us understand the situation?",
    }
    points = [f"{index}. {questions[field]}" for index, field in enumerate(missing, 1) if field in questions]
    if not points:
        return ""
    if issue_type == "bug":
        intro = "Thanks for the report. I can continue once you provide the following details:"
    elif issue_type == "feature":
        intro = "Thanks for the suggestion. To evaluate it, please provide the following details:"
    else:
        intro = "Thanks for the context. Please provide the following details so we can continue:"
    return intro + "\n\n" + "\n".join(points)


def _draft_with_llm(state: AgentState, missing_details: List[str]) -> Optional[str]:
    """Comment generated by the LLM, asking only for the items the analysis
    found genuinely missing from this issue. None → deterministic fallback."""
    model_key = os.getenv("NVIDIA_API_KEY")
    if not model_key or not missing_details:
        return None
    try:
        issue = state["issue"]
        client = ChatNVIDIA(
            model=os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b"),
            api_key=model_key,
            temperature=0.3,
            max_completion_tokens=600,
        )
        prompt = ChatPromptTemplate.from_messages(
            [
                (
                    "system",
                    "Write one helpful GitHub comment for the reporter. Ask only for the missing "
                    "items listed below. Read the full discussion first: do not repeat a question "
                    "if the reporter already answered it. Briefly acknowledge useful information "
                    "they provided, then ask the remaining questions in plain language. "
                    "Use a short numbered list when there is more than one item. Do not mention "
                    "the model, analysis, internal fields, or automation. Do not ask for logs, "
                    "versions, or other details unless they appear in the missing list. "
                    "Return only the comment text, with no quotation marks or heading.",
                ),
                (
                    "human",
                    "Issue title: {title}\n\nFull issue and discussion:\n{body}\n\n"
                    "Confirmed missing items (the only things you may ask for):\n{missing}",
                ),
            ]
        )
        reply = (prompt | client).invoke(
            {
                "title": issue.get("title", ""),
                "body": (issue.get("body") or "")[:12000],
                "missing": "\n".join(f"- {d}" for d in dict.fromkeys(missing_details)),
            }
        )
        content = reply.content or ""
        if isinstance(content, list):
            content = "".join(
                item.get("text", "") if isinstance(item, dict) else str(item)
                for item in content
            )
        text = str(content).strip().strip('"')
        complete = bool(re.search(r"[.!?)]$", text))
        return text if 20 <= len(text) <= 2000 and complete else None
    except Exception:
        return None


def draft_follow_up(state: AgentState) -> AgentState:
    issue_type = state.get("issue_type", "other")
    missing = state.get("missing_fields", [])
    missing_details = state.get("missing_details", [])
    _remember(state)

    if not missing:
        postgres_store.record_analysis(
            state.get("owner", ""), state.get("repo", ""),
            {
                "issue_number": (state.get("issue") or {}).get("number", 0),
                "issue_type": issue_type,
                "title": (state.get("issue") or {}).get("title", ""),
                "required_fields": state.get("required_fields", []),
                "present_fields": state.get("present_fields", []),
                "missing_fields": [],
                "missing_details": [],
                "draft_comment": "",
                "action": "pass-through",
            },
        )
        return {"action": "pass-through", "draft_comment": ""}

    comment = _draft_with_llm(state, missing_details) or _draft_comment(issue_type, missing)
    postgres_store.record_analysis(
        state.get("owner", ""), state.get("repo", ""),
        {
            "issue_number": (state.get("issue") or {}).get("number", 0),
            "issue_type": issue_type,
            "title": (state.get("issue") or {}).get("title", ""),
            "required_fields": state.get("required_fields", []),
            "present_fields": state.get("present_fields", []),
            "missing_fields": missing,
            "missing_details": missing_details,
            "draft_comment": comment,
            "action": "needs-info",
        },
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
        "issue_type", "required_fields", "present_fields", "missing_fields",
        "missing_details", "action", "draft_comment"
    )}, indent=2))


if __name__ == "__main__":
    main()