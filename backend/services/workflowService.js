const { Issue, AgentRun, IssueTimeline } = require("../models");
const { indexDocuments } = require("./ragService");

const fallbackIssues = new Map();
const fallbackRuns = new Map();

function key(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

async function ensureIssue(issue, owner, repo) {
  const issueKey = key(owner, repo, issue.number);
  const values = {
    githubIssueId: String(issue.id || issue.number),
    repoFullName: `${owner}/${repo}`,
    number: issue.number,
    title: issue.title || "Untitled issue",
    body: issue.body || "",
    author: issue.user?.login || "unknown",
    state: issue.state || "open",
    isPullRequest: Boolean(issue.pull_request),
    closedAt: issue.closed_at || null,
  };
  try {
    const [record] = await Issue.findOrCreate({ where: { repoFullName: values.repoFullName, number: values.number }, defaults: values });
    await record.update(values);
    return record;
  } catch (error) {
    console.error("Workflow database issue write failed:", error.message);
    const current = fallbackIssues.get(issueKey) || { ...values };
    fallbackIssues.set(issueKey, current);
    return current;
  }
}

async function saveWorkflow(issueRecord, state) {
  const values = {
    workflowStatus: state.status,
    workflowStep: state.step,
    workflowOutput: state.output || null,
  };
  try {
    await issueRecord.update(values);
  } catch (error) {
    console.error("Workflow database state write failed:", error.message);
    Object.assign(issueRecord, values);
  }
}

async function saveAgentRun(issueRecord, state, agentName, result, status = "complete") {
  const output = result || {};
  const values = {
    issueId: issueRecord.id,
    agentName,
    category: agentName,
    confidence: Number(output.duplicate_confidence || output.confidence || 0),
    reasoning: output.recommendation || output.report || output.draft_comment || "Agent completed.",
    citedEvidence: output.matches || output.evidence || output.missing_details || [],
    suggestedAction: output.suggested_action || output.action || null,
    step: state.step,
    status,
    output,
  };
  try {
    if (issueRecord.id) {
      const [run] = await AgentRun.findOrCreate({
        where: { issueId: issueRecord.id, agentName },
        defaults: values,
      });
      if (!run.isNewRecord) await run.update(values);
      await require("../agents/escalation_aggregator/aggregator").evaluateIssueForEscalation(issueRecord.id);
    }
  } catch (error) {
    console.error("Workflow database agent write failed:", error.message);
  }
  fallbackRuns.set(`${issueRecord.repoFullName || ""}#${issueRecord.number}:${agentName}`, values);
  const [owner, repo] = String(issueRecord.repoFullName || "/").split("/");
  indexDocuments(owner, repo, [{
    id: `decision-${issueRecord.githubIssueId}-${agentName}`,
    text: `Agent decision for ${issueRecord.repoFullName} issue #${issueRecord.number}\nAgent: ${agentName}\nStatus: ${status}\n${JSON.stringify(output)}`,
    metadata: { kind: "decision", number: issueRecord.number, agent: agentName, status },
  }]);
}

async function saveIssueTimeline(issueRecord, eventType, actor, body) {
  if (!issueRecord?.id || !IssueTimeline) return false;
  try {
    const [, created] = await IssueTimeline.findOrCreate({
      where: { issueId: issueRecord.id, eventType },
      defaults: { actor: actor || "unknown", body: body || "" },
    });
    if (created) {
      const [owner, repo] = String(issueRecord.repoFullName || "/").split("/");
      indexDocuments(owner, repo, [{
        id: `timeline-${issueRecord.githubIssueId}-${eventType}`,
        text: `Discussion for ${issueRecord.repoFullName} issue #${issueRecord.number}\n${actor || "unknown"}: ${body || ""}`,
        metadata: { kind: "comment", number: issueRecord.number, actor: actor || "unknown", eventType },
      }]);
    }
    return created;
  } catch (error) {
    console.error("Workflow database timeline write failed:", error.message);
    return false;
  }
}

module.exports = { ensureIssue, saveWorkflow, saveAgentRun, saveIssueTimeline };