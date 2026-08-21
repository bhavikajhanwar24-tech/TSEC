const express = require("express");
const { AgentRun, EscalationDecision } = require("../models");
const { REQUIRED_CATEGORIES, pendingDecision } = require("../Agents/escalation_aggregator/aggregator");
const { normalizeCategory } = require("../Agents/escalation_aggregator/scoringRules");
const GITHUB_API = "https://api.github.com";

const router = express.Router();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function githubHeaders(token) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "RepoGuardian", "Content-Type": "application/json" };
}

function linkedIssueNumbers(text) {
  const matches = String(text || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi);
  return [...new Set([...matches].map((match) => Number(match[1])))];
}

async function closeLinkedIssues(owner, repo, pullRequest, token) {
  const numbers = linkedIssueNumbers(`${pullRequest.title || ""}\n${pullRequest.body || ""}`);
  const headers = githubHeaders(token);
  const results = [];
  for (const number of numbers) {
    try {
      await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ body: `This issue was resolved by pull request #${pullRequest.number}. The pull request was accepted and merged.` }),
      });
    } catch (error) {
      console.error(`Linked issue #${number} resolution comment failed:`, error.message);
    }
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed", state_reason: "completed" }),
    });
    results.push({ number, closed: response.ok });
  }
  return results;
}

function suggestionScore(login, issue, runs, contributor) {
  const text = `${issue.title || ""} ${issue.body || ""}`.toLowerCase();
  const evidence = JSON.stringify(runs.map((run) => run.output || {})).toLowerCase();
  let score = Math.min(45, Number(contributor.contributions || 0));
  const reasons = [];
  if (text.includes(login.toLowerCase())) { score += 25; reasons.push("mentioned in the issue"); }
  if (evidence.includes(login.toLowerCase())) { score += 20; reasons.push("appears in agent evidence"); }
  if (runs.some((run) => normalizeCategory(run) === "sentiment" && Number(run.output?.escalation_multiplier || 1) <= 1)) {
    score += 10;
    reasons.push("repository sentiment is stable");
  }
  if (!reasons.length) reasons.push("active repository contributor");
  return { login, score: Math.min(100, Math.round(score)), reasons, contributions: Number(contributor.contributions || 0), avatar_url: contributor.avatar_url || "" };
}

router.get("/:owner/:repo/moderation/:number", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  const { owner, repo, number } = req.params;
  try {
    const headers = githubHeaders(req.session.githubToken);
    const [issueResponse, collaboratorResponse, contributorResponse] = await Promise.all([
      fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, { headers }),
      fetch(`${GITHUB_API}/repos/${owner}/${repo}/collaborators?per_page=100`, { headers }),
      fetch(`${GITHUB_API}/repos/${owner}/${repo}/contributors?anon=0&per_page=100`, { headers }),
    ]);
    const issue = await issueResponse.json();
    if (!issueResponse.ok) return res.status(issueResponse.status).json({ error: issue.message || "Issue not found" });
    const collaborators = collaboratorResponse.ok ? await collaboratorResponse.json() : [];
    const contributors = contributorResponse.ok ? await contributorResponse.json() : [];
    const stored = await require("../models").Issue.findOne({ where: { repoFullName: `${owner}/${repo}`, number }, include: [{ association: "agentRuns" }] });
    const runs = stored?.agentRuns || [];
    const candidates = (collaborators.length ? collaborators : contributors)
      .filter((person) => person.login)
      .map((person) => suggestionScore(person.login, issue, runs, person))
      .sort((left, right) => right.score - left.score)
      .slice(0, 8);
    return res.json({ issue, collaborators: collaborators.filter((person) => person.login), suggestions: candidates });
  } catch (error) {
    console.error("Moderator context lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load moderator context" });
  }
});

