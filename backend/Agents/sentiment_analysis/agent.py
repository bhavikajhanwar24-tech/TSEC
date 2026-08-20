import os
import re
from typing import List, Dict, Any, TypedDict
from dotenv import load_dotenv
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import StateGraph, START, END
from pydantic import BaseModel, Field
import requests

# Load environment variables
load_dotenv()

GITHUB_API = "https://api.github.com"
PRECEDENT_STOPWORDS = set("a an the to of for and or in on with about from at by vs replace change use using make made this that refactor into instead config configuration loading loader".split())

# Define the Pydantic schema for Tone Analysis
class ToneAnalysis(BaseModel):
    is_contentious: bool = Field(..., description="True if there is escalating conflict, clipped tone, or repeated disagreement.")
    sentiment_score: float = Field(..., description="Score from -1.0 (hostile/very clipped) to 1.0 (very friendly).")
    contention_indicators: List[str] = Field(..., description="Key phrases or signals indicating contention (e.g., repeated re-opens, change requests).")
    core_disagreement: str = Field(..., description="Concise description of the core disagreement between the parties.")

# Define the Pydantic schema for Final Precedent Synthesis
class SynthesisResult(BaseModel):
    needs_human_judgment: bool = Field(..., description="True if this issue/PR requires manual maintainer intervention.")
    summary: str = Field(..., description="Summary of the disagreement, context, and similarity to past precedent.")
    recommended_action: str = Field(..., description="Actionable next step recommendation based on past precedent.")

# Define the State for the LangGraph
class SentimentState(TypedDict):
    pr_or_issue: Dict[str, Any]
    repo_norms: Dict[str, Any]
    rag_precedents: List[Dict[str, Any]]
    analysis_results: Dict[str, Any]
    summary_report: str
    owner: str
    repo: str

# System Prompt for Tone Analysis
tone_prompt_template = ChatPromptTemplate.from_messages([
    ("system", """You are a repository Contention and Sentiment Analysis Agent. Your task is to analyze the discussion thread of a Pull Request or Issue to detect conflict, clipping, or lack of consensus.

Repository Norms:
- Median comments per PR: {median_comments}
- Typical resolution timeframe: {median_resolution_days} days

PR/Issue details:
- Title: "{title}"
- Total comments: {comment_count}
- Days open: {days_open}
- State: "{state}"

Comment Thread History (chronological):
{comment_history}

Please perform a tone and pattern analysis:
1. Identify if the thread shows signs of contention (clipped language, repeated requests for changes, pushback on decisions, lack of alignment).
2. Measure the overall sentiment score from -1.0 (very contentious/hostile) to 1.0 (very positive/agreeable).
3. Extract the primary disagreement point.
4. List specific contention indicators.
"""),
])

# System Prompt for Synthesis with Precedents (RAG)
synthesis_prompt_template = ChatPromptTemplate.from_messages([
    ("system", """You are a repository Governance Agent. Your task is to synthesize the current PR/Issue dispute analysis with historical precedents retrieved from our RAG database.

Current Dispute Analysis:
- Core Disagreement: {core_disagreement}
- Contention Level: {contention_level}
- Indicators: {indicators}

Relevant Historical Precedents (from RAG):
{precedents}

Please compare the current dispute against historical resolutions:
1. Determine if this needs human maintainer judgment.
2. Outline a summary comparison (e.g. "Similar dispute in #X resolved by Y").
3. Recommend the best resolution path matching our historical conventions.
"""),
])

def run_heuristic_tone_analysis(pr_or_issue: Dict[str, Any], repo_norms: Dict[str, Any]) -> Dict[str, Any]:
    """Heuristic analyzer when LLM is unavailable or fails."""
    comments = pr_or_issue.get("comments", [])
    comment_count = len(comments)
    median_comments = repo_norms.get("median_comments_per_pr", 3)
    days_open = pr_or_issue.get("days_open", 1)
    
    is_contentious = False
    sentiment_score = 0.0
    indicators = []
    core_disagreement = "No active contention detected."
    
    # 1. Check volume spike
    if comment_count > median_comments * 3:
        is_contentious = True
        sentiment_score -= 0.3
        indicators.append(f"Comment volume spike ({comment_count} comments vs repo median of {median_comments})")
        
    # 2. Check tone indicators in comments (e.g. clipped or disagreement words)
    disagree_keywords = ["don't agree", "disagree", "breaking", "backward compatibility", "why did you", "clipped", "revert"]
    change_request_count = 0
    
    for c in comments:
        body = c.get("body", "").lower()
        if "request" in body and "change" in body:
            change_request_count += 1
        for kw in disagree_keywords:
            if kw in body:
                indicators.append(f"Disagreement keyword found: '{kw}'")
                is_contentious = True
                sentiment_score -= 0.15
                
    if change_request_count >= 2:
        is_contentious = True
        sentiment_score -= 0.2
        indicators.append(f"Multiple changes requested ({change_request_count}) without approval")

    # 3. Formulate core disagreement based on keywords
    title = pr_or_issue.get("title", "").lower()
    if is_contentious:
        if "yaml" in title or "json" in title:
            core_disagreement = "Disagreement on refactoring config loading format (YAML vs JSON) and potential breaking changes in production."
        else:
            core_disagreement = f"Disagreement on PR implementation: '{pr_or_issue.get('title')}' after {comment_count} comments."
            
    sentiment_score = max(-1.0, min(1.0, sentiment_score))
    
    return {
        "is_contentious": is_contentious,
        "sentiment_score": sentiment_score,
        "contention_indicators": list(set(indicators)),
        "core_disagreement": core_disagreement
    }

