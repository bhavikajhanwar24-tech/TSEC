const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { runAgentJob } = require("./agents");
const { ensureIssue, saveWorkflow, saveAgentRun, saveIssueTimeline } = require("../services/workflowService");
const { indexDocuments } = require("../services/ragService");

const router = express.Router();
const duplicateAgentDir = path.join(__dirname, "..", "Agents", "Duplicate_agent");
const agentDirs = {
  duplicate: duplicateAgentDir,
  missingInfo: path.join(__dirname, "..", "Agents", "missing_iinfo_agent"),
  sensitivity: path.join(__dirname, "..", "Agents", "sensitivity_agent"),
  sentiment: path.join(__dirname, "..", "Agents", "sentiment_analysis"),
  backlog: path.join(__dirname, "..", "Agents", "backlog_agent"),
  health: path.join(__dirname, "..", "Agents", "Health_agent"),
};
const analyses = new Map();
let lastWebhook = null;

function analysisKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

function getAnalysis(owner, repo, number) {
  return analyses.get(analysisKey(owner, repo, number));
}

function isHumanIssueComment(payload) {
  const sender = payload.sender || payload.comment?.user;
  return Boolean(sender) && sender.type !== "Bot" && sender.type !== "Integration";
}

function needsDuplicateEvidence(result) {
  return Boolean(
    result &&
    !result.is_direct_duplicate &&
    (result.suggested_action === "request_reproduction" || result.evidence_gaps?.length)
  );
}

async function getPersistedAnalysis(owner, repo, number) {
  try {
    const { Issue } = require("../models");
    const issue = await Issue.findOne({ where: { repoFullName: `${owner}/${repo}`, number }, include: [{ association: "agentRuns" }, { association: "timelines" }] });
    if (!issue) return null;
    return {
      issue: issue.toJSON(),
      repository: { owner, name: repo },
      status: issue.workflowStatus,
      step: issue.workflowStep,
      output: issue.workflowOutput,
      agents: Object.fromEntries((issue.agentRuns || []).map((run) => [run.agentName, { status: run.status, result: run.output, error: run.status === "failed" ? run.reasoning : undefined }])),
      comments: (issue.timelines || [])
        .filter((timeline) => timeline.eventType.startsWith("github_comment:"))
        .map((timeline) => ({ actor: timeline.actor, body: timeline.body, createdAt: timeline.createdAt })),
    };
  } catch (error) {
    console.error("Workflow database read failed:", error.message);
    return null;
  }
}

async function getWorkflowStatuses(owner, repo) {
  const statuses = Object.values(Object.fromEntries(
    [...analyses.entries()]
      .filter(([key]) => key.startsWith(`${owner}/${repo}#`))
      .map(([key, record]) => [key.split("#")[1], { number: key.split("#")[1], status: record.status, step: record.step }])
  ));
  try {
    const { Issue } = require("../models");
    const records = await Issue.findAll({ where: { repoFullName: `${owner}/${repo}` }, attributes: ["number", "workflowStatus", "workflowStep"] });
    const byNumber = new Map(statuses.map((item) => [String(item.number), item]));
    records.forEach((record) => byNumber.set(String(record.number), { number: record.number, status: record.workflowStatus, step: record.workflowStep }));
    return [...byNumber.values()];
  } catch (error) {
    console.error("Workflow status read failed:", error.message);
    return statuses;
  }
}

async function startAgent(name, agentDir, script, args, stdinPayload, env, record, step, timeoutMs) {
  record.agents[name] = { status: "running", startedAt: new Date().toISOString() };
  await saveWorkflow(record.issueRecord, { step, status: "running", output: record });
  console.log(`Starting ${name} agent for ${record.repository.owner}/${record.repository.name}#${record.issue.number}`);
  try {
    const result = await runAgentJob(agentDir, script, args, stdinPayload, env, timeoutMs);
    console.log(`Completed ${name} agent for ${record.repository.owner}/${record.repository.name}#${record.issue.number}`);
    record.agents[name] = { status: "complete", result, completedAt: new Date().toISOString() };
    await saveAgentRun(record.issueRecord, { step, status: "running" }, name, result);
    return result;
  } catch (error) {
    console.error(`Failed ${name} agent for ${record.repository.owner}/${record.repository.name}#${record.issue.number}:`, error.message);
    record.agents[name] = { status: "failed", error: error.message, completedAt: new Date().toISOString() };
    await saveAgentRun(record.issueRecord, { step, status: "complete_with_errors" }, name, { error: error.message }, "failed");
    return { error: error.message };
  }
}

