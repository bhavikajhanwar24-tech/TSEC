import os
import re
import sys
from statistics import median
from typing import Any, Dict, List, Optional, TypedDict

from dotenv import load_dotenv
from langchain_core.prompts import ChatPromptTemplate
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from langgraph.graph import END, START, StateGraph
from pydantic import BaseModel, Field

COMMON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common")
if COMMON_DIR not in sys.path:
    sys.path.insert(0, COMMON_DIR)
import memory_store  # noqa: E402  (shared persistent Chroma memory)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv(os.path.join(BASE_DIR, ".env"))


class ContributorMatch(BaseModel):
    login: str = Field(..., description="GitHub login of the recommended contributor")
    fit_score: float = Field(..., ge=0, le=100, description="Overall contributor fit score")
    confidence: float = Field(..., ge=0, le=1, description="Confidence in the recommendation")
    tech_stack_match: str = Field(..., description="Evidence about languages and paths")
    past_similar_work: str = Field(..., description="Evidence from prior commits and merged PRs")
    median_turnaround_days: Optional[float] = Field(None, description="Median time from first activity to merged PR")
    sentiment_flag: str = Field(..., description="Discussion sentiment signal")
    current_load: str = Field(..., description="Open assigned/authored issue and PR load")
    reasoning: str = Field(..., description="Natural-language evidence-backed recommendation")


class AgentState(TypedDict):
    issue: Dict[str, Any]
    contributors: List[Dict[str, Any]]
    repository: Dict[str, Any]
    memory_context: str
    matches: List[Dict[str, Any]]


prompt_template = ChatPromptTemplate.from_messages([
    ("system", """You are RepoGuardian's Contributor Agent. Rank a repository contributor for the target issue using only the supplied evidence. Favor demonstrated work on the same paths and stack, similar labels or modules, fast completion of merged pull requests, constructive discussion history, and manageable current load. Never invent facts. Keep the score between 0 and 100 and confidence between 0 and 1. Return one structured recommendation.

Target issue:
{issue}

Candidate evidence:
{candidate}

Project memory with similar historical cases:
{memory_context}
"""),
])


def _tokens(value: str) -> set:
    return set(re.findall(r"[a-z0-9_+#.-]+", (value or "").lower()))


def _issue_terms(issue: Dict[str, Any]) -> set:
    labels = " ".join(str(label.get("name", label)) for label in issue.get("labels", []))
    changed_files = " ".join(issue.get("changed_file_hints", []))
    return _tokens(f"{issue.get('title', '')} {issue.get('body', '')} {labels} {changed_files}")


def _path_terms(paths: List[str]) -> set:
    terms = set()
    for path in paths:
        terms.update(_tokens(path.replace("/", " ")))
        extension = os.path.splitext(path)[1].lower().lstrip(".")
        if extension:
            terms.add(extension)
    return terms


def _target_paths(issue: Dict[str, Any]) -> List[str]:
    text = f"{issue.get('title', '')}\n{issue.get('body', '')}"
    paths = re.findall(r"(?:[A-Za-z0-9_.-]+/)*[A-Za-z0-9_.-]+\.(?:py|js|jsx|ts|tsx|java|go|rb|rs|json|yml|yaml|md|css|html)", text)
    paths.extend(issue.get("changed_file_hints", []))
    return list(dict.fromkeys(paths))


def _similarity(left: set, right: set) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / max(1, len(left | right))


def _load_text(candidate: Dict[str, Any]) -> str:
    commits = candidate.get("commits", [])
    prs = candidate.get("merged_prs", [])
    return " ".join(
        [str(p) for commit in commits for p in commit.get("paths", [])]
        + [str(pr.get("title", "")) + " " + str(pr.get("body", "")) + " " + " ".join(pr.get("labels", [])) for pr in prs]
    )


def _sentiment(candidate: Dict[str, Any]) -> tuple[str, float]:
    text = " ".join(str(c.get("body", "")) for pr in candidate.get("merged_prs", []) for c in pr.get("comments", [])).lower()
    hostile = ("hostile", "idiot", "stupid", "shut up", "harass", "threat", "incompetent")
    contentious = ("disagree", "revert", "why did you", "request changes", "doesn't work")
    hostile_hits = sum(text.count(word) for word in hostile)
    contentious_hits = sum(text.count(word) for word in contentious)
    if hostile_hits:
        return "contentious or hostile historical language", min(1.0, 0.35 + hostile_hits * 0.1)
    if contentious_hits:
        return "some disagreement signals; review the thread", min(1.0, 0.15 + contentious_hits * 0.05)
    return "no strong contention signal in sampled threads", 0.0