def analyze_activity_tone_node(state: SentimentState) -> Dict[str, Any]:
    """Evaluates discussion volume, frequency, and tone for contention indicators."""
    pr = state["pr_or_issue"]
    norms = state["repo_norms"]
    comments = pr.get("comments", [])
    
    # Format comments
    comment_history_str = ""
    for c in comments:
        comment_history_str += f"- Author: {c.get('author', 'unknown')} ({c.get('created_at', 'unknown')})\n  Body: {c.get('body', '')}\n\n"
    if not comment_history_str:
        comment_history_str = "(No comments posted yet)"
        
    api_key = os.getenv("NVIDIA_API_KEY")
    is_mock = not api_key or api_key == "your_nvidia_api_key_here"
    
    analysis = None
    if not is_mock:
        try:
            model_name = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b")
            print(f"[INFO] Analyzing PR/Issue #{pr.get('number')} tone using model: {model_name}...")
            llm = ChatNVIDIA(model=model_name, api_key=api_key, temperature=0.1)
            structured_llm = llm.with_structured_output(ToneAnalysis)
            
            prompt = tone_prompt_template.format(
                median_comments=norms.get("median_comments_per_pr", 3),
                median_resolution_days=norms.get("median_resolution_days", 4),
                title=pr.get("title"),
                comment_count=len(comments),
                days_open=pr.get("days_open", 0),
                state=pr.get("state", "open"),
                comment_history=comment_history_str
            )
            
            res_pydantic = structured_llm.invoke(prompt)
            analysis = {
                "is_contentious": res_pydantic.is_contentious,
                "sentiment_score": res_pydantic.sentiment_score,
                "contention_indicators": res_pydantic.contention_indicators,
                "core_disagreement": res_pydantic.core_disagreement
            }
        except Exception as e:
            print(f"[WARNING] LLM Tone Analysis failed: {e}. Falling back to heuristics.")
            is_mock = True
            
    if is_mock:
        print(f"[INFO] Analyzing PR/Issue #{pr.get('number')} tone using heuristics...")
        analysis = run_heuristic_tone_analysis(pr, norms)
        
    return {
        "analysis_results": analysis
    }

def search_precedents_node(state: SentimentState) -> Dict[str, Any]:
    """Retrieves real historical precedents from the repo via GitHub search:
    closed PRs/issues with titles overlapping the current dispute's keywords.
    No data here is hardcoded — if retrieval is impossible it returns no
    precedents rather than fabricating any."""
    pr = state["pr_or_issue"]
    owner = state.get("owner")
    repo = state.get("repo")
    token = os.environ.get("GITHUB_TOKEN", "")

    if not (owner and repo and token):
        return {"rag_precedents": []}

    title_words = [w for w in re.findall(r"[a-z0-9]+", pr.get("title", "").lower()) if w not in PRECEDENT_STOPWORDS]
    keywords = " ".join(title_words[:5]) or "bug"
    query = f"repo:{owner}/{repo} type:pr state:closed {keywords} in:title"
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "RepoGuardian-SentimentAgent",
    }
    try:
        response = requests.get(f"{GITHUB_API}/search/issues", params={"q": query, "per_page": 5}, headers=headers, timeout=30)
        response.raise_for_status()
        items = [i for i in response.json().get("items", []) if i["number"] != pr.get("number")]
    except (requests.RequestException, ValueError):
        return {"rag_precedents": []}

    precedents = []
    for item in items[:3]:
        body = item.get("body") or "(no description)"
        resolution = f"Closed on {item.get('closed_at', 'unknown')[:10]} as {item.get('state_reason') or item.get('state')}."
        try:
            comments = requests.get(item["comments_url"], headers=headers, timeout=30).json()
            if comments:
                resolution += f" Last comment: {comments[-1].get('body', '')[:200]}"
        except requests.RequestException:
            pass
        precedents.append(
            {
                "id": item["number"],
                "year": (item.get("created_at") or "")[:4],
                "title": item["title"],
                "dispute": body[:300],
                "resolution": resolution,
            }
        )
    return {"rag_precedents": precedents}

