const { AgentRun } = require("../models");
const { notifyMaintainersOfEscalation } = require("./notificationService");

async function recordAgentRun({
  issueId,
  agentName,
  category,
  confidence,
  reasoning,
  citedEvidence,
  suggestedAction,
}) {
  const agentRun = await AgentRun.create({
    issueId,
    agentName,
    category,
    confidence,
    reasoning,
    citedEvidence,
    suggestedAction,
  });

  try {
    const relatedIssue = await agentRun.getIssue();
    await notifyMaintainersOfEscalation({
      repoFullName: relatedIssue?.repoFullName,
      category: agentRun.category,
      confidence: agentRun.confidence,
      issue: relatedIssue,
      reasoning: agentRun.reasoning,
      suggestedAction: agentRun.suggestedAction,
      citedEvidence: agentRun.citedEvidence,
      agentName: agentRun.agentName,
    });
  } catch (error) {
    console.error("Failed to process AgentRun notification:", error);
  }

  return agentRun;
}

module.exports = { recordAgentRun };