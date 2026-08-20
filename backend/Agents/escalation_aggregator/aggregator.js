const { AgentRun, EscalationDecision, Issue } = require("../../models");
const { notifyMaintainersOfEscalation } = require("../../services/notificationService");
const { normalizeCategory, scoreRuns } = require("./scoringRules");

async function repoThreshold(repoFullName) {
  if (!repoFullName) return 0.6;
  try {
    const { Feedback } = require("../../models");
    const feedback = await Feedback.findAll({ where: { repoFullName }, attributes: ["verdict"] });
    const reviewed = feedback.filter((item) => item.verdict);
    const corrected = reviewed.filter((item) => item.verdict === "corrected").length;
    return reviewed.length >= 3 && corrected / reviewed.length >= 0.25 ? 0.75 : 0.6;
  } catch (error) {
    console.error("Repo calibration lookup failed:", error.message);
    return 0.6;
  }
}

const REQUIRED_CATEGORIES = new Set([
  "duplicate",
  "missing_information",
  "security",
  "sentiment",
  "backlog_context",
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
    urgency: decision.urgency,
    isDuplicateHotspot: decision.isDuplicateHotspot,
    duplicateHotspotCount: decision.duplicateHotspotCount,
    urgencyReasons: decision.urgencyReasons,
    triggeringEvent: decision.triggeringEvent,
    retrievedEvidence: decision.retrievedEvidence,
    reasoningTrace: decision.reasoningTrace,
    finalAction: decision.finalAction,
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
  const completedRuns = agentRuns.filter((run) => run.status === "complete");
  const present = new Set(completedRuns.map(normalizeCategory));
  const duplicateFailed = agentRuns.some((run) => normalizeCategory(run) === "duplicate" && run.status === "failed");
  if (!duplicateFailed && (present.size < REQUIRED_CATEGORIES.size || [...REQUIRED_CATEGORIES].some((category) => !present.has(category)))) {
    return pendingDecision(completedRuns);
  }

  const issue = agentRuns[0] ? await agentRuns[0].getIssue() : null;
  const repoRuns = issue ? await AgentRun.findAll({
    include: [{ model: Issue, as: "issue", where: { repoFullName: issue.repoFullName } }],
    where: { agentName: "duplicate" },
  }) : [];
  const duplicateHotspotCount = repoRuns.filter((run) => {
    const output = run.output || {};
    return run.issue?.state === "open" && (output.is_direct_duplicate || output.suggested_action === "link_open_issue");
  }).length;
  const isDuplicateHotspot = duplicateHotspotCount >= 3;
  const threshold = await repoThreshold(issue?.repoFullName);
  const decision = scoreRuns(completedRuns.length ? completedRuns : agentRuns, { duplicateHotspotCount, isDuplicateHotspot, threshold });
  decision.triggeringEvent = { type: "github_issue_workflow", sourceId: issue.githubIssueId, timestamp: new Date().toISOString(), repoFullName: issue.repoFullName };
  decision.retrievedEvidence = agentRuns.flatMap((run) => Array.isArray(run.citedEvidence) ? run.citedEvidence : []);
  decision.reasoningTrace = agentRuns.flatMap((run) => Array.isArray(run.reasoningTrace) ? run.reasoningTrace : [run.reasoning]).filter(Boolean);
  decision.finalAction = decision.needsAttention ? "escalate" : "no_action";
  const existing = await EscalationDecision.findOne({ where: { issueId } });
  if (existing) return { pending: false, ...existing.toJSON() };
  const notificationSent = issue ? await notifyForDecision(issue, agentRuns, decision) : false;
  const record = await persistDecision(issueId, decision, notificationSent);
  return { ...decision, notificationSent, pending: false, id: record.id };
}

module.exports = { REQUIRED_CATEGORIES, evaluateIssueForEscalation, pendingDecision, persistDecision, repoThreshold };