def synthesize_findings_node(state: SentimentState) -> Dict[str, Any]:
    """Compares the current dispute analysis with past RAG precedents and writes a report."""
    pr = state["pr_or_issue"]
    analysis = state["analysis_results"]
    precedents = state["rag_precedents"]
    
    precedents_str = ""
    for idx, p in enumerate(precedents):
        precedents_str += f"{idx+1}. Precedent #{p['id']} ({p['year']}): '{p['title']}'\n   Dispute: {p['dispute']}\n   Resolution: {p['resolution']}\n\n"
        
    if not precedents_str:
        precedents_str = "(No relevant historical precedents found in RAG database)"
        
    api_key = os.getenv("NVIDIA_API_KEY")
    is_mock = not api_key or api_key == "your_nvidia_api_key_here"
    
    synthesis = None
    if not is_mock:
        try:
            model_name = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b")
            print(f"[INFO] Synthesizing findings and precedents using model: {model_name}...")
            llm = ChatNVIDIA(model=model_name, api_key=api_key, temperature=0.1)
            structured_llm = llm.with_structured_output(SynthesisResult)
            
            prompt = synthesis_prompt_template.format(
                core_disagreement=analysis.get("core_disagreement"),
                contention_level=f"High (Score: {analysis.get('sentiment_score')})" if analysis.get("is_contentious") else "Low",
                indicators=", ".join(analysis.get("contention_indicators", [])),
                precedents=precedents_str
            )
            
            res_pydantic = structured_llm.invoke(prompt)
            synthesis = {
                "needs_human_judgment": res_pydantic.needs_human_judgment,
                "summary": res_pydantic.summary,
                "recommended_action": res_pydantic.recommended_action
            }
        except Exception as e:
            print(f"[WARNING] LLM Precedent Synthesis failed: {e}. Falling back to heuristics.")
            is_mock = True
            
    if is_mock:
        print("[INFO] Synthesizing findings and precedents using heuristics...")
        # Heuristic synthesis mapping
        needs_human = analysis.get("is_contentious", False)
        summary = ""
        rec_action = ""
        
        if precedents:
            p = precedents[0]
            summary = (
                f"Unresolved disagreement on '{pr.get('title')}': "
                f"{analysis.get('core_disagreement')}. "
                f"A similar historical precedent exists in PR #{p['id']} ({p['year']}): '{p['title']}'."
            )
            rec_action = f"Flagged for human maintainer decision. Precedent #{p['id']} was {p['resolution']} Suggest reviewing how that case was closed and applying the same approach."
        else:
            summary = f"Discussion on PR #{pr.get('number')} has high comment volume. Core issue: {analysis.get('core_disagreement')}."
            rec_action = "No direct precedent found. Flagged for review due to contention indicators."
            
        synthesis = {
            "needs_human_judgment": needs_human,
            "summary": summary,
            "recommended_action": rec_action
        }
        
    # Generate final report
    report = "# Contention & Sentiment Analysis Sweep\n\n"
    report += f"### PR/Issue #{pr.get('number')}: \"{pr.get('title')}\"\n"
    report += f"- **Needs Human Judgment:** {'🚨 **YES**' if synthesis['needs_human_judgment'] else '✅ **NO**'}\n"
    report += f"- **Sentiment Score:** {analysis.get('sentiment_score')} (Range: -1.0 to 1.0)\n"
    report += f"- **Core Disagreement:** {analysis.get('core_disagreement')}\n"
    report += f"- **Contention Signals:** {', '.join(analysis.get('contention_indicators', []))}\n\n"
    report += "## Precedent & Resolution Summary\n"
    report += f"{synthesis['summary']}\n\n"
    report += "## Recommended Next Steps\n"
    report += f"{synthesis['recommended_action']}\n"
    
    return {
        "summary_report": report
    }

def create_sentiment_graph():
    """Builds and compiles the LangGraph StateGraph workflow."""
    workflow = StateGraph(SentimentState)
    
    # Add nodes
    workflow.add_node("analyze_activity_tone", analyze_activity_tone_node)
    workflow.add_node("search_precedents", search_precedents_node)
    workflow.add_node("synthesize_findings", synthesize_findings_node)
    
    # Establish simple linear state sequence
    workflow.set_entry_point("analyze_activity_tone")
    workflow.add_edge("analyze_activity_tone", "search_precedents")
    workflow.add_edge("search_precedents", "synthesize_findings")
    workflow.add_edge("synthesize_findings", END)
    
    return workflow.compile()
