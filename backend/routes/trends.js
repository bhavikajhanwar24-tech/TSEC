/**
 * TrendsRoutes — RepoGuardian
 *
 * Cross-repo dashboards + hierarchical summaries (File -> Commit -> PR ->
 * Repo -> Org) with time-windowed, metadata-first, latency-bounded reads:
 *
 *   GET /api/trends                 cross-repo dashboard (window param)
 *   GET /api/trends/summary         hierarchical digest
 *   GET /api/trends/files/:owner/:repo   file-level expansion (meta tier)
 *
 * Every repo's GitHub fetches run in parallel (Promise.all); GitHub responses
 * ride a 5-minute TTL cache; DB risk reads are a single query. A failing repo
 * is isolated — it never fails the whole dashboard.
 */

const express = require("express");
const { Op } = require("sequelize");
const cache = require("../services/cacheService");
const sweepService = require("../services/sweepService");
const { searchDocuments } = require("../services/ragService");
const {
  summarizeRepo,
  summarizeOrg,
  fileCountsFromHits,
  daysAgoToEpoch,
} = require("../services/summarizeService");

const router = express.Router();
const GITHUB_API = "https://api.github.com";
const HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "User-Agent": "RepoGuardian",
});

function requireAuth(req, res, next) {
  if (!req.session?.githubToken) return res.status(401).json({ error: "Not authenticated" });
  next();
}

function parseWindow(raw) {
  const days = Math.max(7, Math.min(365, Number(String(raw || 30).replace(/d$/, "")) || 30));
  return { days, since: daysAgoToEpoch(days), until: Math.floor(Date.now() / 1000) };
}

async function trackedRepos() {
  const list = sweepService.trackedRepoList && sweepService.trackedRepoList();
  if (list?.length) return list;
  try {
    const { Issue } = require("../models");
    const rows = await Issue.findAll({ attributes: ["repoFullName"], group: ["repoFullName"] });
    return rows
      .map((row) => row.repoFullName)
      .filter(Boolean)
      .map((name) => {
        const [owner, repo] = name.split("/");
        return { owner, repo };
      });
  } catch {
    return [];
  }
}

async function fetchList(url, token) {
  try {
    return await cache.fetchJson(url, { headers: HEADERS(token) });
  } catch (error) {
    if (error.status === 404 || error.status === 403) return [];
    throw error;
  }
}

async function fetchRepoLatency(owner, repo, token, sinceIso) {
  const [pulls, issues, commits, contributors] = await Promise.all([
    fetchList(`${GITHUB_API}/repos/${owner}/${repo}/pulls?state=all&since=${sinceIso}&per_page=100`, token),
    fetchList(`${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&since=${sinceIso}&per_page=100`, token),
    fetchList(`${GITHUB_API}/repos/${owner}/${repo}/commits?since=${sinceIso}&per_page=100`, token),
    fetchList(`${GITHUB_API}/repos/${owner}/${repo}/contributors?per_page=100&anon=0`, token),
  ]);
  const mergedPulls = pulls.filter((pull) => pull.merged_at).length;
  const openPulls = pulls.filter((pull) => pull.state === "open").length;
  const closedPulls = pulls.filter((pull) => pull.state === "closed" && !pull.merged_at).length;
  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === "open").length;
  const closedIssues = issues.filter((issue) => !issue.pull_request && issue.state === "closed").length;
  const mergedLate = pulls.filter((pull) => {
    if (!pull.merged_at || !pull.created_at) return false;
    return new Date(pull.merged_at) - new Date(pull.created_at) > 7 * 86400000;
  });
  return {
    owner,
    repo,
    pulls: { open: openPulls, merged: mergedPulls, closed: closedPulls, total: pulls.length },
    issues: { open: openIssues, closed: closedIssues, unresolved: openIssues },
    commits: commits.length,
    contributors: Array.isArray(contributors) ? contributors.length : 0,
    merge_latency_7d_plus: mergedLate.length,
    latest_activity: pulls[0]?.updated_at || commits[0]?.commit?.author?.date || null,
  };
}

async function riskFromDb(token, sinceEpoch) {
  try {
    const { AgentRun, Issue } = require("../models");
    const runs = await AgentRun.findAll({
      where: { confidence: { [Op.gte]: 0.6 } },
      include: [{ model: Issue, as: "issue" }],
      limit: 500,
    });
    const since = new Date(sinceEpoch * 1000);
    const items = runs
      .filter((run) => {
        const issue = run.issue;
        if (!issue || !issue.createdAt) return false;
        const category = String(run.category || "").toLowerCase();
        if (!category.includes("secur") && !category.includes("sensitiv")) return false;
        return new Date(issue.createdAt) >= since;
      })
      .slice(0, 25)
      .map((run) => ({
        number: run.issue.number,
        title: run.issue.title,
        repo: run.issue.repoFullName,
        category: run.category,
        confidence: run.confidence,
        reasoning: String(run.reasoning || "").slice(0, 220),
      }));
    return { count: items.length, items };
  } catch {
    return { count: 0, items: [] };
  }
}

