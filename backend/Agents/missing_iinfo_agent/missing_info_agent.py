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

# Headings that count as evidence a field is covered. Headings are normalized
# (lowercased, markdown stripped) and matched by word, so standard GitHub
# templates ("### To Reproduce", "**OS:** Windows 10", "### Desktop (please
# complete...)") are recognized even when they do not follow a strict schema.
SECTION_SYNONYMS = {
    "os": ["operating system", "os", "platform", "environment", "desktop", "system information", "system info", "device", "machine"],
    "version": ["version", "release", "software version", "package version", "app version"],
    "reproduction_steps": ["to reproduce", "reproduce", "reproduction steps", "steps to reproduce", "how to reproduce", "reproduction", "steps"],
    "expected_actual": ["what happened", "what should happen", "expected behavior", "expected behaviour", "actual behavior", "actual behaviour", "expected vs actual", "expected and actual", "expected outcome", "expected result", "actual result", "actual"],
    "use_case": ["use case", "use-case", "motivation", "problem", "why"],
    "expected_behavior": ["expected behavior", "expected behaviour", "desired behavior", "desired behaviour", "acceptance criteria"],
    "context": ["context", "additional context", "extra context", "details", "notes", "anything else"],
    "logs": ["logs", "log", "console output", "error logs", "terminal output"],
    "error_message": ["error message", "error", "exception", "stack trace", "traceback"],
}

# Template placeholder text that means "not filled in yet": GitHub's
# "[e.g. iOS]" hints, HTML comments, "(please complete ...)" instructions,
# empty checkboxes and "No response".
PLACEHOLDER_PATTERNS = [
    r"<!--.*?-->",
    r"\[e\.g\.[^\]]*\]",
    r"\[[^\]]*\.\.\.[^\]]*\]",
    r"\((?i:please\s+)?(?i:complete|fill)[^)]*\)",
    r"\[\s*\]",
    r"(?i)\bno response\b",
]

# Full-line template instructions that must not count as issue content.
INSTRUCTION_PATTERNS = [
    r"(?i)^\s*a clear and concise description of\s*.*\.?\s*$",
    r"(?i)^\s*steps to reproduce the behavior\s*:?\s*$",
    r"(?i)^\s*what did you expect to happen\?\s*$",
    r"(?i)^\s*what actually happened\?\s*$",
    r"(?i)^\s*add any other context about the problem here\.?\s*$",
    r"(?i)^\s*(?:please\s+)?(?:complete|fill(?: out)?)\s+(?:the\s+)?(?:following|this)\s+(?:information|section|template)\s*:?\s*$",
    r"(?i)^\s*(?:describe|screenshots?|additional\s+context)\s*$",
]

# Real environment tokens that prove the OS field was answered.
OS_TOKENS = ["windows 11", "windows 10", "windows", "macos", "os x", "linux", "ubuntu", "debian", "fedora", "arch", "android", "ios", "chrome os", "chrome", "firefox", "safari"]

# Words that carry no information when judging whether a section is filled.
FILLER_WORDS = frozenset("""the a an and or of to in for on with at by from it its is are was were be been being have has had do does did will would can could should may might this that these those there here what when where which who whom how why i you we they he she me my your our their us them please add any other context about problem issue bug feature expected actual behavior behaviour happen happened happening steps step reproduce reproduction reproducing repro description describe below above following information complete fill example e.g eg info none n/a na no yes not nothing work working works want like need thanks thank""".split())


def _normalize_heading(line: str) -> str:
    text = re.sub(r"[#*`_>~]+", " ", line)
    text = re.sub(r"\s+", " ", text).strip().rstrip(":").strip()
    return text.lower()


