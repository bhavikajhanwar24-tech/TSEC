/**
 * Planner tool inventory — RepoGuardian
 *
 * The eight tools the Planner draws from when investigating an event. All
 * reads are best-effort and never crash the pipeline. Write actions
 * (postComment / applyLabel) are GATED: they refuse to run unless called with
 * `approved: true`, which only the UI approval endpoint may set.
 */

const { searchDocuments } = require("./ragService");

const GITHUB_API = "https://api.github.com";
const USER_AGENT = "RepoGuardian";

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": USER_AGENT,
  };
}

function ghGet(url, token, params) {
  const full = new URL(url);
  if (params) Object.entries(params).forEach(([key, value]) => full.searchParams.set(key, String(value)));
  return fetch(full, { headers: ghHeaders(token) }).then(async (response) => {
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`GitHub ${response.status}: ${error.message || url}`);
    }
    return response.json();
  });
}

/** Best-effort wrapper: any failure resolves to a safe empty/sentinel value. */
function bestEffort(promise, fallback) {
  return promise.catch((error) => ({ ...fallback, error: error.message }));
}

/**
 * 1. vector_search — semantic search over the repo's RAG memory (issues, PRs,
 * comments, commits, past agent decisions). Reuses the same Chroma corpus the
 * other agents read and write.
 */
function vectorSearch(owner, repo, question, token, limit = 5) {
  return searchDocuments(owner, repo, question, limit).then((result) => {
    const hits = (result.hits || []).map((hit) => ({
      id: hit.id,
      text: String(hit.text || "").slice(0, 400),
      score: Math.round(Number(hit.score) * 100) / 100,
      metadata: hit.metadata || {},
    }));
    return { tool: "vector_search", hits };
  });
}

/** 2. fetch_issue — full issue thread with timeline-relevant fields. */
function fetchIssue(owner, repo, number, token) {
  return bestEffort(
    ghGet(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, token).then((issue) => ({
      tool: "fetch_issue",
      issue: {
        number: issue.number,
        title: issue.title,
        state: issue.state,
        state_reason: issue.state_reason || null,
        body: String(issue.body || "").slice(0, 2000),
        labels: (issue.labels || []).map((label) => label.name),
        user: issue.user?.login || null,
        created_at: issue.created_at,
        closed_at: issue.closed_at || null,
        comments_url: issue.comments_url,
      },
    })),
    { tool: "fetch_issue", issue: null },
  );
}

/** 2b. fetch_pr — pull request details plus head commit for CI checks. */
function fetchPr(owner, repo, number, token) {
  return bestEffort(
    ghGet(`${GITHUB_API}/repos/${owner}/${repo}/pulls/${number}`, token).then((pr) => ({
      tool: "fetch_pr",
      pull_request: {
        number: pr.number,
        title: pr.title,
        state: pr.state,
        body: String(pr.body || "").slice(0, 2000),
        user: pr.user?.login || null,
        head_sha: pr.head?.sha || null,
        base: pr.base?.ref || null,
        head: pr.head?.ref || null,
        created_at: pr.created_at,
      },
    })),
    { tool: "fetch_pr", pull_request: null },
  );
}

/**
 * 3. search_linked_prs — find PRs referencing an issue (or vice versa) using
 * the GitHub search API scoped to the repo. Best effort: returns [] on error.
 */
function searchLinkedPrs(owner, repo, number, token) {
  const query = `repo:${owner}/${repo} type:pr "${number}"`;
  return bestEffort(
    ghGet(`${GITHUB_API}/search/issues`, token, { q: query, per_page: 5 }).then((data) => ({
      tool: "search_linked_prs",
      linked: (data.items || []).map((item) => ({
        number: item.number,
        title: item.title,
        state: item.state,
        url: item.html_url,
      })),
    })),
    { tool: "search_linked_prs", linked: [] },
  );
}

/**
 * 4. check_ci_status — pull CI/build status for a commit (Checks API).
 * Repos without checks configured resolve to { configured: false }.
 */
function checkCiStatus(owner, repo, headSha, token) {
  if (!headSha) {
    return Promise.resolve({ tool: "check_ci_status", configured: false, reason: "no head sha available", runs: [] });
  }
  return bestEffort(
    ghGet(`${GITHUB_API}/repos/${owner}/${repo}/commits/${headSha}/check-runs`, token).then((data) => ({
      tool: "check_ci_status",
      configured: Number(data.total_count || 0) > 0,
      runs: (data.check_runs || []).map((run) => ({
        name: run.name,
        status: run.status,
        conclusion: run.conclusion || null,
        url: run.html_url || null,
      })),
    })),
    { tool: "check_ci_status", configured: false, runs: [] },
  );
}

/* 5. keyword_scan — fast rule-based pass for security/sensitive language.
   Mirrors the Sensitivity Agent's regex classifiers (JS port). Patterns are
   Python-style strings compiled with the `i` flag (JS has no inline (?i)). */