router.get(["/", "/trends"], requireAuth, async (req, res) => {
  const { days, since, until } = parseWindow(req.query.window);
  const token = req.session.githubToken;
  const sinceIso = new Date(since * 1000).toISOString();
  const repos = await trackedRepos();
  const started = Date.now();
  const results = await Promise.all(
    repos.map(async (entry) => {
      try {
        const row = await fetchRepoLatency(entry.owner, entry.repo, token, sinceIso);
        return { ...row, error: null };
      } catch (error) {
        return { owner: entry.owner, repo: entry.repo, error: error.message };
      }
    }),
  );
  const risk = await riskFromDb(token, since);
  const ok = results.filter((row) => !row.error);
  const totals = ok.reduce(
    (acc, row) => {
      acc.openPulls += row.pulls.open;
      acc.mergedPulls += row.pulls.merged;
      acc.closedPulls += row.pulls.closed;
      acc.openIssues += row.issues.open;
      acc.closedIssues += row.issues.closed;
      acc.commits += row.commits;
      acc.contributors += row.contributors;
      acc.lateMerges += row.merge_latency_7d_plus;
      return acc;
    },
    { openPulls: 0, mergedPulls: 0, closedPulls: 0, openIssues: 0, closedIssues: 0, commits: 0, contributors: 0, lateMerges: 0 },
  );
  res.json({
    window_days: days,
    since_epoch: since,
    until_epoch: until,
    generated_ms: Date.now() - started,
    repos: ok,
    errors: results.filter((row) => row.error).map((row) => ({ owner: row.owner, repo: row.repo, error: row.error })),
    totals,
    risk,
  });
});

router.get(["/summary", "/trends/summary"], requireAuth, async (req, res) => {
  const { days, since, until } = parseWindow(req.query.window);
  const token = req.session.githubToken;
  const sinceIso = new Date(since * 1000).toISOString();
  const repos = await trackedRepos();
  const risk = await riskFromDb(token, since);
  const riskByRepo = new Map();
  risk.items.forEach((item) => {
    const key = String(item.repo || "");
    riskByRepo.set(key, (riskByRepo.get(key) || 0) + 1);
  });
  const started = Date.now();
  const digests = await Promise.all(
    repos.map(async (entry) => {
      try {
        const [pulls, commits, issues] = await Promise.all([
          fetchList(`${GITHUB_API}/repos/${entry.owner}/${entry.repo}/pulls?state=all&since=${sinceIso}&per_page=100`, token),
          fetchList(`${GITHUB_API}/repos/${entry.owner}/${entry.repo}/commits?since=${sinceIso}&per_page=100`, token),
          fetchList(`${GITHUB_API}/repos/${entry.owner}/${entry.repo}/issues?state=all&since=${sinceIso}&per_page=100`, token),
        ]);
        const repoKey = `${entry.owner}/${entry.repo}`;
        const repoRisk = {
          count: riskByRepo.get(repoKey) || 0,
          items: risk.items.filter((item) => String(item.repo) === repoKey),
        };
        return summarizeRepo(entry.owner, entry.repo, { pulls, commits, issues }, repoRisk, days);
      } catch (error) {
        return summarizeRepo(entry.owner, entry.repo, { pulls: [], commits: [], issues: [] }, { count: 0, items: [] }, days);
      }
    }),
  );
  const org = summarizeOrg(digests);
  res.json({ window_days: days, since_epoch: since, until_epoch: until, generated_ms: Date.now() - started, org, repos: digests });
});

/** File-level expansion (File <- Commit <- PR <- Repo <- Org). Reads the
 * vector store's lightweight "meta" tier only — diffs are NOT loaded here;
 * this is the collapse/expand step of the hierarchy. */
router.get(["/files/:owner/:repo", "/trends/files/:owner/:repo"], requireAuth, async (req, res) => {
  const { days, since, until } = parseWindow(req.query.window);
  const { owner, repo } = req.params;
  const result = await searchDocuments(
    owner,
    repo,
    "which files changed",
    60,
    { tier: "meta", since, until },
  );
  const files = fileCountsFromHits(result.hits);
  res.json({
    owner,
    repo,
    window_days: days,
    since_epoch: since,
    until_epoch: until,
    file_count: files.length,
    files,
    hint: "metadata-first: only lightweight records were queried; fetch diffs on demand",
  });
});

module.exports = router;