def _heading_of(line: str) -> Optional[str]:
    """Return a normalized heading for markdown headings, bold headings and
    bare labels ("OS:"), or None for content lines."""
    stripped = re.sub(r"^[-*]\s+", "", line.strip())
    m = re.match(r"^#{1,6}\s+(.+?)\s*$", stripped)
    if m:
        return _normalize_heading(m.group(1))
    m = re.match(r"^\*\*(.+?)\*\*\s*:?\s*$", stripped)
    if m:
        return _normalize_heading(m.group(1))
    m = re.match(r"^__(.+?)__\s*:?\s*$", stripped)
    if m:
        return _normalize_heading(m.group(1))
    m = re.match(r"^([A-Za-z][A-Za-z0-9 _/&()'-]{0,60}):\s*$", stripped)
    if m:
        return _normalize_heading(m.group(1))
    return None


def _heading_matches(normalized: str, synonyms) -> bool:
    cleaned = re.sub(r"\s*\([^)]*\)\s*$", "", normalized).strip()
    return any(re.search(rf"\b{re.escape(syn)}\b", cleaned) for syn in synonyms)


def _scan_sections(body: str) -> Dict[str, List[str]]:
    """Split the body into (heading, content) sections and map every heading to
    each field it provides evidence for. Supports "### Heading", "**Heading**"
    and inline "**Label:** content" lines."""
    sections: List[tuple] = []
    current_heading, current_lines = None, []
    for line in (body or "").splitlines():
        inline = re.match(r"^\*\*(.+?)\*\*:?\s+(.+)$", line.strip())
        if inline:
            if current_heading is not None or current_lines:
                sections.append((current_heading, current_lines))
            current_heading, current_lines = _normalize_heading(inline.group(1)), [inline.group(2)]
            continue
        heading = _heading_of(line)
        if heading is not None:
            if current_heading is not None or current_lines:
                sections.append((current_heading, current_lines))
            current_heading, current_lines = heading, []
        else:
            current_lines.append(line)
    if current_heading is not None or current_lines:
        sections.append((current_heading, current_lines))
    covered: Dict[str, List[str]] = {}
    for heading, lines in sections:
        if not heading:
            continue
        for field, synonyms in SECTION_SYNONYMS.items():
            if _heading_matches(heading, synonyms):
                covered.setdefault(field, []).append("\n".join(lines))
    return covered


def _clean_content(text: str) -> str:
    cleaned = text or ""
    for pattern in PLACEHOLDER_PATTERNS:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.S)
    return cleaned


def _meaningful_words(text: str) -> List[str]:
    cleaned = _clean_content(text)
    for pattern in INSTRUCTION_PATTERNS:
        cleaned = re.sub(pattern, " ", cleaned, flags=re.M)
    return [
        word for word in re.findall(r"[A-Za-z0-9][A-Za-z0-9._/#+@-]*", cleaned)
        if word.lower() not in FILLER_WORDS and not word.isdigit()
    ]


def _has_os_token(text: str) -> bool:
    low = (text or "").lower()
    return any(token in low for token in OS_TOKENS)

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


# Loose patterns that treat a reporter's reply comment as covering a field.
# Comments usually answer in plain prose without template headings, so the
# strict section scanner cannot credit them on their own.
_OS_RE = re.compile(
    r"\b(?:windows(?:\s*\d+)?|mac(?:os)?|os\s*x|linux|ubuntu|debian|fedora|arch|manjaro|"
    r"pop[_-]?os|mint|centos|rhel|alpine|gentoo|android|ios|iphone|ipad|chrome(?:os)?|"
    r"firefox|safari|edge)\b",
    re.IGNORECASE,
)

COMMENT_COVERAGE = {
    "os": _OS_RE.pattern,
    "version": r"\bv?\d+\.\d+(?:\.\d+)?\b",
    "reproduction_steps": r"(?i)(?:steps?\s*[:=]|\bto reproduce\b|\breproduce[d]?\b|\brepro\b|^\s*\d+[.)])",
    "expected_actual": r"(?i)\b(?:expected|actual(?:ly)?|instead|but got|should have)\b",
    "use_case": r"(?i)\b(?:use case|because|so that|would help|motivat)\b",
    "expected_behavior": r"(?i)\b(?:expected behavior|desired|acceptance|would like|should be able to)\b",
    "context": r"(?i)\b(?:context|background|trying to|environment|additionally)\b",
    "logs": r"(?i)\b(?:log(?:s| output)?|console output|traceback|stack trace)\b|```",
    "error_message": r"(?i)\b(?:error|exception|failed|failure)\b",
}