def _format_candidate(candidate: Dict[str, Any], issue: Dict[str, Any]) -> Dict[str, Any]:
    issue_terms = _issue_terms(issue)
    target_paths = _target_paths(issue)
    candidate_paths = [p for commit in candidate.get("commits", []) for p in commit.get("paths", [])]
    path_overlap = _similarity(_path_terms(target_paths), _path_terms(candidate_paths))
    text_overlap = _similarity(issue_terms, _tokens(_load_text(candidate)))
    languages = candidate.get("languages", {})
    language_match = min(1.0, len(issue_terms & _tokens(" ".join(languages))) / 2) if languages else 0.0
    merged_prs = candidate.get("merged_prs", [])
    durations = [float(p["turnaround_days"]) for p in merged_prs if p.get("turnaround_days") is not None]
    turnaround = round(float(median(durations)), 1) if durations else None
    sentiment_flag, sentiment_penalty = _sentiment(candidate)
    current_load = int(candidate.get("open_assigned_issues", 0)) + int(candidate.get("open_authored_prs", 0))
    tech_score = 0.6 * path_overlap + 0.25 * text_overlap + 0.15 * language_match
    similar_score = min(1.0, 0.55 * text_overlap + 0.45 * min(1.0, len(merged_prs) / 4))
    speed_score = 1.0 if turnaround is None else max(0.0, min(1.0, 1.0 - turnaround / 60.0))
    load_score = max(0.0, 1.0 - current_load / 20.0)
    fit_score = 100 * max(0.0, min(1.0, 0.42 * tech_score + 0.25 * similar_score + 0.15 * speed_score + 0.13 * load_score - 0.05 * sentiment_penalty))
    evidence_confidence = min(1.0, 0.35 + 0.1 * len(candidate_paths) + 0.08 * len(merged_prs))
    reasoning = (
        f"{candidate.get('login')} has {len(candidate_paths)} sampled commit paths with "
        f"{round(path_overlap * 100)}% target-path overlap, {len(merged_prs)} merged PRs in the sampled history, "
        f"{('a ' + str(turnaround) + '-day median turnaround' if turnaround is not None else 'no measurable merged-PR turnaround yet')}, "
        f"{current_load} open assigned/authored items, and {sentiment_flag}."
    )
    return {
        "login": candidate.get("login", "unknown"),
        "fit_score": round(fit_score, 1),
        "confidence": round(evidence_confidence, 2),
        "tech_stack_match": f"{round(tech_score * 100)}% estimated match from repository languages and {round(path_overlap * 100)}% path-token overlap; paths: {', '.join(candidate_paths[:5]) or 'none sampled'}.",
        "past_similar_work": f"{len(merged_prs)} merged PRs sampled; issue/PR text overlap is {round(text_overlap * 100)}%, with labels and module terms included where available.",
        "median_turnaround_days": turnaround,
        "sentiment_flag": sentiment_flag,
        "current_load": f"{current_load} open items ({candidate.get('open_assigned_issues', 0)} assigned issues, {candidate.get('open_authored_prs', 0)} authored PRs).",
        "reasoning": reasoning,
    }


def run_heuristic_analysis(issue: Dict[str, Any], contributors: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Deterministic fallback when NVIDIA is unavailable or fails."""
    matches = [_format_candidate(candidate, issue) for candidate in contributors]
    matches.sort(key=lambda item: (item["fit_score"], item["confidence"]), reverse=True)
    return matches[:10]


def load_memory_node(state: AgentState) -> Dict[str, Any]:
    memory_context = state.get("memory_context", "")
    if not memory_context:
        try:
            embedder = memory_store.build_embedder()
            issue = state["issue"]
            query = f"{issue.get('title', '')}\n{issue.get('body', '')}"
            hits = memory_store.retrieve(state["repository"]["owner"], state["repository"]["repo"], embedder.embed_query(query), k=3, where={"kind": "issue"})
            memory_context = "\n".join(f"- {hit.get('text', '')[:220]}" for hit in hits)
        except Exception:
            memory_context = ""
    return {"memory_context": memory_context}


def rank_node(state: AgentState) -> Dict[str, Any]:
    return {"matches": run_heuristic_analysis(state["issue"], state["contributors"])}


def refine_node(state: AgentState) -> Dict[str, Any]:
    matches = state["matches"]
    api_key = os.getenv("NVIDIA_API_KEY", "")
    if not api_key or api_key == "your_nvidia_api_key_here":
        return {"matches": matches}
    refined = []
    for match in matches[:5]:
        try:
            model = ChatNVIDIA(model=os.getenv("NVIDIA_LLM_MODEL", os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-nano-30b-a3b")), api_key=api_key, temperature=0.1, max_completion_tokens=700)
            result = model.with_structured_output(ContributorMatch).invoke(prompt_template.format(issue=state["issue"], candidate=match, memory_context=state.get("memory_context", "")))
            refined.append(result.model_dump())
        except Exception:
            refined.append(match)
    refined.extend(matches[5:])
    refined.sort(key=lambda item: (item.get("fit_score", 0), item.get("confidence", 0)), reverse=True)
    return {"matches": refined[:10]}


def create_collaborator_graph():
    workflow = StateGraph(AgentState)
    workflow.add_node("load_memory", load_memory_node)
    workflow.add_node("rank_candidates", rank_node)
    workflow.add_node("refine_candidates", refine_node)
    workflow.set_entry_point("load_memory")
    workflow.add_edge("load_memory", "rank_candidates")
    workflow.add_edge("rank_candidates", "refine_candidates")
    workflow.add_edge("refine_candidates", END)
    return workflow.compile()