router.post("/:owner/:repo/moderation/:number", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  const { owner, repo, number } = req.params;
  const assignee = String(req.body?.assignee || "").trim();
  const reopen = req.body?.reopen === true;
  const undo = req.body?.undo === true;
  const accept = req.body?.accept === true;
  if (!assignee && !reopen && !undo && !accept) return res.status(400).json({ error: "Choose a collaborator, request reopen, undo the assignment, or accept the PR" });
  try {
    const headers = githubHeaders(req.session.githubToken);
    if (accept) {
      const pullResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`, { headers });
      const pullRequest = await pullResponse.json();
      if (!pullResponse.ok) return res.status(pullResponse.status).json({ error: pullRequest.message || "Pull request not found" });
      const mergeResponse = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}/merge`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ merge_method: req.body?.mergeMethod || "squash" }),
      });
      const mergeResult = await mergeResponse.json();
      if (!mergeResponse.ok || !mergeResult.merged) return res.status(mergeResponse.status || 409).json({ error: mergeResult.message || "Pull request could not be merged" });
      const closedIssues = await closeLinkedIssues(owner, repo, pullRequest, req.session.githubToken);
      return res.json({ accepted: true, merged: true, sha: mergeResult.sha, closedIssues });
    }
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ ...(assignee ? { assignees: [assignee] } : {}), ...(undo ? { assignees: [], state: "open", state_reason: "reopened" } : {}), ...(reopen ? { state: "open", state_reason: "reopened" } : {}) }),
    });
    const result = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: result.message || "GitHub moderator action failed" });
    return res.json({ issue: result, assigned: assignee || null, reopened: reopen || undo, undone: undo });
  } catch (error) {
    console.error("Moderator action failed:", error.message);
    return res.status(500).json({ error: "Moderator action failed" });
  }
});

router.get("/:owner/:repo/escalations", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  try {
    const decisions = await EscalationDecision.findAll({
      where: { needsAttention: true },
      include: [{ model: require("../models").Issue, as: "issue", where: { repoFullName: `${req.params.owner}/${req.params.repo}` }, include: [{ association: "agentRuns" }, { association: "timelines" }] }],
      order: [["createdAt", "DESC"]],
    });
    return res.json({ decisions: decisions.map((decision) => ({ ...decision.toJSON(), issue: decision.issue.toJSON(), agentRuns: decision.issue.agentRuns || [], timelines: decision.issue.timelines || [] })) });
  } catch (error) {
    console.error("Escalation queue lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load escalation queue" });
  }
});

router.get("/:issueId/escalation", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  try {
    const { Issue } = require("../models");
    const issueInclude = [{ association: "agentRuns", include: [{ association: "feedbacks" }] }, { association: "timelines" }];
    const issue = isUuid(req.params.issueId)
      ? await Issue.findOne({ where: { id: req.params.issueId }, include: issueInclude })
      : await Issue.findOne({ where: { githubIssueId: String(req.params.issueId) }, include: issueInclude });
    const resolvedIssueId = issue?.id || req.params.issueId;
    if (!issue) return res.status(404).json({ error: "Issue not found" });
    const decision = await EscalationDecision.findOne({ where: { issueId: resolvedIssueId } });
    if (decision) return res.json({ pending: false, ...decision.toJSON(), issue: issue.toJSON(), agentRuns: issue.agentRuns || [], timelines: issue.timelines || [] });

    const runs = await AgentRun.findAll({ where: { issueId: resolvedIssueId } });
    return res.json({ ...pendingDecision(runs.filter((run) => REQUIRED_CATEGORIES.has(normalizeCategory(run)))), issue: issue.toJSON(), agentRuns: runs, timelines: [] });
  } catch (error) {
    console.error("Escalation decision lookup failed:", error.message);
    return res.status(500).json({ error: "Could not load escalation decision" });
  }
});

router.post("/:issueId/feedback", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  const { AgentRun, Feedback, Issue } = require("../models");
  const verdict = String(req.body?.verdict || "");
  const correctionType = String(req.body?.correctionType || "");
  const correctionDetail = String(req.body?.correctionDetail || "").trim();
  if (!["approved", "corrected"].includes(verdict)) return res.status(400).json({ error: "verdict must be approved or corrected" });
  if (verdict === "corrected" && (!correctionType || !correctionDetail)) return res.status(400).json({ error: "Corrections require a type and detail" });
  try {
    const run = await AgentRun.findByPk(req.body?.agentRunId, { include: [{ association: "issue" }] });
    if (!run || String(run.issueId) !== String(req.issueId)) return res.status(404).json({ error: "Decision not found" });
    const issue = run.issue || await Issue.findByPk(req.issueId);
    const feedback = await Feedback.create({
      agentRunId: run.id,
      userGithubId: req.session.githubUser?.login || req.session.githubUserId || "maintainer",
      rating: verdict === "approved" ? "helpful" : "not_helpful",
      comment: correctionDetail || null,
      repoFullName: issue?.repoFullName || null,
      verdict,
      correctionType: correctionType || null,
      correctionDetail: correctionDetail || null,
    });
    return res.status(201).json({ feedback, repoFullName: issue?.repoFullName || null });
  } catch (error) {
    console.error("Decision feedback write failed:", error.message);
    return res.status(500).json({ error: "Could not store decision feedback" });
  }
});

module.exports = router;