# Phrase a follow-up question for a field is expected to contain, used to
# recognize fields already requested in an earlier comment.
ASKED_PHRASES = {
    "os": "operating system",
    "version": "version",
    "reproduction_steps": "steps",
    "expected_actual": "expect",
    "use_case": "use case",
    "expected_behavior": "behavior",
    "context": "context",
    "logs": "log",
    "error_message": "error",
}

_QUESTION_MARKERS = (
    "?",
    "please provide",
    "could you",
    "can you",
    "please share",
    "please add",
    "please include",
    "kindly provide",
)


def _is_question_comment(text: str) -> bool:
    """A comment that asks for something (a question or info request) rather
    than providing information — typically RepoGuardian's own follow-up."""
    low = (text or "").lower()
    return any(marker in low for marker in _QUESTION_MARKERS)


def _comment_covers_field(field: str, comments: List[Dict[str, Any]]) -> bool:
    """Can a reply comment reasonably count as answering this field? Question
    comments (including our own previous follow-ups) never count as evidence."""
    pattern = COMMENT_COVERAGE.get(field)
    if not pattern:
        return False
    for comment in comments:
        text = comment.get("body") or ""
        if not text or _is_question_comment(text):
            continue
        if re.search(pattern, text, re.MULTILINE | re.IGNORECASE):
            return True
    return False


def _bot_already_asked(field: str, comments: List[Dict[str, Any]]) -> bool:
    """Did an earlier comment already request this field? If so, do not ask
    again — the reporter has already been given the chance to provide it."""
    phrase = ASKED_PHRASES.get(field)
    if not phrase:
        return False
    for comment in comments:
        text = comment.get("body") or ""
        if not text:
            continue
        low = text.lower()
        if _is_question_comment(low) and phrase in low:
            return True
    return False


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
        issue = {
            **issue,
            "body": f"{issue.get('body') or ''}\n\nGitHub discussion:\n{discussion}",
            "comments": comments,
        }

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
    body = state["issue"].get("body") or ""
    comments = state["issue"].get("comments") or []

    # Deterministic template scan first: standard GitHub template sections and
    # natural-language reports, with placeholder text ignored. A reporter's
    # plain-prose answer in a comment also counts as covering a field.
    required = defaults
    guidance = (state.get("guidance") or "").lower()
    patterns = GUIDANCE_PATTERNS.get(issue_type, {})
    if patterns and guidance:
        requested = [field for field in required if re.search(patterns[field], guidance)]
        if requested:
            required = requested
    detected = [
        field for field in required
        if _field_is_present(field, body) or _comment_covers_field(field, comments)
    ]

    analysis = _analyze_with_llm(state, defaults)
    if analysis is not None:
        allowed = set(ALLOWED_FIELD_KEYS)
        required = list(dict.fromkeys(defaults + [f for f in analysis["required_fields"] if f in allowed]))
        present = list(dict.fromkeys(
            [f for f in analysis["present_fields"] if f in allowed and f in required]
            + [f for f in detected if f in required]
        ))
        llm_details = analysis["missing_details"]
    else:
        present = detected
        llm_details = []

    missing_fields = [field for field in required if field not in present]
    missing_details = llm_details or [_detail_for(field) for field in missing_fields]
    return {
        "required_fields": required,
        "present_fields": present,
        "missing_fields": missing_fields,
        "missing_details": missing_details,
    }


