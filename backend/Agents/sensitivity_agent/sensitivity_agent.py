"""
Security Sensitivity Agent — RepoGuardian

Agentic AI (LangGraph) that runs on EVERY new issue/PR, early in the routing
pipeline, and flags content that should never be public: credential leaks,
vulnerability disclosures, auth bypasses, exploit details.

  Goal:   decide whether an issue publicly discloses a security concern that
          should instead go through private disclosure.
  Tools:  regex classifiers + LLM classification, cross-checked against the
          repo's GitHub Security Advisories and Dependabot alerts.
  Output: danger score (0-100), priority flag, private-notification request,
          and a recommendation (e.g. convert to private security advisory).

Security reports are often terse and low quality — this agent escalates on
signal, not on issue polish.

Runtime modes:
  - NVIDIA mode:  ChatNVIDIA (Nemotron 3 Ultra) for classification, key from .env
  - Offline mode: deterministic regex + weighted heuristic scoring, so the
    pipeline runs and is testable without an API key.

Configuration (in .env):
  NVIDIA_API_KEY=...
  GITHUB_TOKEN=...          # fine-grained PAT with Security events + Issues read
  GITHUB_OWNER=<owner>
  GITHUB_REPO=<repo>

Usage:
  python sensitivity_agent.py --owner <owner> --repo <repo> --issue-number <n>
  python sensitivity_agent.py --issue-json issue_payload.json    # webhook payload
"""

import argparse
import json
import os
import re
import sys
from typing import Any, Dict, List, Optional, TypedDict

import requests
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA
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
NVIDIA_LLM_MODEL = os.getenv("NVIDIA_LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b")

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_OWNER = os.getenv("GITHUB_OWNER", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "")


# ---------------------------------------------------------------------------
# Regex classifiers — cheap, deterministic, always run (also feeds the LLM)
# ---------------------------------------------------------------------------

