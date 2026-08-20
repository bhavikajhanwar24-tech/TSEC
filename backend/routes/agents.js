const express = require("express");
const { spawn } = require("child_process");
const path = require("path");

const router = express.Router();

const AGENTS_DIR = path.join(__dirname, "..", "Agents");
const DEFAULT_TIMEOUT_MS = 180000;

function requireAuth(req, res, next) {
  if (!req.session.githubToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

/**
 * Spawn a Python agent and resolve with its JSON stdout.
 * stdinPayload: JSON written to the agent's stdin (used by serve-style agents).
 */
function runAgent(agentDir, script, args, stdinPayload, env, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const pythonCommand = process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : path.join(__dirname, "..", ".venv", "bin", "python"));
    const child = spawn(pythonCommand, [script, ...args], {
      cwd: agentDir,
      env: { ...process.env, ...env },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("agent timed out"));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(new Error(stderr.trim() || `agent exited with code ${code}`));
      }
      resolve({ stdout, stderr });
    });

    if (stdinPayload !== undefined) {
      child.stdin.write(JSON.stringify(stdinPayload));
    }
    child.stdin.end();
  });
}

function extractJson(stdout) {
  const start = stdout.indexOf("{");
  if (start === -1) throw new Error("agent produced no JSON output");
  return JSON.parse(stdout.slice(start));
}

// POST /api/agents/backlog-sweep
// Body: { owner, repo, repoNorms }
router.post("/backlog-sweep", requireAuth, async (req, res) => {
  const { owner, repo, repoNorms } = req.body || {};
  if (!owner || !repo) {
    return res.status(400).json({ error: "owner and repo are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "backlog_agent"),
      "serve.py",
      [],
      { owner, repo, repo_norms: repoNorms || {} },
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("backlog agent error:", err);
    res.status(500).json({ error: `Backlog agent failed: ${err.message}` });
  }
});

// POST /api/agents/duplicate-check
// Body: { owner, repo, issueNumber }
router.post("/duplicate-check", requireAuth, async (req, res) => {
  const { owner, repo, issueNumber } = req.body || {};
  if (!owner || !repo || !issueNumber) {
    return res.status(400).json({ error: "owner, repo, and issueNumber are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "Duplicate_agent"),
      "duplicate_agent.py",
      ["--owner", owner, "--repo", repo, "--issue-number", String(issueNumber)],
      undefined,
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("duplicate agent error:", err);
    res.status(500).json({ error: `Duplicate agent failed: ${err.message}` });
  }
});

// POST /api/agents/health-report
// Body: { owner, repo, weeks? }
router.post("/health-report", requireAuth, async (req, res) => {
  const { owner, repo, weeks } = req.body || {};
  if (!owner || !repo) {
    return res.status(400).json({ error: "owner and repo are required" });
  }

  try {
    const args = ["--owner", owner, "--repo", repo];
    if (weeks) args.push("--weeks", String(weeks));
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "Health_agent"),
      "health_agent.py",
      args,
      undefined,
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("health agent error:", err);
    res.status(500).json({ error: `Health agent failed: ${err.message}` });
  }
});

// POST /api/agents/missing-info
// Body: { owner, repo, issueNumber }
router.post("/missing-info", requireAuth, async (req, res) => {
  const { owner, repo, issueNumber } = req.body || {};
  if (!owner || !repo || !issueNumber) {
    return res.status(400).json({ error: "owner, repo, and issueNumber are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "missing_iinfo_agent"),
      "missing_info_agent.py",
      ["--repo", `${owner}/${repo}`, "--issue", String(issueNumber)],
      undefined,
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("missing-info agent error:", err);
    res.status(500).json({ error: `Missing-info agent failed: ${err.message}` });
  }
});

// POST /api/agents/sensitivity-check
// Body: { owner, repo, issueNumber }
router.post("/sensitivity-check", requireAuth, async (req, res) => {
  const { owner, repo, issueNumber } = req.body || {};
  if (!owner || !repo || !issueNumber) {
    return res.status(400).json({ error: "owner, repo, and issueNumber are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "sensitivity_agent"),
      "sensitivity_agent.py",
      ["--owner", owner, "--repo", repo, "--issue-number", String(issueNumber)],
      undefined,
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("sensitivity agent error:", err);
    res.status(500).json({ error: `Sensitivity agent failed: ${err.message}` });
  }
});

// POST /api/agents/sentiment-analysis
// Body: { owner, repo, issueNumber, repoNorms? }
router.post("/sentiment-analysis", requireAuth, async (req, res) => {
  const { owner, repo, issueNumber, repoNorms } = req.body || {};
  if (!owner || !repo || !issueNumber) {
    return res.status(400).json({ error: "owner, repo, and issueNumber are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "sentiment_analysis"),
      "serve.py",
      [],
      { owner, repo, issueNumber, repo_norms: repoNorms || {} },
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("sentiment agent error:", err);
    res.status(500).json({ error: `Sentiment agent failed: ${err.message}` });
  }
});

module.exports = router;
module.exports.runAgent = runAgent;
module.exports.extractJson = extractJson;