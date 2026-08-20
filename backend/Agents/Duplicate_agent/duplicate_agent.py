"""
Duplicate Check Agent — RepoGuardian

Agentic AI (LangGraph) that decides whether a newly opened GitHub issue is a
duplicate of an already-reported bug. Reads the repository's real issue history
and live activity from GitHub, uses semantic vector search over titles, bodies,
logs and stack traces, fetches full threads of the top candidates, compares
symptoms/error strings/OS/versions, checks closure context, and produces the
platform output contract:

  - duplicate confidence score (0..1)
  - links to the 1-3 most likely matches
  - suggested action with evidence, not vibes

Runtime modes:
  - NVIDIA mode:  ChatNVIDIA (nemotron) + NVIDIAEmbeddings, API key from .env
  - Offline mode: falls back to a deterministic local embedder + heuristic
    comparator so the pipeline can be run and tested without an API key.

Configuration (in .env):
  NVIDIA_API_KEY=...
  GITHUB_TOKEN=...          # fine-grained PAT with Issues read scope
  GITHUB_OWNER=<owner>      # e.g. facebook
  GITHUB_REPO=<repo>        # e.g. react

Usage:
  python duplicate_agent.py --owner <owner> --repo <repo> --issue-number <n>
  python duplicate_agent.py --issue-json issue_payload.json     # webhook payload
"""

import argparse
import json
import math
import os
import re
import sys
from collections import Counter
from typing import Any, Dict, List, Optional, TypedDict
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA, NVIDIAEmbeddings
from langgraph.graph import END, START, StateGraph

COMMON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common")
if COMMON_DIR not in sys.path:
    sys.path.insert(0, COMMON_DIR)
import memory_store  # noqa: E402  (shared persistent Chroma memory)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))   # shared backend credentials
load_dotenv(os.path.join(BASE_DIR, ".env"))      # optional local overrides

NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_LLM_MODEL = os.getenv("NVIDIA_LLM_MODEL", "nvidia/nemotron-3-nano-30b-a3b")
NVIDIA_EMBED_MODEL = os.getenv("NVIDIA_EMBED_MODEL", "nvidia/nv-embedqa-e5-v5")

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_OWNER = os.getenv("GITHUB_OWNER", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "")

OS_NAMES = ["Windows 11", "Windows 10", "Windows", "macOS", "Linux", "Ubuntu", "iOS", "Android", "Chrome", "Firefox"]


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class AgentState(TypedDict):
    issue: Dict[str, Any]              # incoming issue
    repository: Dict[str, Any]         # owner/repo + release context
    searchable_text: str               # normalized title + body
    signals: Dict[str, Any]            # extracted error strings, stack frames, OS, versions
    candidates: List[Dict[str, Any]]   # [{issue, similarity_score}]
    threads: List[Dict[str, Any]]      # full fetched threads for top candidates
    matches: List[Dict[str, Any]]      # finalized top matches
    result: Dict[str, Any]             # output contract
    status: str                        # complete | insufficient_evidence | needs_human_review
    error: Optional[str]
    llm: Optional[Any]                 # injected by build_graph
    embedder: Any                      # injected by build_graph
    store: Any                         # injected by build_graph


# ---------------------------------------------------------------------------
# NLP helpers
# ---------------------------------------------------------------------------

def extract_signals(text: str) -> Dict[str, Any]:
    """Pull the signals a maintainer actually compares: error strings, stack
    frames, OS, versions, and reproduction keywords."""
    text = text or ""
    errors = [e.strip("'\"").strip() for e in re.findall(r"['\"]([^'\"]{10,200})['\"]", text)]
    errors = list(dict.fromkeys(e for e in errors if e.lower() not in ("description", "error message")))
    stack_frames = re.findall(r"(?:^\s*at\s+|at\s+)([\w.<>/\\:-]+\(\w.*\)|[\w.<>/\\:]+:\d+)", text, re.M)
    versions = re.findall(r"\bv?(\d+\.\d+(?:\.\d+)?)\b", text)
    os_found = [o for o in OS_NAMES if o.lower() in text.lower()]
    return {
        "error_strings": list(dict.fromkeys(errors)),
        "stack_frames": list(dict.fromkeys(stack_frames)),
        "versions": list(dict.fromkeys(versions)),
        "os": os_found,
        "text_lower": text.lower(),
    }