SECURITY_PATTERNS: Dict[str, List[Dict[str, Any]]] = {
    "credential_leak": [
        {"pattern": r"\bAKIA[0-9A-Z]{16}\b", "weight": 40, "label": "AWS access key"},
        {"pattern": r"(?i)\bapi[_-]?key\s*[:=]\s*\S{8,}", "weight": 35, "label": "API key in plaintext"},
        {"pattern": r"(?i)\bclient[_-]?secret\s*[:=]\s*\S{8,}", "weight": 35, "label": "client secret in plaintext"},
        {"pattern": r"(?i)\b(?:bearer\s+|token\s*[:=])\s*[A-Za-z0-9._~+/=-]{16,}", "weight": 30, "label": "bearer/token value"},
        {"pattern": r"(?i)\bpassword\s*[:=]\s*\S{4,}", "weight": 30, "label": "password value"},
        {"pattern": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", "weight": 40, "label": "private key material"},
        {"pattern": r"(?i)\bmongodb(?:\+srv)?://[^\s]+:[^\s]+@", "weight": 40, "label": "DB connection string with credentials"},
        {"pattern": r"\bjdbc:[^\s:]+:[^\s]+:[^\s]+", "weight": 25, "label": "JDBC connection string"},
    ],
    "auth_bypass": [
        {"pattern": r"(?i)\bauth(?:entication)?\s+bypass\b", "weight": 40, "label": "authentication bypass"},
        {"pattern": r"(?i)\btoken\s+(?:expiry|expiration|expires?)\b", "weight": 35, "label": "token expiry issue"},
        {"pattern": r"(?i)\bexpired?\s+token\b", "weight": 30, "label": "expired token"},
        {"pattern": r"(?i)\bprivilege\s+escalation\b", "weight": 40, "label": "privilege escalation"},
        {"pattern": r"(?i)\bunauthorized\s+access\b", "weight": 30, "label": "unauthorized access"},
        {"pattern": r"(?i)\b(?:reset|forgot)\s+(?:a\s+)?password\b", "weight": 25, "label": "password reset flow"},
        {"pattern": r"(?i)\bsession\s+(?:fixation|hijack|prediction)\b", "weight": 35, "label": "session attack"},
        {"pattern": r"(?i)\baccess\s+control\b", "weight": 20, "label": "access control"},
    ],
    "injection_rce": [
        {"pattern": r"(?i)\bsql\s+injection\b", "weight": 40, "label": "SQL injection"},
        {"pattern": r"\b(?:<script[^>]*>|onerror\s*=)", "weight": 25, "label": "XSS payload"},
        {"pattern": r"(?i)\bcommand\s+injection\b", "weight": 40, "label": "command injection"},
        {"pattern": r"(?i)\bremote\s+code\s+execution\b|\brce\b", "weight": 40, "label": "remote code execution"},
        {"pattern": r"(?i)\bpath\s+traversal\b|\.\./\.\./", "weight": 30, "label": "path traversal"},
        {"pattern": r"(?i)\b(?:XXE|LDAP|header|CRLF)\s+injection\b", "weight": 30, "label": "other injection"},
    ],
    "vulnerability_ref": [
        {"pattern": r"\bCVE-\d{4}-\d{4,}\b", "weight": 45, "label": "CVE reference"},
        {"pattern": r"\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b", "weight": 45, "label": "GitHub Security Advisory reference"},
        {"pattern": r"(?i)\bexploit\b", "weight": 30, "label": "exploit"},
        {"pattern": r"(?i)\bzero[-\s]?day\b", "weight": 35, "label": "zero-day"},
        {"pattern": r"(?i)\bvulnerabilit(?:y|ies)\b", "weight": 25, "label": "vulnerability"},
        {"pattern": r"(?i)\bbuffer\s+overflow\b|use[-\s]after[-\s]free\b", "weight": 35, "label": "memory-safety bug"},
        {"pattern": r"(?i)\bsecurity\s+advisory\b", "weight": 25, "label": "security advisory"},
    ],
}


def scan_indicators(text: str) -> List[Dict[str, Any]]:
    """Run all regex classifiers. Returns matched indicators with context."""
    indicators: List[Dict[str, Any]] = []
    seen: set = set()
    for category, rules in SECURITY_PATTERNS.items():
        for rule in rules:
            for match in re.finditer(rule["pattern"], text):
                snippet = text[max(0, match.start() - 60):match.end() + 60].replace("\n", " ")
                key = (category, rule["label"])
                if key in seen:
                    continue
                seen.add(key)
                indicators.append(
                    {
                        "category": category,
                        "label": rule["label"],
                        "weight": rule["weight"],
                        "snippet": snippet,
                    }
                )
    return indicators


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class AgentState(TypedDict):
    issue: Dict[str, Any]
    searchable_text: str
    indicators: List[Dict[str, Any]]
    policy: Dict[str, Any]             # SECURITY.md disclosure policy
    advisories: List[Dict[str, Any]]   # matched advisories / dependabot alerts
    result: Dict[str, Any]
    status: str
    error: Optional[str]
    llm: Optional[Any]
    embedder: Any
    owner: str
    repo: str


# ---------------------------------------------------------------------------
# GitHub adapters — live data only, no dummies
# ---------------------------------------------------------------------------

_API = "https://api.github.com"
_HEADERS = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}
_RAW_HEADERS = {**_HEADERS, "Accept": "application/vnd.github.raw+json"}


