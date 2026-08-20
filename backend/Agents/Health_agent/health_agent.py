"""
Health-Trend Investigator — RepoGuardian

Scheduled agent (e.g. weekly) that operates on aggregate repository metrics
rather than individual issues. It pulls time-series data (time-to-first-response,
backlog size, duplicate rate, contributor activity, incoming volume), runs
trend/changepoint detection to catch inflections instead of snapshots, and when
a negative trend is found it drills down to find WHY (did a maintainer go quiet?
did a release spike volume?) by retrieving evidence around the changepoint.

Output: a health summary with the trend, a plausible cause backed by evidence,
and a recommendation that feeds directly into the Weekly Brief.

Runtime modes:
  - NVIDIA mode:  ChatNVIDIA (Nemotron 3 Ultra) + NVIDIAEmbeddings for the
                  drill-down retrieval, key from .env
  - Offline mode: deterministic local embedder + heuristic synthesis so the
                  pipeline runs and is testable without an API key.

Configuration (in .env):
  NVIDIA_API_KEY=...
  GITHUB_TOKEN=...          # fine-grained PAT with Issues + Metadata read
  GITHUB_OWNER=<owner>
  GITHUB_REPO=<repo>

Usage:
  python health_agent.py --owner <owner> --repo <repo> [--weeks 12]
"""

import argparse
import json
import math
import os
import re
import statistics
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, TypedDict

import requests
from dotenv import load_dotenv
from langchain_core.messages import HumanMessage
from langchain_nvidia_ai_endpoints import ChatNVIDIA, NVIDIAEmbeddings
from langgraph.graph import END, START, StateGraph

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

NVIDIA_API_KEY = os.getenv("NVIDIA_API_KEY", "")
NVIDIA_LLM_MODEL = os.getenv("NVIDIA_LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b")
NVIDIA_EMBED_MODEL = os.getenv("NVIDIA_EMBED_MODEL", "nvidia/nv-embedqa-e5-v5")

GITHUB_TOKEN = os.getenv("GITHUB_TOKEN", "")
GITHUB_OWNER = os.getenv("GITHUB_OWNER", "")
GITHUB_REPO = os.getenv("GITHUB_REPO", "")

_API = "https://api.github.com"
_HEADERS = {"Authorization": f"Bearer {GITHUB_TOKEN}", "Accept": "application/vnd.github+json"}


# ---------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------

class AgentState(TypedDict):
    owner: str
    repo: str
    weeks: int
    series: Dict[str, List[float]]      # weekly metric series, oldest -> newest
    week_labels: List[str]              # ISO week labels aligned with series
    trends: List[Dict[str, Any]]        # detected inflections with evidence
    chunks: List[str]                   # drill-down evidence chunks (RAG corpus)
    retrieved: List[Dict[str, Any]]     # top retrieval hits for "what changed"
    result: Dict[str, Any]
    status: str
    error: Optional[str]
    llm: Optional[Any]
    embedder: Any


# ---------------------------------------------------------------------------
# GitHub adapters — live time-series data
# ---------------------------------------------------------------------------

