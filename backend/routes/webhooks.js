const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { runAgentJob } = require("./agents");

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

function analysisKey(owner, repo, number) {
  return `${owner}/${repo}#${number}`;
}

function getAnalysis(owner, repo, number) {
  return analyses.get(analysisKey(owner, repo, number));
}

function startAgent(name, agentDir, script, args, stdinPayload, env, record) {
  record.agents[name] = { status: "running", startedAt: new Date().toISOString() };
  return runAgentJob(agentDir, script, args, stdinPayload, env)
    .then((result) => {
      record.agents[name] = { status: "complete", result, completedAt: new Date().toISOString() };
    })
    .catch((error) => {
      record.agents[name] = { status: "failed", error: error.message, completedAt: new Date().toISOString() };
    });
}

function runAllAgents(issue, repository, record, token = process.env.GITHUB_TOKEN) {
  const owner = repository.owner.login;
  const repo = repository.name;
  const env = { GITHUB_TOKEN: token };
  return Promise.all([
    startAgent("duplicate", agentDirs.duplicate, "duplicate_agent.py", ["--owner", owner, "--repo", repo, "--issue-json", "-"], issue, env, record),
    startAgent("missingInfo", agentDirs.missingInfo, "missing_info_agent.py", ["--repo", `${owner}/${repo}`, "--issue", String(issue.number)], undefined, env, record),
    startAgent("sensitivity", agentDirs.sensitivity, "sensitivity_agent.py", ["--owner", owner, "--repo", repo, "--issue-json", "-"], issue, env, record),
    startAgent("sentiment", agentDirs.sentiment, "serve.py", [], { owner, repo, issueNumber: issue.number, repo_norms: {} }, env, record),
    startAgent("backlog", agentDirs.backlog, "serve.py", [], { owner, repo, repo_norms: {} }, env, record),
    startAgent("health", agentDirs.health, "health_agent.py", ["--owner", owner, "--repo", repo], undefined, env, record),
  ]).then(() => {
    record.status = Object.values(record.agents).some((agent) => agent.status === "failed") ? "complete_with_errors" : "complete";
    record.completedAt = new Date().toISOString();
  });
}

function createAnalysis(issue, repository, token) {
  const record = {
    issue,
    repository: { owner: repository.owner.login, name: repository.name },
    status: "running",
    createdAt: new Date().toISOString(),
    agents: {},
  };
  analyses.set(analysisKey(repository.owner.login, repository.name, issue.number), record);
  runAllAgents(issue, repository, record, token).catch((error) => {
    record.status = "failed";
    record.error = error.message;
  });
  return record;
}

function validSignature(req) {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  const signature = req.get("x-hub-signature-256");
  if (!secret || !signature || !req.rawBody) return false;
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(req.rawBody).digest("hex")}`;
  return signature.length === expected.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

router.post("/github", (req, res) => {
  if (!validSignature(req)) return res.status(401).json({ error: "Invalid webhook signature" });

  const event = req.get("x-github-event");
  if (event !== "issues" || req.body.action !== "opened") {
    return res.status(202).json({ accepted: true, processed: false });
  }

  const issue = req.body.issue;
  const repository = req.body.repository;
  if (!issue?.number || !repository?.owner?.login || !repository?.name) {
    return res.status(400).json({ error: "Invalid issue webhook payload" });
  }

  if (!process.env.GITHUB_TOKEN) {
    console.error("Duplicate webhook skipped: GITHUB_TOKEN is not configured");
    return res.status(503).json({ error: "GITHUB_TOKEN is not configured for automatic agents" });
  }

  const record = createAnalysis(issue, repository, process.env.GITHUB_TOKEN);
  res.status(202).json({ accepted: true, processed: true, issue: issue.number });
});

router.get("/analysis/:owner/:repo/:number", async (req, res) => {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  let record = getAnalysis(req.params.owner, req.params.repo, req.params.number);
  if (!record) {
    try {
      const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(req.params.owner)}/${encodeURIComponent(req.params.repo)}/issues/${req.params.number}`, {
        headers: {
          Authorization: `Bearer ${req.session.githubToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "RepoGuardian",
        },
      });
      if (!response.ok) return res.status(response.status).json({ error: "Issue not found" });
      const issue = await response.json();
      if (issue.pull_request || issue.state !== "open") return res.status(400).json({ error: "Automatic analysis is available for open issues only" });
      record = createAnalysis(issue, { owner: { login: req.params.owner }, name: req.params.repo }, req.session.githubToken);
    } catch (error) {
      return res.status(500).json({ error: `Could not start analysis: ${error.message}` });
    }
  }
  res.json(record);
});

module.exports = router;