def _gh_get(url: str, params: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Any:
    resp = requests.get(url, headers=headers or _HEADERS, params=params, timeout=30)
    if resp.status_code in (403, 404):
        # 404: nothing to see. 403: token lacks permission for this endpoint
        # (e.g. dependabot alerts need security_events read) — treat as no data
        # rather than failing the whole sensitivity pipeline.
        return None
    resp.raise_for_status()
    return resp.json()


def fetch_issue(owner: str, repo: str, number: int) -> Dict[str, Any]:
    resp = requests.get(f"{_API}/repos/{owner}/{repo}/issues/{number}", headers=_HEADERS, timeout=30)
    resp.raise_for_status()
    return resp.json()


def fetch_security_policy(owner: str, repo: str) -> Dict[str, Any]:
    """SECURITY.md content if present, plus whether it requests private disclosure."""
    raw = _gh_get(f"{_API}/repos/{owner}/{repo}/contents/SECURITY.md", headers=_RAW_HEADERS)
    if raw is None or isinstance(raw, list) or not isinstance(raw, str):
        return {"present": False, "requests_private": False, "text": ""}
    low = raw.lower()
    requests_private = bool(
        re.search(r"(?i)\bsecurity[-\s]?(?:report|disclos|advis)|report\s+(?:a\s+)?(?:vulnerab|security)|private\s+disclos|disclos\s+privately|hackerone|huntr", raw)
    ) and bool(
        re.search(r"(?i)\b(?:email|e-?mail|contact|link|form)\b", raw)
    )
    return {"present": True, "requests_private": requests_private, "text": raw[:2000]}


def fetch_repo_advisories(owner: str, repo: str) -> List[Dict[str, Any]]:
    data = _gh_get(f"{_API}/repos/{owner}/{repo}/security-advisories", params={"state": "published"})
    if not data:
        return []
    return [
        {
            "ghsa_id": a.get("ghsa_id"),
            "cve_id": a.get("cve_id"),
            "severity": a.get("severity"),
            "summary": a.get("summary"),
        }
        for a in data
    ]


def fetch_dependabot_alerts(owner: str, repo: str) -> List[Dict[str, Any]]:
    data = _gh_get(f"{_API}/repos/{owner}/{repo}/dependabot/alerts", params={"state": "open", "per_page": 50})
    if not data:
        return []
    alerts = []
    for a in data:
        dep = (a.get("dependency") or {}).get("package", {})
        adv = (a.get("security_advisory") or {})
        alerts.append(
            {
                "package": dep.get("name"),
                "ecosystem": dep.get("ecosystem"),
                "severity": adv.get("severity"),
                "ghsa_id": adv.get("ghsa_id"),
                "cve_id": adv.get("cve_id"),
            }
        )
    return alerts


def lookup_global_advisory(reference: str) -> Optional[Dict[str, Any]]:
    """Resolve a CVE/GHSA mentioned in the issue text against the GitHub
    Advisory Database."""
    if reference.lower().startswith("ghsa-"):
        data = _gh_get(f"{_API}/advisories/{reference}")
    else:
        data = _gh_get(f"{_API}/advisories", params={"cve_id": reference})
        data = data[0] if data else None
    if not data:
        return None
    return {
        "ghsa_id": data.get("ghsa_id"),
        "cve_id": data.get("cve_id"),
        "severity": data.get("severity"),
        "summary": data.get("summary"),
        "published_at": data.get("published_at"),
    }


# ---------------------------------------------------------------------------
# Runtime client
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


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------

def node_normalize(state: AgentState) -> AgentState:
    issue = state["issue"]
    title = issue.get("title", "")
    body = issue.get("body", "")
    if not title and not body:
        return {**state, "status": "insufficient_evidence"}
    return {**state, "searchable_text": f"{title}\n{body}", "status": "complete"}


def node_regex_scan(state: AgentState) -> AgentState:
    return {**state, "indicators": scan_indicators(state["searchable_text"])}


def node_policy_and_advisory(state: AgentState) -> AgentState:
    owner, repo = state["owner"], state["repo"]
    policy = fetch_security_policy(owner, repo)
    advisories = fetch_repo_advisories(owner, repo) + fetch_dependabot_alerts(owner, repo)

    # resolve CVE/GHSA references found in the issue text
    refs = re.findall(r"\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b", state["searchable_text"], re.I)
    resolved = [lookup_global_advisory(r) for r in dict.fromkeys(refs)]
    resolved = [a for a in resolved if a]
    resolved += [
        a
        for a in advisories
        if any(r.upper() in (a.get("cve_id") or "").upper() or r.upper() in (a.get("ghsa_id") or "").upper() for r in refs)
    ]

    # match issue text against open dependabot alerts by package name
    text_low = state["searchable_text"].lower()
    matched_alerts = [a for a in advisories if a.get("package") and a["package"].lower() in text_low]

    seen = set()
    unique = []
    for a in resolved + matched_alerts:
        key = (a.get("ghsa_id") or a.get("cve_id") or a.get("package") or id(a))
        if key in seen:
            continue
        seen.add(key)
        unique.append(a)

    return {**state, "policy": policy, "advisories": unique}


def _heuristic_score(state: AgentState) -> Dict[str, Any]:
    indicators = state["indicators"]
    danger = min(100, sum(i["weight"] for i in indicators))
    advisory_hit = bool(state["advisories"])
    policy_private = state["policy"].get("requests_private", False)
    if advisory_hit:
        danger = min(100, danger + 20)
    if policy_private:
        danger = min(100, danger + 10)
    danger = min(100, danger)

    is_sensitive = danger >= 30 or advisory_hit
    if danger >= 80:
        priority, action = "HIGH", "convert_to_private_advisory"
    elif danger >= 50:
        priority, action = "HIGH", "escalate_now"
    elif danger >= 30:
        priority, action = "MEDIUM", "escalate_now"
    else:
        priority, action = "LOW", "normal_routing"

    if policy_private and danger >= 30:
        action = "convert_to_private_advisory"

    evidence = [i["label"] for i in indicators]
    if advisory_hit:
        evidence.append(f"matches known advisory: {state['advisories'][0].get('ghsa_id') or state['advisories'][0].get('cve_id') or state['advisories'][0].get('package')}")
    if policy_private:
        evidence.append("repo SECURITY.md requests private disclosure")

    recommendation = (
        f"{priority} PRIORITY — SECURITY. Public issue describes a security concern "
        f"(danger score {danger}/100). Recommend: convert to a private security advisory "
        "immediately, do not leave details public. Escalate to maintainer now, bypass normal queue."
        if is_sensitive
        else "No security sensitivity detected; route through normal queue."
    )
    return {
        "is_security_sensitive": is_sensitive,
        "danger_score": danger,
        "priority_flag": priority,
        "private_notification_required": is_sensitive and policy_private,
        "suggested_action": action,
        "matched_indicators": [i["label"] for i in indicators],
        "advisory_matches": state["advisories"],
        "recommendation": recommendation,
        "evidence": evidence,
        "evidence_gaps": ["no advisory cross-check possible"] if not advisory_hit and not refs_present(state) else [],
    }


def refs_present(state: AgentState) -> bool:
    return bool(re.findall(r"\b(?:CVE-\d{4}-\d{4,}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})\b", state["searchable_text"], re.I))


def node_classify(state: AgentState) -> AgentState:
    llm = state["llm"]
    if llm is None:
        decision = _heuristic_score(state)
        return {**state, "status": "complete", "result": {"status": "complete", **decision}}

    policy_text = state["policy"].get("text", "")[:1200] if state["policy"] else ""

    # Similar past issues this agent already flagged as security-sensitive
    # (from the shared project memory) — precedent for how to handle this one.
    memory_context = ""
    try:
        query_vec = state["embedder"].embed_query(state["searchable_text"])
        past = memory_store.retrieve(state["owner"], state["repo"], query_vec, k=3, where={"kind": "issue", "is_sensitive": True})
        if past:
            memory_context = "\n".join(
                f"- issue #{h['metadata'].get('number', '?')}: danger {h['metadata'].get('danger_score')}, "
                f"action {h['metadata'].get('suggested_action', '?')} — {h['text'][:220]}"
                for h in past
            )
    except Exception:
        memory_context = ""

    prompt = (
        "You are the Security Sensitivity Agent of a GitHub maintenance platform. "
        "A new issue may be publicly disclosing a security concern that should go "
        "through private disclosure. Judge from signal, not issue polish — terse "
        "security reports still escalate.\n\n"
        f"INCOMING ISSUE #{state['issue'].get('number')}:\n{state['searchable_text']}\n\n"
        f"Regex-classifier indicators:\n{json.dumps([i['label'] for i in state['indicators']], indent=2)}\n\n"
        f"Known advisories/dependabot alerts matched: {json.dumps(state['advisories'], indent=2)}\n\n"
        f"Repo SECURITY.md (first 1200 chars):\n{policy_text or '(no SECURITY.md found)'}\n\n"
        f"Similar past issues you flagged as security-sensitive (from project memory):\n{memory_context or '(none yet)'}\n\n"
        "Respond with ONLY JSON:\n"
        '{"is_security_sensitive": bool, "danger_score": <0..100>, '
        '"priority_flag": "HIGH"|"MEDIUM"|"LOW", "private_notification_required": bool, '
        '"suggested_action": "convert_to_private_advisory"|"escalate_now"|"normal_routing", '
        '"recommendation": "<actionable verdict for a maintainer>", "evidence": ["..."]}'
    )
    try:
        raw = llm.invoke([HumanMessage(content=prompt)]).content.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw).strip()
        parsed = json.loads(raw)
        parsed.setdefault("matched_indicators", [i["label"] for i in state["indicators"]])
        parsed.setdefault("advisory_matches", state["advisories"])
        return {**state, "status": "complete", "result": {"status": "complete", **parsed}}
    except Exception as exc:
        decision = _heuristic_score(state)
        return {**state, "status": "complete", "result": {"status": "complete", **decision}, "error": str(exc)}