def _field_is_present(field: str, body: str) -> bool:
    """Template-aware check: does the issue text actually contain this field?

    Recognizes standard GitHub issue templates ("### To Reproduce", "**OS:**",
    "### Desktop (please complete the following information):") and plain
    natural-language reports, while ignoring template placeholders such as
    "[e.g. iOS]" and "No response".
    """
    body = body or ""
    contents = _scan_sections(body).get(field, [])
    if field == "os":
        return _has_os_token(_clean_content(body)) or any(
            _has_os_token(_clean_content(content)) for content in contents
        )
    if field == "version":
        return bool(re.search(r"\bv?\d+\.\d+(?:\.\d+)*\b", _clean_content(body))) or any(
            bool(re.search(r"\bv?\d+\.\d+(?:\.\d+)*\b", _clean_content(content)))
            for content in contents
        )
    return any(len(_meaningful_words(content)) >= 1 for content in contents)


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


# Two phrasings per field: the first is used on the initial ask, the second on
# follow-ups so the reporter is never re-sent the identical question.
_QUESTION_BANK = {
    "os": (
        "What operating system and version are you using?",
        "Which operating system are you on?",
    ),
    "version": (
        "What app, package, or project version is affected?",
        "Which version of the app or package is affected?",
    ),
    "reproduction_steps": (
        "What exact steps reproduce the problem?",
        "Could you walk me through the exact steps that trigger it?",
    ),
    "expected_actual": (
        "What did you expect to happen, and what happened instead?",
        "What did you expect to see, and what actually happened?",
    ),
    "use_case": (
        "What use case or problem would this feature solve?",
        "What problem are you trying to solve with this feature?",
    ),
    "expected_behavior": (
        "What behavior or outcome should the feature provide?",
        "What should the feature do once it's implemented?",
    ),
    "context": (
        "What additional context would help us understand the situation?",
        "Is there any extra context (environment, logs, screenshots) that would help?",
    ),
    "logs": (
        "Can you share the relevant logs or console output?",
        "Could you attach the error logs or stack trace?",
    ),
    "error_message": (
        "Can you include the exact error message?",
        "What does the error message say exactly?",
    ),
}


def _provided_evidence(state: AgentState) -> Dict[str, str]:
    """What the reporter has actually told us in their reply comments, used to
    acknowledge their answers instead of re-asking. Question comments (our own
    previous follow-ups) never count."""
    comments = (state.get("issue") or {}).get("comments") or []
    text = " ".join(
        comment.get("body") or "" for comment in comments
        if not _is_question_comment(comment.get("body") or "")
    )
    evidence: Dict[str, str] = {}
    os_match = _OS_RE.search(text)
    if os_match:
        evidence["os"] = os_match.group(0).strip().title()
    version_match = re.search(r"\bv?\d+\.\d+(?:\.\d+)?\b", text)
    if version_match:
        evidence["version"] = version_match.group(0).lstrip("v")
    for field in ("reproduction_steps", "expected_actual", "use_case",
                  "expected_behavior", "logs", "error_message", "context"):
        if re.search(COMMENT_COVERAGE[field], text, re.MULTILINE | re.IGNORECASE):
            evidence[field] = field
    return evidence


def _draft_comment(state: AgentState, missing: List[str]) -> str:
    """Context-aware follow-up comment: acknowledges what the reporter already
    provided and asks only for what is still genuinely missing, varying the
    phrasing on follow-ups instead of re-sending the same canned questions."""
    issue_type = state.get("issue_type", "other")
    comments = (state.get("issue") or {}).get("comments") or []
    follow_up = bool(comments)
    evidence = _provided_evidence(state)

    ack = []
    if evidence.get("os") and evidence.get("version"):
        ack.append(f"you're on {evidence['os']} with version {evidence['version']}")
    elif evidence.get("os"):
        ack.append(f"you're on {evidence['os']}")
    elif evidence.get("version"):
        ack.append(f"version {evidence['version']}")
    if "reproduction_steps" in evidence:
        ack.append("the reproduction steps")
    if "expected_actual" in evidence:
        ack.append("what you expected vs. what happened")
    if "use_case" in evidence:
        ack.append("the use case")
    if "expected_behavior" in evidence:
        ack.append("the expected behavior")
    if "logs" in evidence:
        ack.append("the logs")
    if "error_message" in evidence:
        ack.append("the error message")
    if "context" in evidence:
        ack.append("additional context")

    variant = 1 if follow_up else 0
    points = []
    for index, field in enumerate(missing, 1):
        bank = _QUESTION_BANK.get(field)
        if bank:
            points.append(f"{index}. {bank[min(variant, len(bank) - 1)]}")
        else:
            points.append(f"{index}. {field.replace('_', ' ')} not mentioned")

    if follow_up:
        if ack:
            intro = (
                "Thanks — that helps. I can see " + ", ".join(ack)
                + ". To continue, could you also provide the following?"
            )
        else:
            intro = "Thanks for the follow-up. To continue, could you provide the following?"
    elif issue_type == "bug":
        intro = "Thanks for the report. I can continue once you provide the following details:"
    elif issue_type == "feature":
        intro = "Thanks for the suggestion. To evaluate it, please provide the following details:"
    else:
        intro = "Thanks for the context. Please provide the following details so we can continue:"
    return intro + "\n\n" + "\n".join(points)


