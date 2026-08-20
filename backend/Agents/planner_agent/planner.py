"""
Planner Agent — RepoGuardian

The part that makes the pipeline "agentic" rather than "a classifier": on
every event it plans what to investigate and pulls evidence via tool calls
before deciding anything. Emits a visible reasoning trace:

    {"planner": {
        "trace": [{step, tool, input, output, note}, ...],
        "routing": {"agents": [...], "rationale": "..."},
        "decision": {"verdict", "confidence", "summary"},
        "suggested_actions": [{kind, preview, gated}]
    }}

Tools (deterministic-first, LLM polish optional when NVIDIA_API_KEY is set):
  vector_search, fetch_issue, fetch_pr, search_linked_prs, check_ci_status,
  keyword_scan, get_repo_conventions, get_contributor_history.
  Write actions (post_comment / apply_label) are only surfaced as gated
  previews — the webhook worker and UI decide whether to apply them.

Usage:
  python planner.py --owner <owner> --repo <repo> --issue-json - [--event issues.opened]
  python planner.py --owner <owner> --repo <repo> --issue-number <n> --event pull_request.opened
"""

import argparse
import json
import os
import re
import sys
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import requests
from dotenv import load_dotenv

COMMON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common")
if COMMON_DIR not in sys.path:
    sys.path.insert(0, COMMON_DIR)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv(os.path.join(BASE_DIR, ".env"))

NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_LLM_MODEL = os.getenv("NVIDIA_LLM_MODEL", "nvidia/nemotron-3-nano-30b-a3b")
GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")

_API = "https://api.github.com"
_HEADERS = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json", "User-Agent": "RepoGuardian"}

# Lazy heavy deps: the planner still works (deterministic mode) when
# langchain/langgraph are unavailable on the host.
LLM = None
EMBEDDER = None
try:
    from langchain_core.messages import HumanMessage
    from langchain_nvidia_ai_endpoints import ChatNVIDIA, NVIDIAEmbeddings
    import memory_store  # noqa: F401  (only needed with LLM path available)

    if NVIDIA_API_KEY and "your_" not in NVIDIA_API_KEY and "xxx" not in NVIDIA_API_KEY:
        LLM = ChatNVIDIA(model=NVIDIA_LLM_MODEL, api_key=NVIDIA_API_KEY, temperature=0.1, top_p=1, max_completion_tokens=800)
        EMBEDDER = NVIDIAEmbeddings(model=os.getenv("NVIDIA_EMBED_MODEL", "nvidia/nv-embedqa-e5-v5"), api_key=NVIDIA_API_KEY, truncate="END")
except Exception:
    LLM = None
    EMBEDDER = None


# ---------------------------------------------------------------------------
# Lightweight embedder + retrieval (vector_search tool)
# ---------------------------------------------------------------------------

class LocalEmbeddings:
    def embed_documents(self, texts: List[str]) -> List[Dict[str, float]]:
        return [self.embed_query(t) for t in texts]

    def embed_query(self, text: str) -> Dict[str, float]:
        counts: Dict[str, int] = {}
        for token in re.findall(r"[a-z0-9_#.+-]+", text.lower()):
            counts[token] = counts.get(token, 0) + 1
        norm = sum(v * v for v in counts.values()) ** 0.5 or 1.0
        return {tok: v / norm for tok, v in counts.items()}


def _cosine(a: Any, b: Any) -> float:
    if isinstance(a, dict) and isinstance(b, dict):
        inter = set(a) & set(b)
        return sum(a[t] * b[t] for t in inter) if inter else 0.0
    try:
        import numpy as np
        a, b = np.asarray(a, dtype=float), np.asarray(b, dtype=float)
        na, nb = np.linalg.norm(a), np.linalg.norm(b)
        return float(np.dot(a, b) / (na * nb)) if na and nb else 0.0
    except Exception:
        return 0.0


def vector_search(query: str, k: int = 5) -> List[Dict[str, Any]]:
    if EMBEDDER is not None:
        try:
            import memory_store
            qv = EMBEDDER.embed_query(query)
            return memory_store.retrieve(OWNER, REPO, qv, k=k)
        except Exception:
            return []
    return []