def node_finalize(state: AgentState) -> AgentState:
    # Remember this issue (and how it was classified) in the shared project
    # memory so future runs can reference it as precedent. Never blocks.
    result = state.get("result") or {}
    try:
        query_vec = state["embedder"].embed_query(state["searchable_text"])
        memory_store.ingest(
            state["owner"],
            state["repo"],
            [
                {
                    "id": f"issue-{state['issue'].get('number', '')}",
                    "text": state["searchable_text"],
                    "embedding": query_vec,
                    "metadata": {
                        "kind": "issue",
                        "number": state["issue"].get("number", 0),
                        "is_sensitive": bool(result.get("is_security_sensitive", False)),
                        "danger_score": int(result.get("danger_score", 0)),
                        "priority_flag": result.get("priority_flag", "LOW"),
                        "suggested_action": result.get("suggested_action", ""),
                        "created_at": state["issue"].get("created_at", ""),
                    },
                }
            ],
        )
    except Exception:
        pass
    return state


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

def build_graph(issue: Dict[str, Any], llm: Any, owner: str, repo: str, embedder: Any = None) -> Any:
    def _make_state() -> AgentState:
        return {
            "issue": issue,
            "searchable_text": "",
            "indicators": [],
            "policy": {"present": False, "requests_private": False, "text": ""},
            "advisories": [],
            "result": {},
            "status": "complete",
            "error": None,
            "llm": llm,
            "embedder": embedder or memory_store.build_embedder(),
            "owner": owner,
            "repo": repo,
        }

    graph = StateGraph(AgentState)
    graph.add_node("normalize", node_normalize)
    graph.add_node("regex_scan", node_regex_scan)
    graph.add_node("policy_and_advisory", node_policy_and_advisory)
    graph.add_node("classify", node_classify)
    graph.add_node("finalize", node_finalize)

    graph.add_edge(START, "normalize")
    graph.add_conditional_edges(
        "normalize",
        lambda s: "regex_scan" if s["status"] == "complete" else "classify",
        {"regex_scan": "regex_scan", "classify": "classify"},
    )
    graph.add_edge("regex_scan", "policy_and_advisory")
    graph.add_edge("policy_and_advisory", "classify")
    graph.add_edge("classify", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile(), _make_state


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_sensitivity_check(issue: Dict[str, Any], owner: str = GITHUB_OWNER, repo: str = GITHUB_REPO) -> Dict[str, Any]:
    llm = build_llm()
    compiled, make_state = build_graph(issue, llm, owner, repo)
    return compiled.invoke(make_state())


def main() -> int:
    parser = argparse.ArgumentParser(description="RepoGuardian Security Sensitivity Agent")
    parser.add_argument("--owner", default=GITHUB_OWNER, help="GitHub owner (or set GITHUB_OWNER)")
    parser.add_argument("--repo", default=GITHUB_REPO, help="GitHub repo (or set GITHUB_REPO)")
    parser.add_argument("--issue-number", type=int, help="incoming issue number to check")
    parser.add_argument("--issue-json", help="path to a webhook payload JSON (issue object)")
    args = parser.parse_args()

    if not args.owner or not args.repo:
        print("error: --owner and --repo are required (or set GITHUB_OWNER/GITHUB_REPO)", file=sys.stderr)
        return 1

    if args.issue_json:
        if not os.path.exists(args.issue_json):
            print(f"error: issue file not found: {args.issue_json}", file=sys.stderr)
            return 1
        with open(args.issue_json, encoding="utf-8") as fh:
            payload = json.load(fh)
        issue = payload.get("issue", payload)
        if "number" not in issue:
            print("error: payload must contain an issue with 'number'", file=sys.stderr)
            return 1
    elif args.issue_number:
        issue = fetch_issue(args.owner, args.repo, args.issue_number)
    else:
        print("error: provide --issue-number or --issue-json", file=sys.stderr)
        return 1

    mode = "NVIDIA" if _has_key() else "offline (no NVIDIA_API_KEY in .env)"
    print(f"[sensitivity-agent] mode: {mode} | checking #{issue['number']} against {args.owner}/{args.repo}")

    final = run_sensitivity_check(issue, owner=args.owner, repo=args.repo)
    print(json.dumps(final["result"], indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())