async function githubIssueAction(owner, repo, number, token, method, body) {
  const endpoint = method === "COMMENT"
    ? `https://api.github.com/repos/${owner}/${repo}/issues/${number}/comments`
    : `https://api.github.com/repos/${owner}/${repo}/issues/${number}`;
  const response = await fetch(endpoint, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "RepoGuardian" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`GitHub issue action failed (${response.status})`);
}

async function runAllAgents(issue, repository, record, token = process.env.GITHUB_TOKEN) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const env = { GITHUB_TOKEN: token };
  const steps = [
    ["duplicate", agentDirs.duplicate, "duplicate_agent.py", ["--owner", owner, "--repo", repo, "--issue-json", "-"], issue],
    ["missingInfo", agentDirs.missingInfo, "missing_info_agent.py", ["--repo", `${owner}/${repo}`, "--issue", String(issue.number)], undefined],
    ["sensitivity", agentDirs.sensitivity, "sensitivity_agent.py", ["--owner", owner, "--repo", repo, "--issue-json", "-"], issue],
    ["sentiment", agentDirs.sentiment, "serve.py", [], { owner, repo, issueNumber: issue.number, repo_norms: {} }],
    ["backlog", agentDirs.backlog, "serve.py", [], { owner, repo, repo_norms: {} }, 240000],
    ["health", agentDirs.health, "health_agent.py", ["--owner", owner, "--repo", repo], undefined, 240000],
  ];
  let nextStep = record.step;
  async function runStep([name, dir, script, args, payload, timeoutMs]) {
    const rerun = (name === "duplicate" && record.resumeDuplicate) ||
      (name === "missingInfo" && (record.resumeMissingInfo || record.forceMissingInfo));
    if (record.agents[name]?.status === "complete" && !rerun) return null;
    const step = ++nextStep;
    record.step = step;
    await saveWorkflow(record.issueRecord, { step, status: "running", output: record });
    return { name, result: await startAgent(name, dir, script, args, payload, env, record, step, timeoutMs) };
  }

  for (const stepDefinition of steps.slice(0, 3)) {
    const stepResult = await runStep(stepDefinition);
    if (!stepResult) continue;
    const { name, result } = stepResult;
    if (name === "duplicate" && result.is_direct_duplicate) {
      const match = result.matches?.find((item) => item.classification === "direct_duplicate");
      const reporter = issue.user?.login ? `@${issue.user.login}` : "there";
      const evidence = (match?.evidence || []).map((e) => `- ${e}`).join("\n");
      const why = evidence || `- ${result.recommendation || "the issue reports the same problem as an existing issue"}`;
      const title = match?.title ? `: "${match.title}"` : "";
      const comment = [
        `Hi ${reporter} — this issue was closed as a duplicate of **#${match?.issue_number || "an existing issue"}**${title}.`,
        "",
        "Why it was closed:",
        why,
        "",
        match?.url ? `Original issue: ${match.url}` : null,
        "",
        "Please follow the original issue for updates. If you believe this is not a duplicate, reopen the issue and explain what differs.",
      ].filter(Boolean).join("\n");
      await githubIssueAction(owner, repo, issue.number, token, "COMMENT", { body: comment });
      await githubIssueAction(owner, repo, issue.number, token, "PATCH", { state: "closed", state_reason: "duplicate" });
      record.status = "stopped_duplicate";
      record.stopReason = "Duplicate detected; issue commented and closed.";
      await saveWorkflow(record.issueRecord, { step: record.step, status: record.status, output: record });
      return;
    }
    if (name === "duplicate" && needsDuplicateEvidence(result)) {
      record.forceMissingInfo = true;
    }
    if (name === "missingInfo" && result.missing_fields?.length) {
      if (result.draft_comment) await githubIssueAction(owner, repo, issue.number, token, "POST", { body: result.draft_comment });
      record.status = record.forceMissingInfo ? "waiting_duplicate_info" : "waiting_missing_info";
      record.stopReason = record.forceMissingInfo
        ? "More evidence is needed before confirming whether this is a duplicate."
        : "Missing information requested from the reporter.";
      await saveAgentRun(record.issueRecord, { step: record.step, status: record.status }, name, result, record.status);
      await saveWorkflow(record.issueRecord, { step: record.step, status: record.status, output: record });
      return;
    }
    if (name === "missingInfo" && record.forceMissingInfo) {
      const gaps = result.missing_details?.length
        ? result.missing_details
        : ["more reproduction steps, logs, or environment details to compare with the possible duplicate"];
      await githubIssueAction(owner, repo, issue.number, token, "POST", {
        body: `I need a little more detail before deciding whether this is a duplicate.\n\n${gaps.map((gap, index) => `${index + 1}. ${gap}`).join("\n")}\n\nPlease reply here with the missing details. I will re-check the duplicate comparison after your reply.`,
      });
      record.status = "waiting_duplicate_info";
      record.stopReason = "More evidence is needed before confirming whether this is a duplicate.";
      await saveWorkflow(record.issueRecord, { step: record.step, status: record.status, output: record });
      return;
    }
  }

  const remaining = steps.slice(3).filter(([name]) => !record.agents[name] || record.agents[name].status !== "complete");
  await Promise.all(remaining.map((stepDefinition) => runStep(stepDefinition)));
  record.status = "complete";
  record.completedAt = new Date().toISOString();
  await saveWorkflow(record.issueRecord, { step: record.step, status: record.status, output: record });
}