# ---------------------------------------------------------------------------
# GitHub adapters (best-effort; never crash the planner)
# ---------------------------------------------------------------------------

def gh_get(url: str, params: Optional[Dict[str, Any]] = None) -> Optional[Any]:
    try:
        resp = requests.get(url, headers=_HEADERS, params=params, timeout=25)
        if resp.status_code in (401, 403, 404):
            return None
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return None


def fetch_issue(owner: str, repo: str, number: int) -> Optional[Dict[str, Any]]:
    data = gh_get(f"{_API}/repos/{owner}/{repo}/issues/{number}")
    if not data:
        return None
    return {
        "number": data.get("number"),
        "title": data.get("title", ""),
        "state": data.get("state", ""),
        "body": str(data.get("body") or "")[:2000],
        "labels": [label.get("name") for label in (data.get("labels") or []) if label.get("name")],
        "user": (data.get("user") or {}).get("login"),
        "created_at": data.get("created_at"),
        "closed_at": data.get("closed_at"),
    }


def search_linked_prs(owner: str, repo: str, number: int) -> List[Dict[str, Any]]:
    data = gh_get(f"{_API}/search/issues", params={"q": f"repo:{owner}/{repo} type:pr \"{number}\"", "per_page": 5})
    return [
        {"number": item.get("number"), "title": item.get("title", ""), "state": item.get("state", "")}
        for item in (data or {}).get("items", [])
    ]


def check_ci_status(owner: str, repo: str, head_sha: Optional[str]) -> Dict[str, Any]:
    if not head_sha:
        return {"configured": False, "runs": []}
    data = gh_get(f"{_API}/repos/{owner}/{repo}/commits/{head_sha}/check-runs")
    return {
        "configured": bool(data and data.get("total_count")),
        "runs": [
            {"name": run.get("name"), "status": run.get("status"), "conclusion": run.get("conclusion")}
            for run in (data or {}).get("check_runs", [])
        ],
    }


def get_repo_conventions(owner: str, repo: str) -> Dict[str, Any]:
    conventions: Dict[str, Any] = {"has_contributing": False, "auto_close_threshold_days": 30}
    for path, key in [("CONTRIBUTING.md", "contributing_guidelines"), ("SECURITY.md", "security_policy")]:
        try:
            resp = requests.get(
                f"{_API}/repos/{owner}/{repo}/contents/{path}",
                headers={**_HEADERS, "Accept": "application/vnd.github.raw+json"},
                timeout=15,
            )
            if resp.status_code == 200:
                conventions[key] = resp.text[:800]
                conventions["has_" + ("contributing" if key == "contributing_guidelines" else "security_policy")] = True
        except Exception:
            continue
    return conventions


def get_contributor_history(owner: str, repo: str, login: Optional[str]) -> Optional[Dict[str, Any]]:
    if not login:
        return None
    contributors = gh_get(f"{_API}/repos/{owner}/{repo}/contributors", params={"per_page": 30}) or []
    match = next((item for item in contributors if item.get("login") == login), None)
    return {
        "commits_contributed": int(match.get("contributions") or 0) if match else 0,
        "is_top_contributor": bool(match),
        "first_time": not match,
    }


# ---------------------------------------------------------------------------
# Deterministic tool orchestration — the visible trace
# ---------------------------------------------------------------------------

OWNER = ""
REPO = ""

