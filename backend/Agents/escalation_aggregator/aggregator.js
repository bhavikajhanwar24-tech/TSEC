const { AgentRun, EscalationDecision } = require("../../models");
const { notifyMaintainersOfEscalation } = require("../../services/notificationService");
const { normalizeCategory, scoreRuns } = require("./scoringRules");

const REQUIRED_CATEGORIES = new Set([
  "duplicate",
  "missing_information",
  "security",
  "sentiment",
  "backlog_context",
  "repository_health",
]);

function pendingDecision(agentRuns) {
  const present = new Set(agentRuns.map(normalizeCategory));
  return {
    pending: true,
    missingCategories: [...REQUIRED_CATEGORIES].filter((category) => !present.has(category)),
    reportedCategories: [...present],
  };
}

async function persistDecision(issueId, decision, notificationSent) {
  const values = {
    issueId,
    needsAttention: decision.needsAttention,
    triggeringCategories: decision.triggeringCategories,
    aggregateConfidence: decision.aggregateConfidence,
    perCategoryBreakdown: decision.perCategoryBreakdown,
    notificationSent,
  };
  const [record] = await EscalationDecision.findOrCreate({ where: { issueId }, defaults: values });
  if (!record.isNewRecord) await record.update(values);
  return record;
}

async function notifyForDecision(issue, agentRuns, decision) {
  if (!decision.needsAttention) return false;
  const triggeredRuns = agentRuns.filter((run) => decision.triggeringCategories.includes(normalizeCategory(run)));
  const results = await Promise.all(triggeredRuns.map((run) => {
    const category = normalizeCategory(run);
    const output = run.output || {};
    return notifyMaintainersOfEscalation({
      repoFullName: issue.repoFullName,
      category: category === "security" ? "security" : category === "repository_health" ? "health_trend" : category === "backlog_context" ? "backlog" : category,
      confidence: category === "security" ? Number(output.danger_score || run.confidence || 0) / (output.danger_score ? 100 : 1) : Number(run.confidence || 0),
      issue,
      reasoning: run.reasoning,
      suggestedAction: run.suggestedAction || output.suggested_action || output.action || "escalate",
      citedEvidence: run.citedEvidence || output.evidence || [],
      agentName: run.agentName,
    });
  }));
  return results.some((result) => Array.isArray(result) && result.some(Boolean));
}

async function evaluateIssueForEscalation(issueId) {
  const agentRuns = await AgentRun.findAll({ where: { issueId } });
  const present = new Set(agentRuns.map(normalizeCategory));
  if (present.size < REQUIRED_CATEGORIES.size || [...REQUIRED_CATEGORIES].some((category) => !present.has(category))) {
    return pendingDecision(agentRuns);
  }

  const decision = scoreRuns(agentRuns);
  const existing = await EscalationDecision.findOne({ where: { issueId } });
  if (existing) return { pending: false, ...existing.toJSON() };
  const issue = agentRuns[0] ? await agentRuns[0].getIssue() : null;
  const notificationSent = issue ? await notifyForDecision(issue, agentRuns, decision) : false;
  const record = await persistDecision(issueId, decision, notificationSent);
  return { ...decision, notificationSent, pending: false, id: record.id };
}

module.exports = { REQUIRED_CATEGORIES, evaluateIssueForEscalation, pendingDecision, persistDecision };
