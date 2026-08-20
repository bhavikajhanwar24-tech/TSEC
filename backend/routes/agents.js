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
      env: { ...process.env, ...env, PYTHONUNBUFFERED: "1" },
      windowsHide: true,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { windowsHide: true });
      } else if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
      reject(new Error(`agent timed out after ${timeoutMs}ms`));
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
        return reject(new Error(stderr.trim() || `agent exited with code ${code}; stdout: ${stdout.slice(-500)}`));
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

function runAgentJob(agentDir, script, args, stdinPayload, env, timeoutMs) {
  return runAgent(agentDir, script, args, stdinPayload, env, timeoutMs).then(({ stdout }) => extractJson(stdout));
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
      { GITHUB_TOKEN: req.session.githubToken },
      240000
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

// Repo-level health runs (keyed by owner/repo) so the sidebar Health panel
// can start a sweep and poll its progress without tying it to an issue event.
const healthRuns = new Map();

function healthKey(owner, repo) {
  return `${owner}/${repo}`;
}

// POST /api/agents/health-run
// Body: { owner, repo, weeks? }
// Starts the Health-Trend Investigator in the background and returns the
// running record immediately; poll GET /health-run for the result.
router.post("/health-run", requireAuth, (req, res) => {
  const { owner, repo, weeks } = req.body || {};
  if (!owner || !repo) {
    return res.status(400).json({ error: "owner and repo are required" });
  }

  const key = healthKey(owner, repo);
  const existing = healthRuns.get(key);
  if (existing && existing.status === "running") {
    return res.status(202).json(existing);
  }

  const record = { status: "running", startedAt: new Date().toISOString() };
  healthRuns.set(key, record);

  const args = ["--owner", owner, "--repo", repo];
  if (weeks) args.push("--weeks", String(weeks));

  runAgent(
    path.join(AGENTS_DIR, "Health_agent"),
    "health_agent.py",
    args,
    undefined,
    { GITHUB_TOKEN: req.session.githubToken },
    240000,
  )
    .then(({ stdout }) => {
      record.status = "complete";
      record.completedAt = new Date().toISOString();
      record.result = extractJson(stdout);
    })
    .catch((err) => {
      record.status = "failed";
      record.completedAt = new Date().toISOString();
      record.error = err.message;
    });

  return res.status(202).json(record);
});

// GET /api/agents/health-run?owner=&repo=
router.get("/health-run", requireAuth, (req, res) => {
  const { owner, repo } = req.query || {};
  if (!owner || !repo) {
    return res.status(400).json({ error: "owner and repo are required" });
  }
  const record = healthRuns.get(healthKey(owner, repo));
  if (!record) {
    return res.json({ status: "idle", error: "No health sweep has been run for this repository yet." });
  }
  res.json(record);
});

// ---- Scheduled sweeps (time-driven monitoring) ----
const sweepService = require("../services/sweepService");

// GET /api/agents/sweeps — scheduler status + sweep history
router.get("/sweeps", requireAuth, (req, res) => {
  res.json(sweepService.status());
});

// GET /api/agents/sweeps/staleness/:owner/:repo — latest staleness run
router.get("/sweeps/staleness/:owner/:repo", requireAuth, (req, res) => {
  const record = sweepService.getStalenessRun(req.params.owner, req.params.repo);
  if (!record) return res.status(404).json({ error: "No staleness sweep recorded for this repository yet." });
  res.json(record);
});

// POST /api/agents/sweeps/run — immediate staleness sweep for one repo
// Body: { owner, repo }
router.post("/sweeps/run", requireAuth, async (req, res) => {
  const { owner, repo } = req.body || {};
  if (!owner || !repo) return res.status(400).json({ error: "owner and repo are required" });
  sweepService.trackRepo(owner, repo);
  const record = await sweepService.runStalenessSweep(owner, repo, req.session.githubToken);
  res.status(record.status === "complete" ? 200 : 202).json(record);
});

// POST /api/agents/sweeps/run-all — staleness pass for every tracked repo +
// weekly health sweep if due
router.post("/sweeps/run-all", requireAuth, async (req, res) => {
  const result = await sweepService.sweepAll(req.session.githubToken);
  res.json(result);
});

// POST /api/agents/contributor-match
// Body: { owner, repo, issueNumber }
router.post("/contributor-match", requireAuth, async (req, res) => {
  const { owner, repo, issueNumber } = req.body || {};
  if (!owner || !repo || !issueNumber) {
    return res.status(400).json({ error: "owner, repo, and issueNumber are required" });
  }

  try {
    const { stdout } = await runAgent(
      path.join(AGENTS_DIR, "collabator"),
      "serve.py",
      [],
      { owner, repo, issue_number: issueNumber },
      { GITHUB_TOKEN: req.session.githubToken }
    );
    res.json(extractJson(stdout));
  } catch (err) {
    console.error("contributor agent error:", err);
    res.status(500).json({ error: `Contributor agent failed: ${err.message}` });
  }
});

module.exports = router;
module.exports.runAgent = runAgent;
module.exports.extractJson = extractJson;
module.exports.runAgentJob = runAgentJob;
module.exports.setHealthRun = (owner, repo, record) => healthRuns.set(healthKey(owner, repo), record);