KEYWORD_RULES: List[Dict[str, Any]] = [
    {"label": "AWS access key", "pattern": r"\bAKIA[0-9A-Z]{16}\b"},
    {"label": "API key in plaintext", "pattern": r"(?i)\bapi[_-]?key\s*[:=]\s*\S{8,}"},
    {"label": "client secret in plaintext", "pattern": r"(?i)\bclient[_-]?secret\s*[:=]\s*\S{8,}"},
    {"label": "bearer/token value", "pattern": r"(?i)\b(?:bearer\s+|token\s*[:=])\s*[A-Za-z0-9._~+/=-]{16,}"},
    {"label": "password value", "pattern": r"(?i)\bpassword\s*[:=]\s*\S{4,}"},
    {"label": "private key material", "pattern": r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"},
    {"label": "authentication bypass", "pattern": r"(?i)\bauth(?:entication)?\s+bypass\b"},
    {"label": "privilege escalation", "pattern": r"(?i)\bprivilege\s+escalation\b"},
    {"label": "unauthorized access", "pattern": r"(?i)\bunauthorized\s+access\b"},
    {"label": "SQL injection", "pattern": r"(?i)\bsql\s+injection\b"},
    {"label": "XSS payload", "pattern": r"\b(?:<script[^>]*>|onerror\s*=)"},
    {"label": "command injection", "pattern": r"(?i)\bcommand\s+injection\b"},
    {"label": "remote code execution", "pattern": r"(?i)\bremote\s+code\s+execution\b|\brce\b"},
    {"label": "CVE reference", "pattern": r"\bCVE-\d{4}-\d{4,}\b"},
    {"label": "GitHub Security Advisory reference", "pattern": r"\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\b"},
    {"label": "exploit", "pattern": r"(?i)\bexploit\b"},
    {"label": "vulnerability", "pattern": r"(?i)\bvulnerabilit(?:y|ies)\b"},
]

VERSION_RE = re.compile(r"\bv?\d+\.\d+(?:\.\d+)?\b")


def keyword_scan(text: str) -> List[str]:
    return [rule["label"] for rule in KEYWORD_RULES if re.search(rule["pattern"], text)]


def extract_versions(text: str) -> List[str]:
    return sorted(set(VERSION_RE.findall(text)))


def _comment_velocity(text: str) -> int:
    return len(re.findall(r"(?i)\b(?:urgent|broken|crash|frustrating|terrible|worst|furious|angry)\b", text))


def run_planner(issue: Dict[str, Any], event: str) -> Dict[str, Any]:
    """Deterministic orchestration. Each tool call appends a trace entry."""
    trace: List[Dict[str, Any]] = []
    number = issue.get("number")
    title = issue.get("title") or ""
    body = str(issue.get("body") or "")
    author = (issue.get("user") or {}).get("login")
    is_pr = bool(issue.get("pull_request")) or event.startswith("pull_request")
    text = f"{title}\n{body}"

    def step(tool: str, input_: str, output: Any, note: str = "") -> Any:
        trace.append({
            "step": len(trace) + 1,
            "tool": tool,
            "input": str(input_)[:300],
            "output": json.dumps(output, default=str)[:500],
            "note": note,
        })
        return output

    # 1. keyword_scan — fast rule-based security pass (always runs)
    indicators = keyword_scan(text)
    scan_note = "no security indicators" if not indicators else f"flagged: {', '.join(indicators)}"
    trace.append({
        "step": 1,
        "tool": "keyword_scan",
        "input": "issue title + body",
        "output": json.dumps(indicators),
        "note": scan_note,
    })
    security_flagged = len(indicators) > 0

    # 2. vector_search — semantic search over issue history (RAG)
    query = f"{title} {body[:500]}"
    hits = step("vector_search", query, vector_search(query, k=5)[:5],
                "retrieved from repo memory corpus")
    top = next((h for h in hits if float(h.get("score") or 0) >= 0.5), None)

    # 3. Candidate duplicate → verify with fetch_issue + version compare
    duplicate = None
    dup_evidence: List[str] = []
    if top and not is_pr:
        candidate_number = None
        m = re.search(r"issue #(\d+)|#(\d+)", str(top.get("text") or ""))
        m2 = re.search(r"\"number\": (\d+)", str(top.get("text") or ""))
        if m:
            candidate_number = int(m.group(1) or m.group(2))
        elif m2:
            candidate_number = int(m2.group(1))
        if candidate_number and candidate_number != number:
            dup_issue = step("fetch_issue", f"#{candidate_number}", fetch_issue(OWNER, REPO, candidate_number),
                             "full thread of the candidate duplicate")
            if dup_issue:
                dup_versions = extract_versions(f"{dup_issue.get('title', '')} {dup_issue.get('body', '')}")
                issue_versions = extract_versions(text)
                version_note = ""
                if dup_versions and issue_versions and set(issue_versions) & set(dup_versions):
                    version_note = f"same version(s) {sorted(set(issue_versions) & set(dup_versions))} — consistent duplicate"
                elif issue_versions and dup_versions:
                    version_note = f"reporter on {issue_versions}, original mentions {dup_versions} — check version overlap"
                duplicate = {
                    "number": candidate_number,
                    "title": dup_issue.get("title", ""),
                    "score": round(float(top.get("score") or 0), 2),
                    "state": dup_issue.get("state", ""),
                    "resolution": dup_issue.get("body", "")[:200],
                    "version_note": version_note,
                }
                dup_evidence.append(f"similarity {duplicate['score']} vs #{candidate_number}")
                if version_note:
                    dup_evidence.append(version_note)

    # 4. search_linked_prs — any PR already referencing this item
    linked_result = search_linked_prs(OWNER, REPO, number)
    linked = step("search_linked_prs", f"repo:{OWNER}/{REPO} type:pr \"{number}\"", linked_result,
                  "no linked PRs" if not linked_result else "linked PRs found")

    # 5. check_ci_status — only relevant for PRs
    ci = None
    if is_pr:
        head_sha = (issue.get("head") or {}).get("sha")
        ci_result = check_ci_status(OWNER, REPO, head_sha)
        ci = step("check_ci_status", head_sha or "no head sha", ci_result,
                  "checks configured" if ci_result.get("configured") else "no CI checks configured")

    # 6. get_repo_conventions + get_contributor_history — cheap context
    conventions = step("get_repo_conventions", f"{OWNER}/{REPO}", get_repo_conventions(OWNER, REPO), "")
    history = step("get_contributor_history", author or "unknown", get_contributor_history(OWNER, REPO, author), "")

    # 7. Synthesize routing + decision
    routed: List[str] = []
    rationale: List[str] = []
    if security_flagged:
        routed.append("sensitivity")
        rationale.append("keyword scan flagged security-sensitive content")
    if not is_pr:
        if duplicate:
            routed.append("duplicate")
            rationale.append(f"candidate duplicate #{duplicate['number']} ({duplicate['score']} similarity) needs confirmation")
        elif top:
            routed.append("duplicate")
            rationale.append("similar historical issue found — confirm overlap before deciding")
        else:
            routed.append("duplicate")
            rationale.append("no strong duplicate found — cheap confirmation pass")
    body_len = len(body.strip())
    if not is_pr and (body_len < 120 or not re.search(r"(?i)\b(repro|steps|error|log|expected|version)\b", body)):
        routed.append("missing_info")
        rationale.append("report lacks reproduction steps or environment detail")
    if _comment_velocity(text) > 0 or event == "issue_comment.created":
        routed.append("sentiment")
        rationale.append("conversation may be contentious — tone matters for escalation")
    bug_signal = bool(re.search(r"(?i)\b(bug|crash|error|fails|broken|regression|exception|stack trace)\b", text))
    if bug_signal or security_flagged:
        routed.append("backlog")
        rationale.append("bug/security signal — repo-wide context helps prioritise")
    routed = list(dict.fromkeys(routed))

    # verdict
    if security_flagged:
        verdict, confidence, summary = "security", 0.9, "Security-sensitive content detected; route through the sensitivity agent and consider private disclosure."
    elif duplicate and duplicate["state"] == "closed":
        verdict, confidence, summary = "duplicate", min(0.95, 0.5 + duplicate["score"]), (
            f"Likely duplicate of closed issue #{duplicate['number']} ({duplicate['score']} similarity). "
            f"{duplicate['version_note']}"
        )
    elif duplicate:
        verdict, confidence, summary = "related", 0.6, f"Related to open issue #{duplicate['number']} — confirm whether it is the same problem."
    elif not is_pr and body_len < 120:
        verdict, confidence, summary = "needs_info", 0.7, "Report is thin; request reproduction steps before deeper investigation."
    elif not routed:
        verdict, confidence, summary = "routine", 0.8, "Routine issue; no high-priority signals found."
    else:
        verdict, confidence, summary = "escalate", 0.6, "Notable signals detected; run the routed investigation agents."

    suggested_actions: List[Dict[str, Any]] = []
    if verdict == "duplicate" and duplicate:
        suggested_actions.append({
            "kind": "post_comment",
            "gated": True,
            "preview": (
                f"Hi @{author or 'there'} — this issue looks like a duplicate of #{duplicate['number']} "
                f"({duplicate['title']}). {duplicate['version_note']} Please follow the original issue."
            ),
        })
        suggested_actions.append({"kind": "apply_label", "gated": True, "preview": {"labels": ["duplicate"]}})
    elif verdict == "needs_info":
        suggested_actions.append({
            "kind": "post_comment",
            "gated": True,
            "preview": "Thanks for the report! Could you add reproduction steps, expected vs. actual behaviour, and the environment/version?",
        })
    elif security_flagged:
        suggested_actions.append({
            "kind": "post_comment",
            "gated": True,
            "preview": "This report may contain security-sensitive details — please move it to a private security advisory instead of a public issue.",
        })

    return {
        "trace": trace,
        "routing": {"agents": routed, "rationale": rationale},
        "decision": {"verdict": verdict, "confidence": round(confidence, 2), "summary": summary, "is_pr": is_pr},
        "suggested_actions": suggested_actions,
    }


def _refine_with_llm(planner: Dict[str, Any], issue: Dict[str, Any]) -> Dict[str, Any]:
    """Optional LLM polish: sharpen summary/confidence, never restructure."""
    if LLM is None:
        return planner
    try:
        prompt = (
            "You are the Planner of a GitHub maintenance platform. A deterministic planner produced "
            "a routing trace and decision. Sharpen the wording and confidence, keep the same structure, "
            "never invent facts.\n\n"
            f"Issue #{issue.get('number')}: {issue.get('title', '')}\n{str(issue.get('body') or '')[:800]}\n\n"
            f"Planner output:\n{json.dumps(planner, default=str, indent=2)}\n\n"
            "Respond with ONLY JSON matching the planner schema: "
            '{"trace": [same as given], "routing": {same}, '
            '"decision": {"verdict": "...", "confidence": 0-1, "summary": "<sharpened>"}, '
            '"suggested_actions": [same as given]}'
        )
        raw = LLM.invoke([HumanMessage(content=prompt)]).content.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw).strip()
        parsed = json.loads(raw)
        parsed["trace"] = planner["trace"]
        parsed["routing"] = planner["routing"]
        parsed["suggested_actions"] = planner["suggested_actions"]
        decision = parsed.get("decision", {})
        decision["is_pr"] = planner["decision"]["is_pr"]
        parsed["decision"] = decision
        return parsed
    except Exception:
        return planner


def main() -> int:
    global OWNER, REPO
    parser = argparse.ArgumentParser(description="RepoGuardian Planner Agent")
    parser.add_argument("--owner", required=True)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--issue-json", default=None, help="path to issue payload JSON, or '-' for stdin")
    parser.add_argument("--issue-number", type=int, default=None)
    parser.add_argument("--event", default="issues.opened")
    args = parser.parse_args()

    OWNER, REPO = args.owner, args.repo
    issue: Optional[Dict[str, Any]] = None
    if args.issue_json == "-":
        issue = json.load(sys.stdin)
    elif args.issue_json:
        with open(args.issue_json, encoding="utf-8") as handle:
            issue = json.load(handle)
    elif args.issue_number:
        issue = fetch_issue(OWNER, REPO, args.issue_number)

    if not issue:
        print(json.dumps({"error": "planner could not load the issue payload"}, ensure_ascii=False))
        return 1

    planner = run_planner(issue, args.event)
    planner = _refine_with_llm(planner, issue)
    print(json.dumps({"planner": planner}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())