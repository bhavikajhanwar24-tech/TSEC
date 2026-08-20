import os
import json
from dotenv import load_dotenv
from agent import create_sentiment_graph

# Load environment variables
load_dotenv()

def run_simulation():
    # 1. Define repo norms
    repo_norms = {
        "median_comments_per_pr": 3,
        "median_resolution_days": 4
    }

    # 2. Define the simulated contentious PR #515
    mock_pr = {
        "number": 515,
        "title": "Refactor config loading to use YAML instead of JSON",
        "days_open": 4,
        "state": "open",
        "description": "This PR replaces json-loader with yaml-loader for configuration files to improve readability.",
        "comments": [
            {
                "author": "contributor_alex",
                "created_at": "4 days ago",
                "body": "I've refactored the config loading mechanism to use YAML. It is much cleaner and easier to write than JSON.",
                "is_maintainer": False
            },
            {
                "author": "maintainer_bob",
                "created_at": "3 days ago",
                "body": "Request Changes: This breaks existing config formats. All our customers use JSON configs in production. We can't merge this as is.",
                "is_maintainer": True
            },
            {
                "author": "contributor_alex",
                "created_at": "3 days ago",
                "body": "YAML is standard in modern infrastructure. We shouldn't let backward compatibility block progress. They should just convert their files.",
                "is_maintainer": False
            },
            {
                "author": "maintainer_bob",
                "created_at": "2 days ago",
                "body": "Request Changes: Backward compatibility is non-negotiable for enterprise customers. I will not approve a breaking config migration.",
                "is_maintainer": True
            },
            {
                "author": "contributor_alex",
                "created_at": "1 day ago",
                "body": "Is anyone else on the core team available to weigh in? YAML makes settings files much shorter.",
                "is_maintainer": False
            },
            {
                "author": "maintainer_bob",
                "created_at": "4 hours ago",
                "body": "The policy is clear. We cannot break production systems. Let's not waste more time arguing this.",
                "is_maintainer": True
            }
        ]
    }

    print("==================================================")
    print("Contention / Sentiment Agent Simulation Starting")
    print("==================================================")
    print(f"Sweep Target: PR #{mock_pr['number']} - \"{mock_pr['title']}\"")
    print(f"Comment Volume: {len(mock_pr['comments'])} (Repo Median: {repo_norms['median_comments_per_pr']})")
    print("==================================================")

    # 3. Instantiate the LangGraph
    graph = create_sentiment_graph()

    # 4. Invoke graph
    initial_state = {
        "pr_or_issue": mock_pr,
        "repo_norms": repo_norms,
        "rag_precedents": [],
        "analysis_results": {},
        "summary_report": ""
    }

    final_state = graph.invoke(initial_state)

    # 5. Output results
    report = final_state["summary_report"]
    print("\n--- Sweep Completed Successfully ---\n")
    try:
        print(report)
    except UnicodeEncodeError:
        # Safe printing fallback for Windows terminals not configured for UTF-8
        print(report.encode('ascii', errors='replace').decode('ascii'))

    # Save output to a markdown file
    output_filename = "contention_report.md"
    with open(output_filename, "w", encoding="utf-8") as f:
        f.write(report)
    print(f"\n[SUCCESS] Detailed report written to '{output_filename}' in current directory.")

if __name__ == "__main__":
    run_simulation()
