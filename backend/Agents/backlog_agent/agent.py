import json
import os
import sys
from typing import List, Dict, Any, TypedDict, Literal
from dotenv import load_dotenv
from langchain_nvidia_ai_endpoints import ChatNVIDIA
from langchain_core.prompts import ChatPromptTemplate
from langgraph.graph import StateGraph, START, END
from pydantic import BaseModel, Field

COMMON_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "common")
if COMMON_DIR not in sys.path:
    sys.path.insert(0, COMMON_DIR)
import memory_store  # noqa: E402  (shared persistent Chroma memory)

# Load environment variables (shared backend .env, then optional local .env)
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.dirname(os.path.dirname(BASE_DIR))
load_dotenv(os.path.join(BACKEND_DIR, ".env"))
load_dotenv(os.path.join(BASE_DIR, ".env"))

# Define the structured output model for the LLM
class IssueAnalysis(BaseModel):
    issue_number: int = Field(..., description="The GitHub issue number")
    is_blocked: bool = Field(..., description="Whether the issue is currently blocked")
    blocked_by: Literal["reporter", "maintainer", "none"] = Field(..., description="Who the issue is blocked on")
    action_recommendation: Literal["nudge_reporter", "auto_close", "escalate", "keep_open"] = Field(..., description="Recommended action")
    reasoning: str = Field(..., description="Reasoning for the recommended action based on repo norms and comments")
    suggested_comment: str = Field(..., description="Drafted comment to post on the issue")

# Define the state structure for the LangGraph
class AgentState(TypedDict):
    issues: List[Dict[str, Any]]
    repo_norms: Dict[str, Any]
    analysis_results: List[Dict[str, Any]]
    current_index: int
    summary_report: str
    owner: str
    repo: str
    memory_context: str

# System prompt template for analyzing issues
prompt_template = ChatPromptTemplate.from_messages([
    ("system", """You are a repository Staleness and Backlog Agent. Your task is to analyze a GitHub issue's activity history and determine the next action based on repo rules and median times.

Repository Guidelines:
- Repo Median Response Time: {median_response_days} days
- Auto-Close Policy: {auto_close_policy}
- General Conventions: {general_conventions}

Issue to Analyze:
- Issue #{issue_number}: "{issue_title}"
- Days since last activity: {last_activity_days}
- Issue Description: {issue_description}

Comment History (in chronological order):
{comment_history}

Similar past issues and how they were classified (from project memory, optional context):
{memory_context}

Please analyze this issue step-by-step:
1. Determine if the issue is currently blocked on the reporter (e.g., maintainer asked for a reproduction/minimal repro/logs/more info, and the reporter hasn't replied yet) vs. blocked on the maintainer (e.g., reporter provided feedback or opened a bug and no maintainer has replied in a timely manner).
2. Compare the days since last activity/maintainer's request against the repository's norms and auto-close policy.
3. Suggest the appropriate action:
   - 'nudge_reporter': Waiting on reporter feedback, stale but within the threshold. Suggest a friendly nudge.
   - 'auto_close': Stale and reporter-blocked, and the delay exceeds the project norm (e.g., auto-close after 30 days of no reporter response).
   - 'escalate': Stale, but blocked on the maintainer (maintainer has not replied, exceeding median response times), or it is stale and high priority.
   - 'keep_open': Active, or there is no need for automation yet.
4. Formulate a polite, professional, and helpful comment template matching the project's friendly tone.
"""),
])

def load_norms_node(state: AgentState) -> Dict[str, Any]:
    """Node that initializes repository norms if not already provided."""
    norms = state.get("repo_norms", {})
    if "median_response_time_days" not in norms:
        norms["median_response_time_days"] = 6
    if "auto_close_threshold_days" not in norms:
        norms["auto_close_threshold_days"] = 30
    if "contributing_guidelines" not in norms:
        norms["contributing_guidelines"] = "Auto-close issues after 30 days of no reporter response to maintainer inquiries."
    if "general_conventions" not in norms:
        norms["general_conventions"] = "Be polite, encourage reporters to reopen if they can provide reproduction steps later."
        
    return {
        "repo_norms": norms,
        "current_index": 0,
        "analysis_results": [],
        "memory_context": state.get("memory_context", ""),
        "owner": state.get("owner", ""),
        "repo": state.get("repo", ""),
    }