def build_searchable_text(issue: Dict[str, Any]) -> str:
    parts = [issue.get("title", ""), issue.get("body", "")]
    for comment in issue.get("comments", []) or []:
        parts.append(comment if isinstance(comment, str) else comment.get("body", ""))
    return "\n".join(filter(None, parts))


def likely_reporter_version(signals: Dict[str, Any], text: str) -> Optional[str]:
    """Infer the reporter's installed version only when the text supports it.
    Prefers the version mentioned in an upgrade path (e.g. 'upgrading to v3.1')."""
    low = (text or "").lower()
    upgrade_matches = re.findall(r"(?:upgrad(?:e|ing)|updated?|after)\s+(?:to\s+)?v?(\d+\.\d+(?:\.\d+)?)", low)
    candidates = upgrade_matches or signals.get("versions", [])
    if not candidates:
        return None
    return min(candidates, key=lambda v: tuple(int(p) for p in v.split(".")))


# ---------------------------------------------------------------------------
# Embeddings & vector store
# ---------------------------------------------------------------------------

def _sparse_vector(text: str) -> Dict[str, float]:
    tokens = re.findall(r"[a-z0-9_#.+-]+", text.lower())
    counts = Counter(tokens)
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
    return {tok: v / norm for tok, v in counts.items()}


def _cosine(a: Any, b: Any) -> float:
    if isinstance(a, dict) and isinstance(b, dict):  # sparse local vectors
        inter = set(a) & set(b)
        if not inter:
            return 0.0
        return sum(a[t] * b[t] for t in inter)
    # dense NVIDIA vectors
    try:
        import numpy as np
        a = np.asarray(a, dtype=float)
        b = np.asarray(b, dtype=float)
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        if na == 0 or nb == 0:
            return 0.0
        return float(np.dot(a, b) / (na * nb))
    except Exception:
        return 0.0


class LocalEmbeddings:
    """Deterministic offline embedder (bag-of-tokens) used when no NVIDIA key
    is configured. Enough to demo the full agent pipeline."""

    def embed_documents(self, texts: List[str]) -> List[Dict[str, float]]:
        return [_sparse_vector(t) for t in texts]

    def embed_query(self, text: str) -> Dict[str, float]:
        return _sparse_vector(text)


class VectorStore:
    def __init__(self) -> None:
        self.docs: List[Dict[str, Any]] = []
        self.vectors: List[Any] = []

    def add(self, doc: Dict[str, Any], vector: Any) -> None:
        self.docs.append(doc)
        self.vectors.append(vector)

    def search(self, vector: Any, k: int = 10) -> List[Dict[str, Any]]:
        scored = sorted(
            ((_cosine(vector, v), doc) for doc, v in zip(self.docs, self.vectors)),
            key=lambda t: t[0],
            reverse=True,
        )
        return [{"issue": doc, "similarity_score": round(float(s), 4)} for s, doc in scored[:k]]


# ---------------------------------------------------------------------------
# GitHub adapter — reads the repository's real history and live activity
# ---------------------------------------------------------------------------

_API = "https://api.github.com"
_HEADERS = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}


