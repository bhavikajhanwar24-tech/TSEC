const express = require("express");
const { AgentRun, EscalationDecision } = require("../models");
const { REQUIRED_CATEGORIES, pendingDecision } = require("../agents/escalation_aggregator/aggregator");
const { normalizeCategory } = require("../agents/escalation_aggregator/scoringRules");

const router = express.Router();

router.get("/:issueId/escalation", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { Issue } = require("../models");
    const issue = await Issue.findOne({ where: { id: req.params.issueId } }) || await Issue.findOne({ where: { githubIssueId: String(req.params.issueId) } });
    const resolvedIssueId = issue?.id || req.params.issueId;
    const decision = await EscalationDecision.findOne({ where: { issueId: resolvedIssueId } });
    if (decision) return res.json({ pending: false, ...decision.toJSON() });

    const runs = await AgentRun.findAll({ where: { issueId: resolvedIssueId } });
    return res.json(pendingDecision(runs.filter((run) => REQUIRED_CATEGORIES.has(normalizeCategory(run)))));
  } catch (error) {
    console.error("Escalation decision lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load escalation decision" });
  }
});

module.exports = router;
