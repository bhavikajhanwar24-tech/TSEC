import os
import json
from dotenv import load_dotenv
from agent import create_backlog_graph

# Load env file
load_dotenv()

def run_simulation():
    # 1. Define repository-wide norms
    repo_norms = {
        "median_response_time_days": 6,
        "auto_close_threshold_days": 30,
        "contributing_guidelines": (
            "Auto-close issues after 30 days of no reporter response to maintainer inquiries."
        ),
        "general_conventions": (
            "Suggest auto-closing with a friendly 'reopen if you can still reproduce this' comment. "
            "Low risk to auto-action."
        )
    }

    # 2. Define mock issues for sweep evaluation
    mock_issues = [
        {
            "number": 390,
            "title": "Application crashes on startup during database initialization",
            "last_activity_days": 45,
            "description": "When launching the server in a Docker container, it crashes with a database pool error.",
            "comments": [
                {
                    "author": "reporter_user",
                    "created_at": "48 days ago",
                    "body": "Here is the stack trace. Please look into it.",
                    "is_maintainer": False
                },
                {
                    "author": "maintainer_jane",
                    "created_at": "45 days ago",
                    "body": "Can you share a minimal repro? It works fine on our default templates.",
                    "is_maintainer": True
                }
            ]
        },
        {
            "number": 391,
            "title": "Typo in documentation for installation guide",
            "last_activity_days": 2,
            "description": "The installation guide says 'npm install repo-guardian' instead of 'npm i repo-guardian'.",
            "comments": [
                {
                    "author": "reporter_user",
                    "created_at": "2 days ago",
                    "body": "Simple typo in readme, I can make a PR if you want.",
                    "is_maintainer": False
                }
            ]
        },
        {
            "number": 392,
            "title": "Adding custom filters to webhook event payload",
            "last_activity_days": 18,
            "description": "It would be great to filter out webhook events that don't match specific label configurations.",
            "comments": [
                {
                    "author": "maintainer_jane",
                    "created_at": "18 days ago",
                    "body": "Could you provide a sample event payload you'd want to exclude?",
                    "is_maintainer": True
                }
            ]
        },
        {
            "number": 393,
            "title": "Memory leak detected when processing large webhook arrays",
            "last_activity_days": 20,
            "description": "Node process memory increases linearly by 10MB per 1000 webhooks received.",
            "comments": [
                {
                    "author": "reporter_user",
                    "created_at": "20 days ago",
                    "body": "Here is the heap dump link. I've stopped using the batch mode for now.",
                    "is_maintainer": False
                }
            ]
        }
    ]

    print("==================================================")
    print("Staleness & Backlog Agent Sweep Simulation Starting")
    print("==================================================")
    print(f"Sweep Config:")
    print(f" - Repo Median Response Time: {repo_norms['median_response_time_days']} days")
    print(f" - Auto-Close Threshold: {repo_norms['auto_close_threshold_days']} days")
    print(f" - Number of Issues to Sweep: {len(mock_issues)}")
    print("==================================================")

    # 3. Instantiate LangGraph
    graph = create_backlog_graph()

    # 4. Invoke graph with initial state
    initial_state = {
        "issues": mock_issues,
        "repo_norms": repo_norms,
        "analysis_results": [],
        "current_index": 0,
        "summary_report": ""
    }

    final_state = graph.invoke(initial_state)

    # 5. Output results
    report = final_state["summary_report"]
    print("\n--- Sweep Completed Successfully ---\n")
    try:
        print(report)
    except UnicodeEncodeError:
        # Fallback for Windows consoles not configured for UTF-8
        print(report.encode('ascii', errors='replace').decode('ascii'))

    # Write the report to a local markdown file for inspection
    output_filename = "sweep_report.md"
    with open(output_filename, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\n[SUCCESS] Detailed report written to '{output_filename}' in current directory.")

if __name__ == "__main__":
    run_simulation()
