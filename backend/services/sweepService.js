/**
 * Scheduled sweeps — RepoGuardian
 *
 * Time-driven monitoring on top of the event queue:
 *   - Staleness sweep: rule pass over open issues (age vs repo norm, comment
 *     velocity, label state) -> threshold crossers -> one backlog-agent
 *     investigation pass per repo with the crossers listed.
 *   - Weekly health sweep: re-runs the Health-Trend Investigator for every
 *     tracked repository and drops the result into the same healthRuns map
 *     the Health tab polls, so a fresh result just appears.
 *
 * Runs in-process on setInterval (no extra infrastructure). Repos become
 * "tracked" on any webhook event (webhooks.js calls trackRepo) or when a
 * health run starts for them.
 */

const path = require("path");

const AGENTS_DIR = path.join(__dirname, "..", "Agents");
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CROSSERS_PER_REPO = 5;

// Lazy require: agents.js mounts this service mid-load, so destructuring its
// exports at module scope would capture `runAgent` before it is exported.
function agentsModule() {
  return require("../routes/agents");
}

const trackedRepos = new Map(); // owner/repo -> { owner, repo, lastSeen }
const stalenessRuns = new Map(); // owner/repo -> record
const sweeps = []; // history of completed sweeps (newest first)
let scheduler = null;
let weeklyLastRun = 0;

function trackRepo(owner, repo) {
  const key = `${owner}/${repo}`;
  trackedRepos.set(key, { owner, repo, lastSeen: new Date().toISOString() });
  return trackedRepos.get(key);
}

function trackedRepoList() {
  return Array.from(trackedRepos.values());
}