def _gh_get(url: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    """Paginate through a GitHub API endpoint. Raises on auth/rate errors so the
    agent fails loudly instead of silently searching an empty corpus."""
    items: List[Dict[str, Any]] = []
    while url:
        request_url = f"{url}?{urlencode(params)}" if params else url
        request = Request(request_url, headers=_HEADERS)
        try:
            with urlopen(request, timeout=30) as response:
                page = json.loads(response.read().decode("utf-8"))
                link_header = response.headers.get("Link", "")
        except HTTPError as error:
            raise RuntimeError(f"GitHub API request failed ({error.code}): {error.read().decode('utf-8', errors='replace')}") from error

        items.extend(page)
        params = None
        next_match = re.search(r'<([^>]+)>;\s*rel="next"', link_header)
        url = next_match.group(1) if next_match else ""
    return items


def fetch_corpus(owner: str, repo: str, limit: int = 200) -> List[Dict[str, Any]]:
    """Fetch open and closed issues (plus PRs are excluded by issues?state=all
    filter below) so the vector store covers the whole history, not just open."""
    url = f"{_API}/repos/{owner}/{repo}/issues"
    raw = _gh_get(url, params={"state": "all", "per_page": 100, "sort": "updated", "direction": "desc"})
    issues = [i for i in raw if "pull_request" not in i]  # exclude PRs, keep real issues
    for issue in issues[:limit]:
        comments = _gh_get(issue["comments_url"])
        issue["comments"] = [{"body": c["body"], "user": c["user"]["login"]} for c in comments]
    return issues[:limit]


def fetch_issue(owner: str, repo: str, number: int) -> Dict[str, Any]:
    request = Request(f"{_API}/repos/{owner}/{repo}/issues/{number}", headers=_HEADERS)
    try:
        with urlopen(request, timeout=30) as response:
            issue = json.loads(response.read().decode("utf-8"))
    except HTTPError as error:
        raise RuntimeError(f"GitHub API request failed ({error.code}): {error.read().decode('utf-8', errors='replace')}") from error
    issue["comments"] = [{"body": c["body"], "user": c["user"]["login"]} for c in _gh_get(issue["comments_url"])]
    return issue


def github_issue_to_model(issue: Dict[str, Any]) -> Dict[str, Any]:
    """Map a GitHub API issue object to the agent's issue shape."""
    return {
        "number": issue["number"],
        "url": issue["html_url"],
        "title": issue["title"],
        "body": issue.get("body") or "",
        "state": issue.get("state"),
        "closure_reason": issue.get("state_reason"),
        "labels": [label["name"] for label in issue.get("labels", [])],
        "comments": issue.get("comments", []),
        "created_at": issue.get("created_at"),
        "closed_at": issue.get("closed_at"),
    }


def full_thread_text(issue: Dict[str, Any]) -> str:
    parts = [issue.get("title", ""), issue.get("body", "")]
    for comment in issue.get("comments", []) or []:
        if isinstance(comment, str):
            parts.append(comment)
        else:
            parts.append(comment.get("body", ""))
    return "\n".join(filter(None, parts))


def build_index(corpus: List[Dict[str, Any]], embedder: Any) -> VectorStore:
    store = VectorStore()
    texts = [build_searchable_text(i) for i in corpus]
    vectors = embedder.embed_documents(texts)
    for issue, vec in zip(corpus, vectors):
        store.add(issue, vec)
    return store


# ---------------------------------------------------------------------------
# Runtime clients (NVIDIA or offline fallback)
# ---------------------------------------------------------------------------

def _has_key() -> bool:
    return bool(NVIDIA_API_KEY) and "your_" not in NVIDIA_API_KEY and "xxx" not in NVIDIA_API_KEY


def build_llm() -> Optional[ChatNVIDIA]:
    if not _has_key():
        return None
    return ChatNVIDIA(
        model=NVIDIA_LLM_MODEL,
        api_key=NVIDIA_API_KEY,
        temperature=0.1,
        top_p=1,
        max_completion_tokens=4096,
    )


def build_embedder() -> Any:
    if _has_key():
        return NVIDIAEmbeddings(
            model=NVIDIA_EMBED_MODEL,
            api_key=NVIDIA_API_KEY,
            truncate="END",
        )
    return LocalEmbeddings()


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------

def node_normalize(state: AgentState) -> AgentState:
    issue = state["issue"]
    text = build_searchable_text(issue)
    if not issue.get("title") and not issue.get("body"):
        return {**state, "status": "insufficient_evidence"}
    return {
        **state,
        "searchable_text": text,
        "signals": extract_signals(text),
        "status": "complete",
    }


def node_embed_and_search(state: AgentState) -> AgentState:
    embedder = state["embedder"]
    store = state["store"]
    query_vec = embedder.embed_query(state["searchable_text"])
    incoming_number = state["issue"].get("number")
    candidates = [
        c for c in store.search(query_vec, k=10) if c["issue"].get("number") != incoming_number
    ]

    # Merge with the persistent project memory: similar PAST issues (with their
    # state/closure context) seen by earlier runs of this agent.
    owner, repo = state["repository"].get("owner", ""), state["repository"].get("repo", "")
    if owner and repo:
        mem_hits = memory_store.retrieve(owner, repo, query_vec, k=8, where={"kind": "issue"})
        seen = {c["issue"].get("number") for c in candidates}
        for hit in mem_hits:
            meta = hit["metadata"]
            number = meta.get("number")
            if not number or number == incoming_number or number in seen:
                continue
            seen.add(number)
            candidates.append(
                {
                    "issue": {
                        "number": number,
                        "url": meta.get("url", ""),
                        "title": meta.get("title", ""),
                        "body": "",
                        "state": meta.get("state", ""),
                        "closure_reason": meta.get("closure_reason", ""),
                        "fixed_in_version": meta.get("fixed_in_version", ""),
                        "comments": [{"body": hit["text"]}],
                        "memory": True,
                    },
                    "similarity_score": hit["score"],
                }
            )
    candidates.sort(key=lambda c: c["similarity_score"], reverse=True)
    return {**state, "candidates": candidates[:12]}


def node_fetch_threads(state: AgentState) -> AgentState:
    threads = []
    for cand in state["candidates"][:5]:
        issue = cand["issue"]
        threads.append(
            {
                "issue": issue,
                "thread_text": full_thread_text(issue),
                "signals": extract_signals(full_thread_text(issue)),
                "similarity_score": cand["similarity_score"],
            }
        )
    return {**state, "threads": threads}


def _compare_heuristic(issue_signals: Dict[str, Any], cand: Dict[str, Any]) -> Dict[str, Any]:
    """Offline comparator: counts overlapping technical signals. A direct
    duplicate needs at least two independent matches including one technical."""
    s1, s2 = issue_signals, cand["signals"]
    shared_errors = set(s1["error_strings"]) & set(s2["error_strings"])
    shared_frames = set(s1["stack_frames"]) & set(s2["stack_frames"])
    shared_os = set(s1["os"]) & set(s2["os"])
    shared_versions = set(s1["versions"]) & set(s2["versions"])

    evidence = []
    if shared_errors:
        evidence.append(f"same error string: {', '.join(sorted(shared_errors))}")
    if shared_frames:
        evidence.append(f"same stack frame(s): {', '.join(sorted(shared_frames))}")
    if shared_os:
        evidence.append(f"same environment: {', '.join(sorted(shared_os))}")
    if shared_versions:
        evidence.append(f"same version range: {', '.join(sorted(shared_versions))}")
    if s1["os"] and s2["os"] and not shared_os:
        evidence.append(f"different OS ({'/'.join(s1['os'])} vs {'/'.join(s2['os'])})")

    technical = bool(shared_errors or shared_frames or (shared_os and shared_versions))
    strength = len(shared_errors) + len(shared_frames) + (1 if shared_os else 0) + (1 if shared_versions else 0)
    if strength >= 2 and technical:
        classification = "direct_duplicate"
    elif strength >= 1 or shared_versions:
        classification = "related"
    else:
        classification = "not_duplicate"
    return {"evidence": evidence, "classification": classification, "match_strength": strength}


def node_compare_evidence(state: AgentState) -> AgentState:
    llm = state["llm"]
    matches: List[Dict[str, Any]] = []
    for cand in state["threads"]:
        issue = cand["issue"]
        base = {
            "issue_number": issue.get("number"),
            "url": issue.get("url"),
            "title": issue.get("title"),
            "similarity_score": cand["similarity_score"],
            "state": issue.get("state"),
            "closure_reason": issue.get("closure_reason"),
            "fixed_in_version": issue.get("fixed_in_version"),
        }
        if llm is None:
            comparison = _compare_heuristic(state["signals"], cand)
            matches.append({**base, **comparison})
            continue
        prompt = (
            "You are a GitHub maintainer's duplicate-checker. Compare the INCOMING issue "
            "with the CANDIDATE issue below. Compare symptoms, exact error strings, stack "
            "trace frames, OS/runtime, and affected/fixed version ranges — not just titles.\n\n"
            f"INCOMING ISSUE #{state['issue'].get('number')}:\n{state['searchable_text']}\n\n"
            f"CANDIDATE ISSUE #{issue.get('number')} (state={issue.get('state')}, "
            f"closure_reason={issue.get('closure_reason')}, fixed_in={issue.get('fixed_in_version')}):\n"
            f"{cand['thread_text']}\n\n"
            "Reply with ONLY JSON:\n"
            '{"classification": "direct_duplicate"|"related"|"not_duplicate", '
            '"evidence": ["<concrete matching signal>", ...]}'
        )
        try:
            raw = llm.invoke([HumanMessage(content=prompt)]).content.strip()
            raw = re.sub(r"^```(?:json)?|```$", "", raw).strip()
            parsed = json.loads(raw)
            evidence = parsed.get("evidence", []) or []
            parsed["match_strength"] = min(len(evidence), 4)
            matches.append({**base, **parsed})
        except Exception as exc:  # never let one bad parse kill the run
            comparison = _compare_heuristic(state["signals"], cand)
            matches.append({
                **base,
                **comparison,
                "model_fallback": True,
            })
    # Rank by semantic similarity AND evidence quality together so that a
    # candidate with slightly lower similarity but much stronger evidence
    # (e.g. matching stack frame) outranks a title-only lookalike.
    for m in matches:
        m["rank_score"] = round(0.5 * m["similarity_score"] + 0.5 * min(m.get("match_strength", 0), 4) / 4.0, 4)
    matches.sort(key=lambda m: m["rank_score"], reverse=True)
    return {**state, "matches": matches}


def _decide_heuristic(state: AgentState) -> Dict[str, Any]:
    incoming = state["issue"]
    reporter_version = likely_reporter_version(state["signals"], state["searchable_text"])
    matches = state["matches"]
    top = matches[0] if matches else None
    if not top or top["classification"] != "direct_duplicate":
        return {
            "is_direct_duplicate": False,
            "duplicate_confidence": 0.0,
            "matches": matches[:3],
            "suggested_action": "request_reproduction" if top else "no_action",
            "recommendation": "No strongly matching issue found.",
            "evidence_gaps": ["no candidate with two matching technical signals"],
        }
    confidence = round(min(0.99, max(0.5, top["similarity_score"]) * 0.6 + 0.4 * min(1.0, top["match_strength"] / 4.0)), 2)
    fixed_in = top.get("fixed_in_version")
    candidate_state = top.get("state")
    action, recommendation = "link_open_issue", ""

    if candidate_state == "closed" and top.get("closure_reason") == "fixed" and fixed_in:
        if reporter_version and reporter_version != fixed_in and not _version_at_least(reporter_version, fixed_in):
            action = "comment_and_link"
            recommendation = (
                f"{int(confidence * 100)}% match with #{top['issue_number']}, closed and fixed in "
                f"v{fixed_in}. Ask the reporter (appears to be on v{reporter_version}) to update to "
                f"v{fixed_in}, link #{top['issue_number']}, and do not escalate unless the issue "
                "reproduces on the fixed release."
            )
        else:
            action = "escalate"
            recommendation = (
                f"Reporter is on the version where #{top['issue_number']} was fixed (v{fixed_in}) but "
                f"the defect reproduces — possible regression. Escalate with evidence for human review."
            )
    elif candidate_state == "closed" and top.get("closure_reason") in ("duplicate", "not_planned", "wont_fix"):
        action = "link_open_issue"
        recommendation = (
            f"Duplicate of #{top['issue_number']}, closed as {top['closure_reason']}. Link the reports; "
            "do not re-open unless new evidence appears."
        )
    else:
        action = "link_open_issue"
        recommendation = f"Direct duplicate of open issue #{top['issue_number']}. Link and consolidate discussion."

    return {
        "is_direct_duplicate": top.get("classification") == "direct_duplicate",
        "duplicate_confidence": confidence,
        "matches": matches[:3],
        "suggested_action": action,
        "recommendation": recommendation,
        "evidence_gaps": [] if top.get("evidence") else ["no concrete shared technical signal found"],
    }


def _version_at_least(v: str, target: str) -> bool:
    def parts(x: str) -> List[int]:
        return [int(p) for p in x.split(".")]
    return parts(v) >= parts(target)


def node_decide(state: AgentState) -> AgentState:
    if state.get("status") == "insufficient_evidence":
        return {
            **state,
            "result": {
                "status": "insufficient_evidence",
                "is_direct_duplicate": False,
                "duplicate_confidence": 0.0,
                "matches": [],
                "suggested_action": "no_action",
                "recommendation": "Issue title or body is missing; cannot search for duplicates.",
                "evidence_gaps": ["missing title or body"],
            },
        }
    llm = state["llm"]
    if llm is None:
        decision = _decide_heuristic(state)
        status = "needs_human_review" if decision["suggested_action"] == "escalate" else "complete"
        return {**state, "status": status, "result": {"status": status, **decision}}

    matches = [m for m in state["matches"] if m["classification"] != "not_duplicate"][:3]
    prompt = (
        "You are the final decision node of a GitHub duplicate-check agent. Use ONLY the evidence "
        "produced below — no invented facts.\n\n"
        f"INCOMING ISSUE #{state['issue'].get('number')}:\n{state['searchable_text']}\n\n"
        "Candidate analyses (JSON), PRE-ORDERED by evidence quality; the primary candidate is matches[0]:\n"
        f"{json.dumps(matches, indent=2)}\n\n"
        "Base the suggested_action on matches[0]'s state and closure context:\n"
        "- if matches[0] is closed as 'fixed' in a version newer than the reporter's version, use "
        "'comment_and_link' and recommend the reporter update to the fixed version.\n"
        "- if matches[0] is open, use 'link_open_issue'.\n"
        "- if matches[0] is fixed but the reporter appears to be on the fixed version, use 'escalate'.\n\n"
        "Produce the final output contract as JSON only:\n"
        '{"is_direct_duplicate": bool, "duplicate_confidence": 0..1, '
        '"matches": [<matches[0..2] as given, in the same order>], '
        '"suggested_action": "comment_and_link"|"link_open_issue"|"request_reproduction"|"escalate"|"no_action", '
        '"recommendation": "<plain-language verdict for a maintainer>", "evidence_gaps": [...]}'
    )
    try:
        raw = llm.invoke([HumanMessage(content=prompt)]).content.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw).strip()
        parsed = json.loads(raw)
        parsed["matches"] = matches
        status = "needs_human_review" if parsed["suggested_action"] == "escalate" else "complete"
        return {**state, "status": status, "result": {"status": status, **parsed}}
    except Exception as exc:
        decision = _decide_heuristic(state)
        status = "needs_human_review" if decision["suggested_action"] == "escalate" else "complete"
        return {**state, "status": status, "result": {"status": status, **decision}, "error": str(exc)}