def _question_only(text: str) -> Optional[str]:
    """Remove model reasoning and retain only the reporter-facing request."""
    cleaned = re.sub(r"<think>.*?</think>|<analysis>.*?</analysis>", "", text or "", flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"```(?:text|markdown)?\s*|```", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"(?is)\b(?:analysis|reasoning|chain of thought|thoughts?)\s*:\s*.*?(?=\b(?:final answer|comment|question)\s*:|$)", "", cleaned)
    cleaned = re.sub(r"(?i)^\s*(?:final answer|comment|answer)\s*:\s*", "", cleaned.strip())
    lines = []
    for line in cleaned.splitlines():
        line = line.strip()
        if not line or re.match(r"(?i)^(?:analysis|reasoning|thoughts?|draft)\s*[:\-]", line):
            continue
        if re.match(r"(?i)^(?:sure|certainly|here(?:'s| is)|i(?:'ll| will)|as an ai)\b", line):
            continue
        lines.append(line)
    cleaned = "\n".join(lines).strip().strip('"')
    if not cleaned or not re.search(r"[?]|\b(?:please|could you|can you|what|which|where|when|how|why)\b", cleaned, re.IGNORECASE):
        return None
    return cleaned


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
                    "Never show your reasoning, analysis, chain of thought, draft, or decision. "
                    "Return only the final reporter-facing questions, with no heading or explanation.",
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
        text = _question_only(str(content))
        complete = bool(text and re.search(r"[.!?)]$", text))
        return text if text and 20 <= len(text) <= 2000 and complete else None
    except Exception:
        return None


def draft_follow_up(state: AgentState) -> AgentState:
    issue_type = state.get("issue_type", "other")
    missing = state.get("missing_fields", [])
    missing_details = state.get("missing_details", [])
    comments = (state.get("issue") or {}).get("comments") or []
    _remember(state)

    def _record(action: str, fields: List[str], details: List[str], comment: str) -> AgentState:
        postgres_store.record_analysis(
            state.get("owner", ""), state.get("repo", ""),
            {
                "issue_number": (state.get("issue") or {}).get("number", 0),
                "issue_type": issue_type,
                "title": (state.get("issue") or {}).get("title", ""),
                "required_fields": state.get("required_fields", []),
                "present_fields": state.get("present_fields", []),
                "missing_fields": fields,
                "missing_details": details,
                "draft_comment": comment,
                "action": action,
            },
        )
        return {"action": action, "draft_comment": comment}

    if not missing:
        return _record("pass-through", [], [], "")

    already_asked = [field for field in missing if _bot_already_asked(field, comments)]
    to_ask = [field for field in missing if field not in already_asked]
    if not to_ask:
        # Everything still missing was already requested in an earlier comment —
        # do not nag the reporter again.
        return _record("waiting", missing, missing_details, "")

    details_to_ask = [
        missing_details[index] if index < len(missing_details) else _detail_for(field)
        for index, field in enumerate(missing)
        if field in to_ask
    ]
    comment = _draft_with_llm(state, details_to_ask) or _draft_comment(state, to_ask)
    return _record("needs-info", to_ask, details_to_ask, comment)


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