const express = require("express");
const { AgentRun, EscalationDecision } = require("../models");
const { REQUIRED_CATEGORIES, pendingDecision } = require("../Agents/escalation_aggregator/aggregator");
const { normalizeCategory } = require("../Agents/escalation_aggregator/scoringRules");

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

router.get("/:owner/:repo/escalations", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  try {
    const decisions = await EscalationDecision.findAll({
      where: { needsAttention: true },
      include: [{ model: require("../models").Issue, as: "issue", where: { repoFullName: `${req.params.owner}/${req.params.repo}` } }],
      order: [["createdAt", "DESC"]],
    });
    return res.json({ decisions: decisions.map((decision) => ({ ...decision.toJSON(), issue: decision.issue.toJSON() })) });
  } catch (error) {
    console.error("Escalation queue lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load escalation queue" });
  }
});

router.get("/:issueId/escalation", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { Issue } = require("../models");
    const issue = isUuid(req.params.issueId)
      ? await Issue.findOne({ where: { id: req.params.issueId } })
      : await Issue.findOne({ where: { githubIssueId: String(req.params.issueId) } });
    const resolvedIssueId = issue?.id || req.params.issueId;
    if (!issue) return res.status(404).json({ error: "Issue not found" });
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
