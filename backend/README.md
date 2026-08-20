## Contributor Agent (Optional Seventh Agent)

The manually triggered Contributor Agent recommends repository contributors for a specific issue. It compares the issue's labels, text, and file-path hints with repository language statistics, recent commit paths, merged pull-request history, turnaround time, discussion sentiment, and current open issue/PR load. It returns ranked candidates with fit scores, confidence, evidence fields, and a natural-language justification.

Implementation: `backend/Agents/collabator/`

Trigger it with `POST /api/agents/contributor-match` using `{ owner, repo, issueNumber }`. It is an on-demand issue-detail recommendation and is intentionally not part of `workflowService.js`, the escalation aggregator, or the six-agent workflow. Results are not persisted in v1; assignment, duplicate closure, and undo actions remain maintainer-controlled.