const KEYWORD_RULES = [
  { label: "AWS access key", pattern: "\\bAKIA[0-9A-Z]{16}\\b", flags: "" },
  { label: "API key in plaintext", pattern: "\\bapi[_-]?key\\s*[:=]\\s*\\S{8,}", flags: "i" },
  { label: "client secret in plaintext", pattern: "\\bclient[_-]?secret\\s*[:=]\\s*\\S{8,}", flags: "i" },
  { label: "bearer/token value", pattern: "\\b(?:bearer\\s+|token\\s*[:=])\\s*[A-Za-z0-9._~+/=-]{16,}", flags: "i" },
  { label: "password value", pattern: "\\bpassword\\s*[:=]\\s*\\S{4,}", flags: "i" },
  { label: "private key material", pattern: "-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----", flags: "" },
  { label: "DB connection string with credentials", pattern: "\\bmongodb(?:\\+srv)?:\\/\\/[^\\s]+:[^\\s]+@", flags: "i" },
  { label: "authentication bypass", pattern: "\\bauth(?:entication)?\\s+bypass\\b", flags: "i" },
  { label: "privilege escalation", pattern: "\\bprivilege\\s+escalation\\b", flags: "i" },
  { label: "unauthorized access", pattern: "\\bunauthorized\\s+access\\b", flags: "i" },
  { label: "SQL injection", pattern: "\\bsql\\s+injection\\b", flags: "i" },
  { label: "XSS payload", pattern: "\\b(?:<script[^>]*>|onerror\\s*=)", flags: "" },
  { label: "command injection", pattern: "\\bcommand\\s+injection\\b", flags: "i" },
  { label: "remote code execution", pattern: "\\bremote\\s+code\\s+execution\\b|\\brce\\b", flags: "i" },
  { label: "path traversal", pattern: "\\bpath\\s+traversal\\b|\\.\\.\\/\\.\\.\\/", flags: "i" },
  { label: "CVE reference", pattern: "\\bCVE-\\d{4}-\\d{4,}\\b", flags: "" },
  { label: "GitHub Security Advisory reference", pattern: "\\bGHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}\\b", flags: "" },
  { label: "exploit", pattern: "\\bexploit\\b", flags: "i" },
  { label: "zero-day", pattern: "\\bzero[-\\s]?day\\b", flags: "i" },
  { label: "vulnerability", pattern: "\\bvulnerabilit(?:y|ies)\\b", flags: "i" },
];

function keywordScan(text) {
  const matches = [];
  KEYWORD_RULES.forEach((rule) => {
    const regex = new RegExp(rule.pattern, rule.flags);
    if (regex.test(text)) matches.push({ label: rule.label, matched: true });
  });
  return { tool: "keyword_scan", security_indicators: matches, flagged: matches.length > 0 };
}

/**
 * 6. get_repo_conventions — pull CONTRIBUTING.md / SECURITY.md / issue
 * templates. A cached repoNorms object (when provided) short-circuits the
 * API calls.
 */
function getRepoConventions(owner, repo, token, repoNorms) {
  if (repoNorms && Object.keys(repoNorms).length) {
    return Promise.resolve({
      tool: "get_repo_conventions",
      conventions: {
        has_contributing: true,
        contributing_guidelines: repoNorms.contributing_guidelines || "",
        auto_close_threshold_days: repoNorms.auto_close_threshold_days || 30,
        has_security_policy: Boolean(repoNorms.security_policy),
      },
      source: "cached repo norms",
    });
  }
  const readRaw = (path) =>
    fetch(`${GITHUB_API}/repos/${owner}/${repo}/contents/${path}`, {
      headers: { ...ghHeaders(token), Accept: "application/vnd.github.raw+json" },
    })
      .then((response) => (response.ok ? response.text() : ""))
      .catch(() => "");
  return Promise.all([readRaw("CONTRIBUTING.md"), readRaw("SECURITY.md")]).then(
    ([contributing, security]) => ({
      tool: "get_repo_conventions",
      conventions: {
        has_contributing: Boolean(contributing),
        contributing_guidelines: contributing ? contributing.slice(0, 800) : "",
        has_security_policy: Boolean(security),
        security_policy: security ? security.slice(0, 500) : "",
        auto_close_threshold_days: 30,
      },
      source: "live repo files",
    }),
  );
}

/**
 * 7. get_contributor_history — past activity/reputation of an author:
 * commit contributions plus how many comments they left in the repo.
 */
function getContributorHistory(owner, repo, login, token) {
  if (!login) {
    return Promise.resolve({ tool: "get_contributor_history", author: null, history: null });
  }
  return bestEffort(
    ghGet(`${GITHUB_API}/repos/${owner}/${repo}/contributors`, token, { per_page: 30 }).then((contributors) => {
      const match = (contributors || []).find((item) => item.login === login);
      return {
        tool: "get_contributor_history",
        author: login,
        history: {
          commits_contributed: match ? Number(match.contributions) || 0 : 0,
          is_top_contributor: Boolean(match),
          first_time: !match,
        },
      };
    }),
    { tool: "get_contributor_history", author: login, history: null },
  );
}

/**
 * 8. post_comment / apply_label — WRITE actions. Gated: they only execute
 * when called with `approved: true` (set exclusively by the UI approval
 * endpoint). The planner only ever receives the gated preview.
 */
function postComment(owner, repo, number, token, body, { approved = false } = {}) {
  if (!approved) {
    return Promise.resolve({ tool: "post_comment", gated: true, preview: String(body).slice(0, 500) });
  }
  return fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}/comments`, {
    method: "POST",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ body }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub comment failed (${response.status})`);
    const comment = await response.json();
    return { tool: "post_comment", gated: false, comment_url: comment.html_url };
  });
}

function applyLabel(owner, repo, number, token, labels, { approved = false } = {}) {
  if (!approved) {
    return Promise.resolve({ tool: "apply_label", gated: true, preview: { labels } });
  }
  return fetch(`${GITHUB_API}/repos/${owner}/${repo}/issues/${number}`, {
    method: "PATCH",
    headers: { ...ghHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ labels }),
  }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub label failed (${response.status})`);
    const issue = await response.json();
    return { tool: "apply_label", gated: false, labels: (issue.labels || []).map((label) => label.name) };
  });
}

module.exports = {
  vectorSearch,
  fetchIssue,
  fetchPr,
  searchLinkedPrs,
  checkCiStatus,
  keywordScan,
  getRepoConventions,
  getContributorHistory,
  postComment,
  applyLabel,
};