def node_finalize(state: AgentState) -> AgentState:
    return state


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

def build_graph(issue: Dict[str, Any], corpus: List[Dict[str, Any]], llm: Any, embedder: Any, owner: str = "", repo: str = "") -> Any:
    store = build_index(corpus, embedder)

    def _make_state() -> AgentState:
        return {
            "issue": issue,
            "repository": {"owner": owner, "repo": repo},
            "searchable_text": "",
            "signals": {},
            "candidates": [],
            "threads": [],
            "matches": [],
            "result": {},
            "status": "complete",
            "error": None,
            "llm": llm,
            "embedder": embedder,
            "store": store,
        }

    graph = StateGraph(AgentState)
    graph.add_node("normalize", node_normalize)
    graph.add_node("embed_and_search", node_embed_and_search)
    graph.add_node("fetch_threads", node_fetch_threads)
    graph.add_node("compare_evidence", node_compare_evidence)
    graph.add_node("decide", node_decide)
    graph.add_node("finalize", node_finalize)

    graph.add_edge(START, "normalize")
    graph.add_conditional_edges(
        "normalize",
        lambda s: "embed_and_search" if s["status"] == "complete" else "decide",
        {"embed_and_search": "embed_and_search", "decide": "decide"},
    )
    graph.add_edge("embed_and_search", "fetch_threads")
    graph.add_edge("fetch_threads", "compare_evidence")
    graph.add_edge("compare_evidence", "decide")
    graph.add_edge("decide", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile(), _make_state


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_duplicate_check(issue: Dict[str, Any], owner: str = GITHUB_OWNER, repo: str = GITHUB_REPO) -> Dict[str, Any]:
    corpus = [github_issue_to_model(i) for i in fetch_corpus(owner, repo)]
    if not corpus:
        raise RuntimeError(f"no issue history found for {owner}/{repo} — check GITHUB_TOKEN/Owner/Repo")
    llm = build_llm()
    embedder = build_embedder()

    # Persist the fetched history into the shared project memory so future
    # runs can retrieve these issues (with their resolution context) even if
    # the GitHub fetch window changes. Never blocks the pipeline on failure.
    memory_store.ingest(
        owner,
        repo,
        [
            {
                "id": f"issue-{i['number']}",
                "text": full_thread_text(i),
                "embedding": vec,
                "metadata": {
                    "kind": "issue",
                    "number": i["number"],
                    "title": i.get("title", ""),
                    "url": i.get("url", ""),
                    "state": i.get("state", ""),
                    "closure_reason": i.get("closure_reason", ""),
                    "fixed_in_version": i.get("fixed_in_version", ""),
                    "created_at": i.get("created_at", ""),
                    "closed_at": i.get("closed_at", ""),
                },
            }
            for i, vec in zip(corpus, embedder.embed_documents([full_thread_text(i) for i in corpus]))
        ],
    )

    compiled, make_state = build_graph(issue, corpus, llm, embedder, owner=owner, repo=repo)
    return compiled.invoke(make_state())


def main() -> int:
    parser = argparse.ArgumentParser(description="RepoGuardian Duplicate Check Agent")
    parser.add_argument("--owner", default=GITHUB_OWNER, help="GitHub owner (or set GITHUB_OWNER)")
    parser.add_argument("--repo", default=GITHUB_REPO, help="GitHub repo (or set GITHUB_REPO)")
    parser.add_argument("--issue-number", type=int, help="incoming issue number to check")
    parser.add_argument("--issue-json", help="path to a webhook payload JSON (issue object) instead of fetching by number")
    args = parser.parse_args()

    if not args.owner or not args.repo:
        print("error: --owner and --repo are required (or set GITHUB_OWNER/GITHUB_REPO)", file=sys.stderr)
        return 1

    if args.issue_json:
        if not os.path.exists(args.issue_json):
            print(f"error: issue file not found: {args.issue_json}", file=sys.stderr)
            return 1
        with open(args.issue_json, encoding="utf-8") as fh:
            issue = json.load(fh)
        if "number" not in issue:
            print("error: --issue-json payload must contain an 'issue' object", file=sys.stderr)
            return 1
        issue = issue.get("issue", issue)
    elif args.issue_number:
        issue = github_issue_to_model(fetch_issue(args.owner, args.repo, args.issue_number))
    else:
        print("error: provide --issue-number or --issue-json", file=sys.stderr)
        return 1

    mode = "NVIDIA" if _has_key() else "offline (no NVIDIA_API_KEY in .env)"
    print(f"[duplicate-agent] mode: {mode} | checking #{issue['number']} against {args.owner}/{args.repo}")

    final = run_duplicate_check(issue, owner=args.owner, repo=args.repo)
    print(json.dumps(final["result"], indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