def run_heuristic_analysis(issue: Dict[str, Any], repo_norms: Dict[str, Any]) -> Dict[str, Any]:
    """Heuristic fallback when the LLM is not configured or fails."""
    issue_number = issue.get("number")
    last_activity_days = issue.get("last_activity_days", 0)
    comments = issue.get("comments", [])
    
    is_blocked = False
    blocked_by = "none"
    reasoning = ""
    action = "keep_open"
    suggested_comment = ""
    
    if comments:
        last_comment = comments[-1]
        last_author = last_comment.get("author", "unknown").lower()
        last_body = last_comment.get("body", "").lower()
        
        # Simple heuristic to identify maintainer request
        is_maintainer = (
            "maintainer" in last_author 
            or "collaborator" in last_author 
            or "admin" in last_author 
            or last_comment.get("is_maintainer", False)
        )
        is_question = "?" in last_body or "can you" in last_body or "please share" in last_body or "repro" in last_body or "provide" in last_body
        
        if is_maintainer and is_question:
            is_blocked = True
            blocked_by = "reporter"
            reasoning = f"The last activity was a maintainer request for details/repro. The reporter hasn't responded in {last_activity_days} days."
        elif not is_maintainer:
            is_blocked = True
            blocked_by = "maintainer"
            reasoning = f"The last activity was from reporter/user. Maintainers haven't responded in {last_activity_days} days."
        else:
            reasoning = f"Issue is inactive for {last_activity_days} days. Last activity was maintainer comment: '{last_comment.get('body')[:40]}...'"
    else:
        is_blocked = True
        blocked_by = "maintainer"
        reasoning = f"The issue was created {last_activity_days} days ago and has 0 comments."

    threshold = repo_norms.get("auto_close_threshold_days", 30)
    median_time = repo_norms.get("median_response_time_days", 6)
    
    if blocked_by == "reporter" and last_activity_days >= threshold:
        action = "auto_close"
        suggested_comment = f"Hi @reporter, this issue has been automatically closed because there has been no response to our request for more information within {threshold} days. Please feel free to reopen this issue with the requested details if you can still reproduce the problem. Thank you!"
    elif blocked_by == "reporter" and last_activity_days >= threshold / 2:
        action = "nudge_reporter"
        suggested_comment = f"Hi @reporter, just nudging you on this issue. We need the requested details to investigate further. If you're still experiencing this, could you please provide the information? Thanks!"
    elif blocked_by == "maintainer" and last_activity_days >= median_time * 3:
        action = "escalate"
        suggested_comment = f"Attention @maintainers: Issue #{issue_number} has been waiting for feedback/response for {last_activity_days} days, exceeding the repo's median response time of {median_time} days."
    else:
        action = "keep_open"
        suggested_comment = ""
        
    return {
        "issue_number": issue_number,
        "is_blocked": is_blocked,
        "blocked_by": blocked_by,
        "action_recommendation": action,
        "reasoning": reasoning,
        "suggested_comment": suggested_comment
    }

