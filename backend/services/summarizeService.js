/**
 * SummarizeService — RepoGuardian
 *
 * Hierarchical, deterministic summarization at five levels:
 *
 *   File  ->  Commit  ->  PR  ->  Repo  ->  Org
 *
 * Thousands of PRs collapse into a digest; the UI expands a level only when
 * needed. The heavy lifting (GitHub pagination, embeddings) happens in the
 * route layer; the functions here are pure so they unit-test offline.
 *
 * Latency rules:
 *   - Git history is never fully loaded: windows (7/30/90 days) bound every
 *     fetch, items are capped, and each repo's fetches run in parallel.
 *   - File level reads the vector store's lightweight "meta" tier only
 *     (metadata-first); full diffs are pulled on demand via the file endpoint.
 */

function daysAgoToEpoch(days) {
  return Math.floor(Date.now() / 1000) - days * 86400;
}

/** Collapse a repo's raw windowed data into a digest at commit/PR/issue
 * levels. `risk` = { count, items } already resolved by the route. */
function summarizeRepo(owner, repo, raw, risk = { count: 0, items: [] }, windowDays = 30) {
  const commits = raw.commits || [];
  const pulls = raw.pulls || [];
  const issues = raw.issues || [];

  const commitAuthors = new Map();
  commits.forEach((commit) => {
    const author = commit.author?.login || commit.commit?.author?.name || "unknown";
    commitAuthors.set(author, (commitAuthors.get(author) || 0) + 1);
  });
  const topCommitAuthors = [...commitAuthors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([login, count]) => ({ login, count }));

  const openPulls = pulls.filter((pull) => pull.state === "open");
  const mergedPulls = pulls.filter((pull) => pull.merged_at);
  const prAuthors = new Map();
  pulls.forEach((pull) => {
    const author = pull.user?.login || "unknown";
    prAuthors.set(author, (prAuthors.get(author) || 0) + 1);
  });

  const openIssues = issues.filter((issue) => !issue.pull_request && issue.state === "open");

  return {
    owner,
    repo,
    window_days: windowDays,
    commits: {
      count: commits.length,
      top_authors: topCommitAuthors,
      recent: commits.slice(0, 10).map((commit) => ({
        sha: commit.sha?.slice(0, 7),
        message: (commit.commit?.message || "").split("\n")[0].slice(0, 90),
        author: commit.author?.login || commit.commit?.author?.name || "unknown",
        date: commit.commit?.author?.date,
      })),
    },
    prs: {
      total: pulls.length,
      open: openPulls.length,
      merged: mergedPulls.length,
      closed: pulls.filter((pull) => pull.state === "closed" && !pull.merged_at).length,
      top_authors: [...prAuthors.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([login, count]) => ({ login, count })),
      list: pulls.slice(0, 15).map((pull) => ({
        number: pull.number,
        title: pull.title?.slice(0, 110),
        author: pull.user?.login || "unknown",
        state: pull.state,
        merged: Boolean(pull.merged_at),
        created_at: pull.created_at,
      })),
    },
    issues: {
      total: issues.length,
      open: openIssues.length,
      closed: issues.filter((issue) => !issue.pull_request && issue.state === "closed").length,
      unresolved: openIssues.length,
      list: issues
        .filter((issue) => !issue.pull_request)
        .slice(0, 15)
        .map((issue) => ({
          number: issue.number,
          title: issue.title?.slice(0, 110),
          author: issue.user?.login || "unknown",
          state: issue.state,
          created_at: issue.created_at,
        })),
    },
    risk,
  };
}

/** Collapse per-repo digests into the Org level. */
function summarizeOrg(repoDigests) {
  const totals = repoDigests.reduce(
    (acc, repo) => {
      acc.prs += repo.prs.total;
      acc.openPrs += repo.prs.open;
      acc.mergedPrs += repo.prs.merged;
      acc.issues += repo.issues.total;
      acc.openIssues += repo.issues.open;
      acc.commits += repo.commits.count;
      acc.risky += repo.risk.count;
      return acc;
    },
    { prs: 0, openPrs: 0, mergedPrs: 0, issues: 0, openIssues: 0, commits: 0, risky: 0 },
  );
  const contributorMap = new Map();
  repoDigests.forEach((repo) => {
    repo.commits.top_authors.forEach(({ login, count }) => {
      contributorMap.set(login, (contributorMap.get(login) || 0) + count);
    });
    repo.prs.top_authors.forEach(({ login, count }) => {
      contributorMap.set(login, (contributorMap.get(login) || 0) + count);
    });
  });
  const top_contributors = [...contributorMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([login, count]) => ({ login, count }));
  const riskyItems = repoDigests.flatMap((repo) =>
    (repo.risk.items || []).map((item) => ({ ...item, repo: `${repo.owner}/${repo.repo}` })),
  );
  return {
    repos: repoDigests.length,
    totals,
    top_contributors,
    risky_items: riskyItems,
    open_vs_merged: {
      open: totals.openPrs,
      merged: totals.mergedPrs,
      ratio: totals.mergedPrs > 0 ? Math.round((totals.openPrs / totals.mergedPrs) * 100) / 100 : null,
    },
  };
}

/** File-level expansion from vector-store "meta" hits: aggregate per-file
 * counts + changed lines. Metadata-first — no diff text is loaded here. */
function fileCountsFromHits(hits) {
  const files = new Map();
  (hits || []).forEach((hit) => {
    const file = hit.metadata?.file;
    if (!file) return;
    const entry = files.get(file) || {
      file,
      prs: 0,
      additions: 0,
      deletions: 0,
      last_seen: 0,
    };
    entry.prs += 1;
    entry.additions += Number(hit.metadata.additions) || 0;
    entry.deletions += Number(hit.metadata.deletions) || 0;
    const seen = Number(hit.metadata.updated_ts) || 0;
    if (seen > entry.last_seen) entry.last_seen = seen;
    files.set(file, entry);
  });
  return [...files.values()].sort((a, b) => b.prs - a.prs).slice(0, 20);
}

module.exports = { summarizeRepo, summarizeOrg, fileCountsFromHits, daysAgoToEpoch };