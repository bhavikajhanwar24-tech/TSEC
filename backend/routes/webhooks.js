const crypto = require("crypto");
const express = require("express");
const path = require("path");
const { extractJson, runAgent } = require("./agents");

const router = express.Router();
const duplicateAgentDir = path.join(__dirname, "..", "Agents", "Duplicate_agent");
const sensitivityAgentDir = path.join(__dirname, "..", "Agents", "sensitivity_agent");

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

  res.status(202).json({ accepted: true, processed: true, issue: issue.number });

  runAgent(
    duplicateAgentDir,
    "duplicate_agent.py",
    ["--owner", repository.owner.login, "--repo", repository.name, "--issue-json", "-"],
    { issue },
    { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  ).then(({ stdout }) => {
    console.log("Automatic duplicate check completed:", extractJson(stdout));
  }).catch((error) => {
    console.error("Automatic duplicate check failed:", error);
  });

  runAgent(
    sensitivityAgentDir,
    "sensitivity_agent.py",
    ["--owner", repository.owner.login, "--repo", repository.name, "--issue-json", "-"],
    { issue },
    { GITHUB_TOKEN: process.env.GITHUB_TOKEN }
  ).then(({ stdout }) => {
    const result = extractJson(stdout);
    console.log("Automatic sensitivity check completed:", {
      danger_score: result.danger_score,
      private_notification_required: result.private_notification_required,
      is_security_sensitive: result.is_security_sensitive,
      priority_flag: result.priority_flag,
      suggested_action: result.suggested_action,
    });
  }).catch((error) => {
    console.error("Automatic sensitivity check failed:", error);
  });
});

module.exports = router;