def analyze_issue_node(state: AgentState) -> Dict[str, Any]:
    """Node that evaluates the current issue using ChatNVIDIA or Heuristic fallback."""
    issues = state["issues"]
    idx = state["current_index"]
    repo_norms = state["repo_norms"]
    
    if idx >= len(issues):
        return {}
        
    issue = issues[idx]
    comments = issue.get("comments", [])
    comment_history_str = ""
    for c in comments:
        comment_history_str += f"- Author: {c.get('author', 'unknown')} ({c.get('created_at', 'unknown')})\n  Body: {c.get('body', '')}\n\n"
        
    if not comment_history_str:
        comment_history_str = "(No comments on this issue yet)"

    # Retrieve similar past issues from the shared project memory so the
    # analysis can reference how comparable stale issues were handled.
    memory_context = state.get("memory_context", "")
    owner = state.get("owner", "")
    repo = state.get("repo", "")
    if not memory_context and owner and repo:
        try:
            embedder = memory_store.build_embedder()
            query_text = f"{issue.get('title', '')}\n{issue.get('description', '')}"
            hits = memory_store.retrieve(owner, repo, embedder.embed_query(query_text), k=3, where={"kind": "issue"})
            memory_context = "\n".join(
                f"- issue #{h['metadata'].get('number', '?')}: "
                f"blocked_by={h['metadata'].get('blocked_by', '?')}, "
                f"action={h['metadata'].get('action_recommendation', '?')} — {h['text'][:160]}"
                for h in hits
            ) or "(no similar issues in memory yet)"
        except Exception:
            memory_context = "(memory unavailable)"
        
    api_key = os.getenv("NVIDIA_API_KEY")
    is_mock = not api_key or api_key == "your_nvidia_api_key_here"
    
    analysis = None
    if not is_mock:
        try:
            model_name = os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-ultra-550b-a55b")
            print(f"[INFO] Analyzing Issue #{issue.get('number')} using NVIDIA Model: {model_name}...")
            llm = ChatNVIDIA(
                model=model_name,
                api_key=api_key,
                temperature=0.1,
                max_completion_tokens=4096
            )
            structured_llm = llm.with_structured_output(IssueAnalysis)
            
            prompt = prompt_template.format(
                median_response_days=repo_norms["median_response_time_days"],
                auto_close_policy=repo_norms["contributing_guidelines"],
                general_conventions=repo_norms["general_conventions"],
                issue_number=issue.get("number"),
                issue_title=issue.get("title"),
                last_activity_days=issue.get("last_activity_days"),
                issue_description=issue.get("description", "(No description)"),
                comment_history=comment_history_str,
                memory_context=memory_context
            )
            
            analysis_pydantic = structured_llm.invoke(prompt)
            analysis = {
                "issue_number": analysis_pydantic.issue_number,
                "is_blocked": analysis_pydantic.is_blocked,
                "blocked_by": analysis_pydantic.blocked_by,
                "action_recommendation": analysis_pydantic.action_recommendation,
                "reasoning": analysis_pydantic.reasoning,
                "suggested_comment": analysis_pydantic.suggested_comment
            }
        except Exception as e:
            print(f"[WARNING] NVIDIA LLM analysis failed: {e}. Falling back to Heuristic analysis.")
            is_mock = True
            
    if is_mock:
        print(f"[INFO] Analyzing Issue #{issue.get('number')} using heuristic analysis rules...")
        analysis = run_heuristic_analysis(issue, repo_norms)

    # Remember this issue and its classification in the shared project memory
    # so future sweeps can reference comparable cases. Never blocks.
    if owner and repo:
        try:
            embedder = memory_store.build_embedder()
            issue_text = f"{issue.get('title', '')}\n{issue.get('description', '')}\n{comment_history_str}"
            memory_store.ingest(
                owner,
                repo,
                [
                    {
                        "id": f"issue-{issue.get('number', '')}",
                        "text": issue_text,
                        "embedding": embedder.embed_query(issue_text),
                        "metadata": {
                            "kind": "issue",
                            "number": issue.get("number", 0),
                            "state": "open",
                            "blocked_by": analysis.get("blocked_by", "none"),
                            "action_recommendation": analysis.get("action_recommendation", "keep_open"),
                            "last_activity_days": issue.get("last_activity_days", 0),
                        },
                    }
                ],
            )
        except Exception:
            pass

    new_results = list(state.get("analysis_results", []))
    new_results.append(analysis)
    
    return {
        "analysis_results": new_results,
        "current_index": idx + 1,
        "memory_context": memory_context,
    }

def router_edge(state: AgentState) -> str:
    """Decides if we have more issues to analyze or if we are finished."""
    if state["current_index"] < len(state["issues"]):
        return "continue"
    return "end"

def generate_report_node(state: AgentState) -> Dict[str, Any]:
    """Compiles all recommendations into a clean markdown sweep report."""
    results = state["analysis_results"]
    repo_norms = state["repo_norms"]
    
    report = "# Staleness & Backlog Sweep Report\n\n"
    report += f"**Repository Median Response Time:** {repo_norms['median_response_time_days']} days  \n"
    report += f"**Reporter Inactivity Auto-Close Threshold:** {repo_norms['auto_close_threshold_days']} days  \n"
    report += f"**Total Issues Evaluated:** {len(results)}\n\n"
    
    report += "## Recommended Actions\n\n"
    
    for r in results:
        action_emoji = {
            "auto_close": "⚠️ **Auto-Close**",
            "nudge_reporter": "💬 **Nudge Reporter**",
            "escalate": "🚨 **Escalate**",
            "keep_open": "✅ **Keep Open**"
        }.get(r["action_recommendation"], r["action_recommendation"])
        
        report += f"### Issue #{r['issue_number']}: {action_emoji}\n"
        report += f"- **Is Blocked:** {'Yes' if r['is_blocked'] else 'No'} (Blocked by: `{r['blocked_by']}`)\n"
        report += f"- **Reasoning:** {r['reasoning']}\n"
        if r['suggested_comment']:
            report += f"- **Suggested Comment/Action:**\n  ```\n  {r['suggested_comment']}\n  ```\n"
        report += "\n---\n\n"
        
    return {
        "summary_report": report
    }

def create_backlog_graph():
    """Builds and compiles the LangGraph StateGraph workflow."""
    workflow = StateGraph(AgentState)
    
    # Add nodes
    workflow.add_node("load_norms", load_norms_node)
    workflow.add_node("analyze_issue", analyze_issue_node)
    workflow.add_node("generate_report", generate_report_node)
    
    # Establish edges
    workflow.set_entry_point("load_norms")
    workflow.add_edge("load_norms", "analyze_issue")
    
    workflow.add_conditional_edges(
        "analyze_issue",
        router_edge,
        {
            "continue": "analyze_issue",
            "end": "generate_report"
        }
    )
    
    workflow.add_edge("generate_report", END)
    
    return workflow.compile()