async function createAnalysis(issue, repository, token, persisted) {
  const issueRecord = await ensureIssue(issue, repository.owner.login, repository.name);
  const completedSteps = Object.values(persisted?.agents || {}).filter((agent) => agent.status === "complete").length;
  const record = {
    issue,
    repository: { owner: repository.owner.login, name: repository.name },
    status: "running",
    createdAt: new Date().toISOString(),
    agents: persisted?.agents || {},
    step: completedSteps,
    resumeMissingInfo: persisted?.status === "waiting_missing_info",
    resumeDuplicate: persisted?.status === "waiting_duplicate_info",
  };
  Object.defineProperty(record, "issueRecord", { value: issueRecord, enumerable: false, writable: true });
  analyses.set(analysisKey(repository.owner.login, repository.name, issue.number), record);
  await saveWorkflow(issueRecord, { step: record.step, status: "running", output: record });
  runAllAgents(issue, repository, record, token).catch(async (error) => {
    record.status = "failed";
    record.error = error.message;
    await saveWorkflow(issueRecord, { step: record.step, status: record.status, output: record });
  });
  return record;
}

function validSignature(req) {
  const secret = (process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_APP_WEBHOOK_SECRET || "").trim();
  const signature = req.get("x-hub-signature-256");
  if (!secret || !signature || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex")}`;
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

router.post(["/github", "/"], async (req, res) => {
  const event = req.get("x-github-event") || "unknown";
  lastWebhook = {
    event,
    action: req.body?.action || "unknown",
    delivery: req.get("x-github-delivery") || null,
    receivedAt: new Date().toISOString(),
  };
  if (!validSignature(req)) {
    lastWebhook.rejected = "invalid_signature_or_missing_secret";
    console.error("GitHub webhook rejected: invalid signature or missing GITHUB_WEBHOOK_SECRET");
    return res.status(401).json({ error: "Invalid webhook signature" });
  }

  const issueEvent = event === "issues" && ["opened", "reopened"].includes(req.body.action);
  const pullRequestEvent = event === "pull_request" && ["opened", "reopened", "edited", "closed"].includes(req.body.action);
  const commentEvent = event === "issue_comment" && req.body.action === "created";
  const pushEvent = event === "push";
  const reporterReply = event === "issue_comment" && req.body.action === "created" && isHumanIssueComment(req.body);
  if (!issueEvent && !pullRequestEvent && !commentEvent && !pushEvent) {
    return res.status(202).json({ accepted: true, processed: false });
  }

  const repository = req.body.repository;
  if (!repository?.owner?.login || !repository?.name) {
    return res.status(400).json({ error: "Invalid repository webhook payload" });
  }

  if (pushEvent) {
    indexDocuments(repository.owner.login, repository.name, (req.body.commits || []).map((commit) => ({
      id: `commit-${commit.id}`,
      text: `Commit ${commit.id}: ${commit.message || ""}\nAuthor: ${commit.author?.name || commit.author?.username || "unknown"}\nURL: ${commit.url || ""}`,
      metadata: { kind: "commit", sha: commit.id, source: `Commit ${commit.id?.slice(0, 7) || "unknown"}` },
    })));
    return res.status(202).json({ accepted: true, processed: false, indexed: true, commits: (req.body.commits || []).length });
  }

  const issue = req.body.issue;
  if (!issue?.number) {
    return res.status(400).json({ error: "Invalid issue webhook payload" });
  }

  await ensureIssue(issue, repository.owner.login, repository.name);

  indexDocuments(repository.owner.login, repository.name, [{
    id: `github-${issue.id || issue.number}`,
    text: `${issue.pull_request ? "Pull request" : "Issue"} #${issue.number}: ${issue.title || ""}\n${issue.body || ""}\nState: ${issue.state || ""}`,
    metadata: { kind: issue.pull_request ? "pr" : "issue", number: issue.number, state: issue.state || "", source: `${issue.pull_request ? "PR" : "Issue"} #${issue.number}` },
  }]);

  if (commentEvent) {
    const comment = req.body.comment || {};
    indexDocuments(repository.owner.login, repository.name, [{
      id: `github-comment-${comment.id || req.get("x-github-delivery")}`,
      text: `Comment on ${issue.pull_request ? "PR" : "Issue"} #${issue.number} by ${comment.user?.login || req.body.sender?.login || "unknown"}:\n${comment.body || ""}`,
      metadata: { kind: "comment", number: issue.number, actor: comment.user?.login || req.body.sender?.login || "unknown", source: `${issue.pull_request ? "PR" : "Issue"} #${issue.number} comment` },
    }]);
  }

  if (pullRequestEvent || (commentEvent && !reporterReply)) {
    return res.status(202).json({ accepted: true, processed: false, indexed: true, issue: issue.number });
  }

  if (reporterReply) {
    const issueRecord = await ensureIssue(issue, repository.owner.login, repository.name);
    const comment = req.body.comment || {};
    const commentWasStored = await saveIssueTimeline(
      issueRecord,
      `github_comment:${comment.id || req.get("x-github-delivery")}`,
      comment.user?.login || req.body.sender?.login,
      comment.body,
    );
    if (!commentWasStored) {
      return res.status(202).json({ accepted: true, processed: false, duplicate: true, issue: issue.number });
    }
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error("Duplicate webhook skipped: GITHUB_TOKEN is not configured");
    lastWebhook.rejected = "missing_github_token";
    return res.status(503).json({ error: "GITHUB_TOKEN is not configured for automatic agents" });
  }

  const inMemoryAnalysis = getAnalysis(repository.owner.login, repository.name, issue.number);
  let existing = inMemoryAnalysis || await getPersistedAnalysis(repository.owner.login, repository.name, issue.number);
  const isResume = reporterReply;
  if (inMemoryAnalysis?.status === "running") return res.status(202).json({ accepted: true, processed: false, resumed: true, issue: issue.number });
  if (existing?.status === "complete" || existing?.status === "stopped_duplicate") {
    return res.status(202).json({ accepted: true, processed: false, issue: issue.number });
  }
  if (!isResume && ["waiting_missing_info", "waiting_duplicate_info"].includes(existing?.status)) {
    return res.status(202).json({ accepted: true, processed: false, issue: issue.number });
  }
  const record = await createAnalysis(issue, repository, process.env.GITHUB_TOKEN, existing);
  lastWebhook.processed = true;
  lastWebhook.issue = issue.number;
  res.status(202).json({ accepted: true, processed: true, issue: issue.number });
});

router.get("/status", (req, res) => {
  res.json({
    webhookEndpoints: ["/api/webhooks/github", "/api/webhooks"],
    configured: {
      webhookSecret: Boolean((process.env.GITHUB_WEBHOOK_SECRET || process.env.GITHUB_APP_WEBHOOK_SECRET || "").trim()),
      agentToken: Boolean(process.env.GITHUB_TOKEN),
    },
    lastWebhook,
  });
});

router.get("/analysis/:owner/:repo", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  res.json({ statuses: await getWorkflowStatuses(req.params.owner, req.params.repo) });
});

router.get("/analysis/:owner/:repo/:number", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  let record = getAnalysis(req.params.owner, req.params.repo, req.params.number);
  if (!record) record = await getPersistedAnalysis(req.params.owner, req.params.repo, req.params.number);
  if (!record) return res.status(404).json({ error: "No automatic analysis exists for this issue. Analysis starts only when the issue is newly created." });
  res.json(record);
});

module.exports = router;