def _gh_get(url: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
    items: List[Dict[str, Any]] = []
    while url:
        resp = requests.get(url, headers=_HEADERS, params=params, timeout=30)
        resp.raise_for_status()
        items.extend(resp.json())
        params = None
        url = resp.links.get("next", {}).get("url", "")
    return items


def _parse_iso(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return dt.astimezone(timezone.utc) if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def _week_key(dt: datetime) -> str:
    iso = dt.isocalendar()
    return f"{iso[0]}-W{iso[1]:02d}"


def fetch_issue_series(owner: str, repo: str, weeks: int, max_issues: int = 500) -> Dict[str, Any]:
    """Pull issues + comments and compute the weekly metric series. Live data
    only — the agent fails loudly if the token/repo is wrong."""
    since = (datetime.now(timezone.utc) - timedelta(weeks=weeks + 8)).isoformat()
    raw = _gh_get(
        f"{_API}/repos/{owner}/{repo}/issues",
        params={"state": "all", "per_page": 100, "sort": "updated", "direction": "desc", "since": since},
    )
    issues = [i for i in raw if "pull_request" not in i][:max_issues]

    # first-response time needs comment timestamps — fetch only for issues
    # inside the analysis window to bound API calls
    window_start = datetime.now(timezone.utc) - timedelta(weeks=weeks)
    commenters: Dict[str, Dict[str, Any]] = {}   # user -> {count, last_active}
    commenters_by_week: Dict[str, set] = defaultdict(set)  # week -> active users
    first_response: List[tuple] = []             # (week_key, hours)
    backlog_by_week: Counter = Counter()
    opened_by_week: Counter = Counter()
    dup_by_week: Counter = Counter()
    closed_by_week: Counter = Counter()

    for issue in issues:
        created = _parse_iso(issue.get("created_at"))
        closed = _parse_iso(issue.get("closed_at"))
        if not created:
            continue
        created_week = _week_key(created)
        opened_by_week[created_week] += 1

        # backlog: issue counts as open from its creation week until closed
        end_week = _week_key(closed) if closed else _week_key(datetime.now(timezone.utc))
        wk = created_week
        while wk <= end_week:
            backlog_by_week[wk] += 1
            y, w = (int(p) for p in wk.split("-W"))
            wk = _week_key(datetime.fromisocalendar(y, w, 1) + timedelta(days=7))

        if closed:
            closed_by_week[_week_key(closed)] += 1
            if (issue.get("state_reason") or "") == "duplicate":
                dup_by_week[_week_key(closed)] += 1

        if created >= window_start and issue.get("comments", 0) > 0:
            for comment in _gh_get(issue["comments_url"]):
                cdt = _parse_iso(comment.get("created_at"))
                user = (comment.get("user") or {}).get("login")
                if not user or not cdt:
                    continue
                info = commenters.get(user, {"count": 0, "last_active": datetime.min.replace(tzinfo=timezone.utc)})
                info["count"] += 1
                if cdt > info["last_active"]:
                    info["last_active"] = cdt
                commenters[user] = info
                commenters_by_week[_week_key(cdt)].add(user)
                if cdt > created:
                    first_response.append((created_week, (cdt - created).total_seconds() / 3600.0))

    return {
        "issues": issues,
        "opened_by_week": opened_by_week,
        "backlog_by_week": backlog_by_week,
        "dup_by_week": dup_by_week,
        "closed_by_week": closed_by_week,
        "first_response": first_response,
        "commenters": commenters,
        "commenters_by_week": dict(commenters_by_week),
    }


def fetch_commits_participation(owner: str, repo: str) -> List[int]:
    """Weekly commit counts for the last 52 weeks (oldest -> newest)."""
    resp = requests.get(f"{_API}/repos/{owner}/{repo}/stats/participation", headers=_HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    return data.get("all", []) or []


def fetch_releases(owner: str, repo: str) -> List[Dict[str, Any]]:
    try:
        raw = _gh_get(f"{_API}/repos/{owner}/{repo}/releases", params={"per_page": 20})
    except requests.HTTPError:
        return []
    return [
        {"tag": r.get("tag_name"), "published_at": r.get("published_at"), "name": r.get("name") or ""}
        for r in raw
    ]


# ---------------------------------------------------------------------------
# Time series + changepoint detection
# ---------------------------------------------------------------------------

def build_weekly_series(raw: Dict[str, Any], weeks: int) -> Dict[str, List[float]]:
    """Bucket raw data into aligned weekly series (oldest -> newest, length = weeks)."""
    today = datetime.now(timezone.utc)
    labels: List[str] = []
    starts: List[datetime] = []
    for i in range(weeks - 1, -1, -1):
        start = (today - timedelta(weeks=i + 1)).replace(hour=0, minute=0, second=0, microsecond=0)
        start = start - timedelta(days=start.weekday())
        starts.append(start)
        labels.append(_week_key(start))

    def bucket(counter: Counter) -> List[float]:
        out = []
        for start, nxt in zip(starts, starts[1:] + [today]):
            count = 0
            wk = _week_key(start)
            while wk < _week_key(nxt):
                count += counter.get(wk, 0)
                y, w = (int(p) for p in wk.split("-W"))
                wk = _week_key(datetime.fromisocalendar(y, w, 1) + timedelta(days=7))
            out.append(float(count))
        return out

    opened = bucket(raw["opened_by_week"])
    backlog = bucket(raw["backlog_by_week"])
    dup_closed = bucket(raw["dup_by_week"])
    closed = bucket(raw["closed_by_week"])

    # median time-to-first-response per week from (week, hours) pairs
    response = [0.0] * weeks
    by_week: Dict[str, List[float]] = defaultdict(list)
    for wk, hours in raw["first_response"]:
        by_week[wk].append(hours)
    for i, label in enumerate(labels):
        values = by_week.get(label, [])
        response[i] = round(statistics.median(values), 1) if values else 0.0

    # active contributors per week = distinct users who commented that week
    contrib = [0.0] * weeks
    for i, label in enumerate(labels):
        contrib[i] = float(len(raw.get("commenters_by_week", {}).get(label, set())))

    dup_rate = [round(d / c * 100, 1) if c > 0 else 0.0 for d, c in zip(dup_closed, closed)]

    return {
        "time_to_first_response_days": [round(h / 24.0, 2) for h in response],
        "backlog_size": backlog,
        "duplicate_rate": dup_rate,
        "incoming_volume": opened,
        "active_contributors": contrib,
    }, labels


def _safe_ratio(recent: float, baseline: float) -> Optional[float]:
    if baseline <= 0:
        return None
    return recent / baseline


def detect_trends(series: Dict[str, List[float]], labels: List[str]) -> List[Dict[str, Any]]:
    """Changepoint/inflection detection: compare the last 2 weeks against the
    preceding baseline window, then locate the first deviating week."""
    config = {
        "time_to_first_response_days": {"higher_is_worse": True, "threshold": 1.5, "display": "median time-to-first-response"},
        "backlog_size": {"higher_is_worse": True, "threshold": 1.3, "display": "backlog size"},
        "duplicate_rate": {"higher_is_worse": True, "threshold": 1.5, "display": "duplicate rate"},
        "incoming_volume": {"higher_is_worse": True, "threshold": 1.5, "display": "incoming issue volume"},
        "active_contributors": {"higher_is_worse": False, "threshold": 0.67, "display": "active contributors"},
    }
    trends = []
    for metric, values in series.items():
        cfg = config[metric]
        if len(values) < 5:
            continue
        baseline = values[-6:-2] or values[:-2]
        recent = values[-2:]
        base_med = statistics.median(baseline) if baseline else 0.0
        rec_med = statistics.median(recent) if recent else 0.0
        ratio = _safe_ratio(rec_med, base_med)
        if ratio is None:
            continue
        worse = ratio >= cfg["threshold"] if cfg["higher_is_worse"] else ratio <= cfg["threshold"]
        if not worse:
            continue
        # locate the first week in the recent window that deviates
        change_week = None
        for i in range(len(values) - 2, len(values)):
            wk_ratio = _safe_ratio(values[i], base_med)
            if wk_ratio is not None and (wk_ratio >= cfg["threshold"] if cfg["higher_is_worse"] else wk_ratio <= cfg["threshold"]):
                change_week = labels[i]
                break
        trends.append(
            {
                "metric": metric,
                "display": cfg["display"],
                "direction": "worsening" if worse else "improving",
                "baseline_value": round(base_med, 2),
                "recent_value": round(rec_med, 2),
                "change_ratio": round(ratio, 2),
                "change_week": change_week or labels[-2],
                "evidence": [
                    f"{cfg['display']} changed {round(ratio, 1)}x vs the previous {len(baseline)} weeks "
                    f"({base_med} -> {rec_med}), inflection around {change_week or labels[-2]}"
                ],
            }
        )
    trends.sort(key=lambda t: t["change_ratio"], reverse=True)
    return trends


# ---------------------------------------------------------------------------
# Drill-down evidence chunks (RAG retrieval)
# ---------------------------------------------------------------------------

def build_chunks(raw: Dict[str, Any], series: Dict[str, List[float]], labels: List[str], releases: List[Dict[str, Any]], weeks: int) -> List[str]:
    chunks: List[str] = []
    for user, info in raw["commenters"].items():
        days_ago = (datetime.now(timezone.utc) - info["last_active"]).days
        chunks.append(
            f"contributor @{user}: commented on {info['count']} issues in the analysis window, "
            f"last active {info['last_active'].strftime('%Y-%m-%d')} ({days_ago} days ago)"
        )
    for i, label in enumerate(labels):
        chunks.append(
            f"week {label}: {int(series['incoming_volume'][i])} issues opened, "
            f"{int(series['backlog_size'][i])} open backlog, "
            f"{int(series['duplicate_rate'][i])}% duplicate rate, "
            f"median first response {series['time_to_first_response_days'][i]} days, "
            f"{int(series['active_contributors'][i])} active contributors"
        )
    for r in releases:
        chunks.append(f"release {r['tag']} published on {r['published_at']}: {r['name']}")
    return chunks


# ---------------------------------------------------------------------------
# Embeddings + retrieval (NVIDIA, local fallback)
# ---------------------------------------------------------------------------

def _sparse_vector(text: str) -> Dict[str, float]:
    tokens = re.findall(r"[a-z0-9_#.+-]+", text.lower())
    counts = Counter(tokens)
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
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


class LocalEmbeddings:
    def embed_documents(self, texts: List[str]) -> List[Dict[str, float]]:
        return [_sparse_vector(t) for t in texts]

    def embed_query(self, text: str) -> Dict[str, float]:
        return _sparse_vector(text)


def _has_key() -> bool:
    return bool(NVIDIA_API_KEY) and "your_" not in NVIDIA_API_KEY and "xxx" not in NVIDIA_API_KEY


def build_llm() -> Optional[Any]:
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
        return NVIDIAEmbeddings(model=NVIDIA_EMBED_MODEL, api_key=NVIDIA_API_KEY, truncate="END")
    return LocalEmbeddings()


def retrieve(embedder: Any, chunks: List[str], query: str, k: int = 5) -> List[Dict[str, Any]]:
    vecs = embedder.embed_documents(chunks)
    qv = embedder.embed_query(query)
    scored = sorted(((_cosine(qv, v), c) for v, c in zip(vecs, chunks)), key=lambda t: t[0], reverse=True)
    return [{"chunk": c, "score": round(float(s), 4)} for s, c in scored[:k]]


# ---------------------------------------------------------------------------
# Graph nodes
# ---------------------------------------------------------------------------

def node_fetch_metrics(state: AgentState) -> AgentState:
    raw = fetch_issue_series(state["owner"], state["repo"], state["weeks"])
    releases = fetch_releases(state["owner"], state["repo"])
    try:
        participation = fetch_commits_participation(state["owner"], state["repo"])
    except requests.HTTPError:
        participation = []
    if participation:
        raw["commit_participation"] = participation
    series, labels = build_weekly_series(raw, state["weeks"])
    return {**state, "raw": raw, "releases": releases, "series": series, "week_labels": labels}


def node_trend_detection(state: AgentState) -> AgentState:
    trends = detect_trends(state["series"], state["week_labels"])
    return {**state, "trends": trends}


def node_drill_down(state: AgentState) -> AgentState:
    chunks = build_chunks(state["raw"], state["series"], state["week_labels"], state["releases"], state["weeks"])
    retrieved: List[Dict[str, Any]] = []

    # query 1: explain the detected trend against the full evidence corpus
    if state["trends"]:
        worst = state["trends"][0]
        trend_query = (
            f"what changed in the last {state['weeks']} weeks around week {worst['change_week']} "
            f"that could explain the {worst['display']} trend: {worst['baseline_value']} -> {worst['recent_value']}"
        )
        for hit in retrieve(state["embedder"], chunks, trend_query, k=5):
            hit["query"] = "trend"
            retrieved.append(hit)

    # query 2: causal side-query against contributor + release evidence only, so
    # capacity signals (a maintainer going quiet) are never out-ranked and cut
    causal_chunks = [c for c in chunks if c.startswith("contributor @") or c.startswith("release")]
    if causal_chunks:
        causal_query = f"which contributors were active or went quiet in the last {state['weeks']} weeks"
        for hit in retrieve(state["embedder"], causal_chunks, causal_query, k=2):
            hit["query"] = "causal"
            retrieved.append(hit)

    # merge, dedupe, keep the best score per chunk, cap at 6
    best: Dict[str, Dict[str, Any]] = {}
    for hit in retrieved:
        chunk = hit["chunk"]
        if chunk not in best or hit["score"] > best[chunk]["score"]:
            best[chunk] = hit
    retrieved = sorted(best.values(), key=lambda h: h["score"], reverse=True)[:6]
    return {**state, "chunks": chunks, "retrieved": retrieved}


def _heuristic_synthesize(state: AgentState) -> Dict[str, Any]:
    trends = state["trends"]
    if not trends:
        return {
            "health_summary": "All tracked metrics are within baseline. No intervention needed this week.",
            "trends": [],
            "causes": [],
            "recommendation": "No action required; include a one-line 'healthy' status in the Weekly Brief.",
            "feeds_weekly_brief": True,
        }
    worst = trends[0]
    causes = []
    for hit in state["retrieved"]:
        if "contributor @" in hit["chunk"] and "last active" in hit["chunk"]:
            causes.append({"cause": "maintainer capacity drop", "evidence": [hit["chunk"]], "confidence": "medium"})
        if "release" in hit["chunk"] and "published" in hit["chunk"]:
            causes.append({"cause": "release-driven activity", "evidence": [hit["chunk"]], "confidence": "low"})
    # capacity vs demand check
    vol = state["series"]["incoming_volume"]
    vol_ratio = _safe_ratio(statistics.median(vol[-2:]), statistics.median(vol[-6:-2]))
    if causes and vol_ratio and vol_ratio < 1.3:
        causes[0]["evidence"].append("incoming issue volume stable (no demand spike)")
        causes[0]["confidence"] = "high"
    if not causes:
        causes = [{"cause": "undetermined — no strong evidence in the changepoint window", "evidence": [], "confidence": "low"}]
    return {
        "health_summary": (
            f"{worst['display']} is worsening from {worst['baseline_value']} to "
            f"{worst['recent_value']} (x{worst['change_ratio']}) around {worst['change_week']}."
        ),
        "trends": trends,
        "causes": causes,
        "recommendation": (
            f"Flag the {worst['display']} inflection in the Weekly Brief. "
            + ("Consider raising the auto-handle threshold to reduce load on remaining maintainers." if any("capacity" in c["cause"] for c in causes) else "")
        ),
        "feeds_weekly_brief": True,
    }


def node_synthesize(state: AgentState) -> AgentState:
    llm = state["llm"]
    if llm is None:
        return {**state, "status": "complete", "result": {"status": "complete", **(_heuristic_synthesize(state))}}

    prompt = (
        "You are the Health-Trend Investigator of a GitHub maintenance platform, producing the Weekly Brief. "
        "Detected trends (JSON) and drill-down evidence retrieved around the changepoint are below. "
        "Reason like an experienced maintainer: distinguish capacity problems from demand problems, "
        "link every cause to specific evidence, and never invent facts.\n\n"
        f"Repository: {state['owner']}/{state['repo']}, window: {state['weeks']} weeks\n\n"
        f"Detected trends:\n{json.dumps(state['trends'], indent=2)}\n\n"
        f"Retrieved changepoint evidence (RAG):\n{json.dumps(state['retrieved'], indent=2)}\n\n"
        "Respond with ONLY JSON:\n"
        '{"health_summary": "<one or two sentences on overall health>", '
        '"trends": [<as given>], '
        '"causes": [{"cause": "<plausible cause>", "evidence": ["<evidence-linked>"], "confidence": "high"|"medium"|"low"}], '
        '"recommendation": "<actionable recommendation for the Weekly Brief>", '
        '"feeds_weekly_brief": true}'
    )
    try:
        raw = llm.invoke([HumanMessage(content=prompt)]).content.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw).strip()
        parsed = json.loads(raw)
        parsed["trends"] = state["trends"]
        return {**state, "status": "complete", "result": {"status": "complete", **parsed}}
    except Exception as exc:
        fallback = _heuristic_synthesize(state)
        return {**state, "status": "complete", "result": {"status": "complete", **fallback}, "error": str(exc)}


def node_finalize(state: AgentState) -> AgentState:
    return state


# ---------------------------------------------------------------------------
# Graph
# ---------------------------------------------------------------------------

def build_graph(owner: str, repo: str, weeks: int, llm: Any, embedder: Any) -> Any:
    def _make_state() -> AgentState:
        return {
            "owner": owner,
            "repo": repo,
            "weeks": weeks,
            "series": {},
            "week_labels": [],
            "trends": [],
            "chunks": [],
            "retrieved": [],
            "result": {},
            "status": "complete",
            "error": None,
            "llm": llm,
            "embedder": embedder,
            "raw": {},
            "releases": [],
        }

    graph = StateGraph(AgentState)
    graph.add_node("fetch_metrics", node_fetch_metrics)
    graph.add_node("trend_detection", node_trend_detection)
    graph.add_node("drill_down", node_drill_down)
    graph.add_node("synthesize", node_synthesize)
    graph.add_node("finalize", node_finalize)

    graph.add_edge(START, "fetch_metrics")
    graph.add_edge("fetch_metrics", "trend_detection")
    graph.add_edge("trend_detection", "drill_down")
    graph.add_edge("drill_down", "synthesize")
    graph.add_edge("synthesize", "finalize")
    graph.add_edge("finalize", END)

    return graph.compile(), _make_state


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def run_health_check(owner: str = GITHUB_OWNER, repo: str = GITHUB_REPO, weeks: int = 12) -> Dict[str, Any]:
    llm = build_llm()
    embedder = build_embedder()
    compiled, make_state = build_graph(owner, repo, weeks, llm, embedder)
    return compiled.invoke(make_state())


def main() -> int:
    parser = argparse.ArgumentParser(description="RepoGuardian Health-Trend Investigator")
    parser.add_argument("--owner", default=GITHUB_OWNER, help="GitHub owner (or set GITHUB_OWNER)")
    parser.add_argument("--repo", default=GITHUB_REPO, help="GitHub repo (or set GITHUB_REPO)")
    parser.add_argument("--weeks", type=int, default=12, help="analysis window in weeks (default 12)")
    args = parser.parse_args()

    if not args.owner or not args.repo:
        print("error: --owner and --repo are required (or set GITHUB_OWNER/GITHUB_REPO)", file=sys.stderr)
        return 1

    mode = "NVIDIA" if _has_key() else "offline (no NVIDIA_API_KEY in .env)"
    print(f"[health-agent] mode: {mode} | {args.owner}/{args.repo}, window {args.weeks} weeks")

    final = run_health_check(owner=args.owner, repo=args.repo, weeks=args.weeks)
    print(json.dumps(final["result"], indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())