async function fetchFromGitHub(url, token) {
  const res = await fetch(`https://api.github.com${url}`, {
    headers: {
      Authorization: `Bearer ${token || process.env.GITHUB_TOKEN || ""}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "RepoGuardian",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status} for ${url}`);
  }
  return res.json();
}

function daysBetween(iso) {
  return Math.round((Date.now() - new Date(iso).getTime()) / 86400000);
}

/** Rule pass over open issues. Returns issues that cross a staleness
 * threshold (age or comment silence beyond the repo norm). */
async function findStaleIssues(owner, repo, token, repoNorms) {
  const threshold = Number(repoNorms?.auto_close_threshold_days) || 30;
  const issues = await fetchFromGitHub(`/repos/${owner}/${repo}/issues?state=open&per_page=100`, token);
  const crossers = [];
  for (const issue of issues) {
    if (issue.pull_request || !issue.number) continue;
    const daysOpen = daysBetween(issue.created_at);
    let lastCommentDays = null;
    try {
      const comments = await fetchFromGitHub(`/repos/${owner}/${repo}/issues/${issue.number}/comments?per_page=1`, token);
      if (comments.length > 0) lastCommentDays = daysBetween(comments[comments.length - 1].created_at);
    } catch {
      lastCommentDays = null;
    }
    const labelState = (issue.labels || []).map((label) => (typeof label === "string" ? label : label.name));
    const aged = daysOpen > threshold;
    const stale = lastCommentDays !== null && lastCommentDays > threshold;
    const blocked = labelState.some((label) => /blocked|wontfix|waiting/i.test(label));
    const reason = blocked ? null : aged ? "aged" : stale ? "stale" : null;
    if (reason) {
      crossers.push({
        number: issue.number,
        title: issue.title,
        days_open: daysOpen,
        last_comment_days: lastCommentDays,
        labels: labelState,
        reason,
      });
    }
  }
  crossers.sort((a, b) => b.days_open - a.days_open);
  return crossers.slice(0, MAX_CROSSERS_PER_REPO);
}

/** Full staleness sweep for one repo: rule pass, then one backlog-agent
 * investigation with the crossers, then persist the record. */
async function runStalenessSweep(owner, repo, token, repoNorms) {
  const key = `${owner}/${repo}`;
  const existing = stalenessRuns.get(key);
  if (existing && existing.status === "running") return existing;

  const record = {
    owner,
    repo,
    type: "staleness",
    status: "running",
    startedAt: new Date().toISOString(),
    repo_norms: repoNorms || {},
  };
  stalenessRuns.set(key, record);

  try {
    record.threshold_crossers = await findStaleIssues(owner, repo, token, repoNorms);
    if (record.threshold_crossers.length > 0) {
      const { runAgent, extractJson } = agentsModule();
      const { stdout } = await runAgent(
        path.join(AGENTS_DIR, "backlog_agent"),
        "serve.py",
        [],
        { owner, repo, repo_norms: repoNorms || {}, sweep_crossers: record.threshold_crossers.map((c) => c.number) },
        { GITHUB_TOKEN: token || process.env.GITHUB_TOKEN },
        240000,
      );
      record.backlog_result = extractJson(stdout);
    }
    record.status = "complete";
    record.completedAt = new Date().toISOString();
  } catch (error) {
    record.status = "failed";
    record.completedAt = new Date().toISOString();
    record.error = error.message;
  }

  sweeps.unshift({ ...record });
  if (sweeps.length > 50) sweeps.pop();
  return record;
}

/** Weekly health sweep: re-run the health agent per tracked repo so the
 * Health tab shows a fresh result without a manual trigger. */
async function runWeeklyHealthSweep(token) {
  const now = Date.now();
  if (weeklyLastRun && now - weeklyLastRun < WEEK_MS) return { skipped: true, nextRunAt: new Date(weeklyLastRun + WEEK_MS).toISOString() };
  weeklyLastRun = now;
  const { runAgent, extractJson, setHealthRun } = agentsModule();
  const results = [];
  for (const { owner, repo } of trackedRepos.values()) {
    const record = { status: "running", startedAt: new Date().toISOString(), sweepTriggered: true };
    setHealthRun(owner, repo, record);
    runAgent(
      path.join(AGENTS_DIR, "Health_agent"),
      "health_agent.py",
      ["--owner", owner, "--repo", repo],
      undefined,
      { GITHUB_TOKEN: token || process.env.GITHUB_TOKEN },
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
    results.push({ owner, repo, status: record.status });
  }
  return { skipped: false, started: results };
}

/** One pass over every tracked repo (staleness), then the weekly health
 * sweep when its time is due. Called on the interval and manually via API. */
async function sweepAll(token) {
  const started = [];
  for (const { owner, repo } of trackedRepos.values()) {
    const record = await runStalenessSweep(owner, repo, token);
    started.push({ owner, repo, status: record.status, crossers: record.threshold_crossers?.length || 0 });
  }
  const health = await runWeeklyHealthSweep(token);
  return { started, health };
}

function startScheduler() {
  if (scheduler) return;
  scheduler = setInterval(() => {
    if (trackedRepos.size === 0) return;
    sweepAll().catch((error) => console.error("Scheduled sweep failed:", error.message));
  }, SWEEP_INTERVAL_MS);
  scheduler.unref?.();
}

function status() {
  return {
    tracked_repos: trackedRepoList().length,
    sweeps_run: sweeps.length,
    staleness_runs: Array.from(stalenessRuns.values()).map(({ owner, repo, status: s, startedAt, completedAt, error, threshold_crossers }) => ({
      owner, repo, status: s, startedAt, completedAt, error, crossers: threshold_crossers || [],
    })),
    history: sweeps.map(({ owner, repo, type, status: s, startedAt, completedAt, error, threshold_crossers }) => ({
      owner, repo, type, status: s, startedAt, completedAt, error,
      crossers: (threshold_crossers || []).map(({ number, title, reason, days_open }) => ({ number, title, reason, days_open })),
    })),
  };
}

module.exports = {
  trackRepo,
  trackedRepoList,
  runStalenessSweep,
  runWeeklyHealthSweep,
  sweepAll,
  startScheduler,
  getStalenessRun: (owner, repo) => stalenessRuns.get(`${owner}/${repo}`),
  status,
};