# Contributor Agent

The Contributor Agent ranks repository contributors for a GitHub issue using repository language statistics, changed paths, recent commit history, merged pull requests, discussion sentiment, and current open work. It returns an evidence-backed list rather than making an assignment or changing GitHub state.

It is manually triggered through `POST /api/agents/contributor-match` and is not part of the six-agent escalation workflow. Results are not persisted in v1. If NVIDIA is unavailable, the agent uses deterministic scoring and still returns a useful recommendation.

Run directly with JSON on stdin:

```bash
python serve.py <<'JSON'
{"owner":"octocat","repo":"Hello-World","issue_number":1}
JSON
```
