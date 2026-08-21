const { Issue } = require("../models");
const { indexDocuments } = require("./ragService");

const GITHUB_API = "https://api.github.com";
const indexingStatus = new Map();

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "RepoGuardian",
    Accept: "application/vnd.github+json",
  };
}

async function fetchPaginatedList(url, headers, maxPages = 5) {
  const items = [];
  for (let page = 1; page <= maxPages; page++) {
    const separator = url.includes("?") ? "&" : "?";
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await fetch(`${url}${separator}per_page=100&page=${page}`, { headers });
      if (response.status !== 202) break;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
    if (response.status === 202) return { items, pending: true };
    if (!response.ok) return { items, pending: false };
    const data = await response.json().catch(() => []);
    if (!Array.isArray(data)) return { items, pending: false };
    items.push(...data);
    if (data.length < 100) break;
  }
  return { items, pending: false };
}

async function fetchCodeFrequency(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { headers });
    if (response.status !== 202) {
      return { data: response.ok ? await response.json() : [], pending: false };
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { data: [], pending: true };
}

async function buildRepoDocuments(owner, repo, token) {
  const headers = githubHeaders(token);
  const baseUrl = `${GITHUB_API}/repos/${owner}/${repo}`;

  const [repoResponse, issuesResult, pullsResult, commitsResult, contributorsResult, codeFrequency] = await Promise.all([
    fetch(baseUrl, { headers }),
    fetchPaginatedList(`${baseUrl}/issues?state=all&per_page=100`, headers, 8),
    fetchPaginatedList(`${baseUrl}/pulls?state=all&per_page=100`, headers, 8),
    fetchPaginatedList(`${baseUrl}/commits?per_page=100`, headers, 5),
    fetchPaginatedList(`${baseUrl}/contributors?anon=1&per_page=100`, headers, 5),
    fetchCodeFrequency(`${baseUrl}/stats/code_frequency`, headers),
  ]);

  const documents = [];

  if (repoResponse.ok) {
    const repoData = await repoResponse.json();
    documents.push({
      id: "repository-overview",
      source: "Repository overview",
      text: `Repository ${repoData.full_name}: ${repoData.description || "No description"}\nLanguage: ${repoData.language || "Not specified"}\nDefault branch: ${repoData.default_branch}\nVisibility: ${repoData.private ? "private" : "public"}\nStars: ${repoData.stargazers_count || 0}\nForks: ${repoData.forks_count || 0}\nOpen issues: ${repoData.open_issues_count || 0}\nCreated: ${repoData.created_at}\nUpdated: ${repoData.updated_at}\nLicense: ${repoData.license?.name || "Not specified"}`,
      metadata: { kind: "repository", source: "Repository overview" },
    });
  }

  const storedIssues = await Issue.findAll({
    where: { repoFullName: `${owner}/${repo}` },
    include: [{ association: "agentRuns" }, { association: "timelines" }],
    order: [["updatedAt", "DESC"]],
    limit: 100,
  }).catch(() => []);

  for (const issue of storedIssues) {
    const issueJson = issue.toJSON();
    const kind = issueJson.isPullRequest ? "PR" : "Issue";
    documents.push({
      id: `stored-${issueJson.githubIssueId || issueJson.number}`,
      source: `${kind} #${issueJson.number}`,
      text: `${kind} #${issueJson.number}: ${issueJson.title}\n${issueJson.body || ""}\nState: ${issueJson.state}\nWorkflow: ${issueJson.workflowStatus} at step ${issueJson.workflowStep}\n${(issueJson.agentRuns || []).map((run) => `${run.agentName} (${run.status}): ${run.reasoning}\n${JSON.stringify(run.output || {})}`).join("\n")}\n${(issueJson.timelines || []).map((t) => `${t.actor}: ${t.body}`).join("\n")}`,
      metadata: { kind: "stored_issue", number: issueJson.number, source: `${kind} #${issueJson.number}` },
    });
  }

  for (const item of issuesResult.items) {
    if (item.pull_request) continue;
    documents.push({
      id: `github-issue-${item.id || item.number}`,
      source: `Issue #${item.number}`,
      text: `Issue #${item.number}: ${item.title}\n${item.body || ""}\nState: ${item.state}\nAuthor: ${item.user?.login || "unknown"}\nCreated: ${item.created_at || ""}\nUpdated: ${item.updated_at || ""}`,
      metadata: { kind: "issue", number: item.number, source: `Issue #${item.number}` },
    });
  }

  for (const item of pullsResult.items) {
    documents.push({
      id: `github-pr-${item.id || item.number}`,
      source: `PR #${item.number}`,
      text: `PR #${item.number}: ${item.title}\n${item.body || ""}\nState: ${item.state}\nAuthor: ${item.user?.login || "unknown"}\nCreated: ${item.created_at || ""}\nUpdated: ${item.updated_at || ""}\nMerged: ${item.merged_at ? "yes" : "no"}`,
      metadata: { kind: "pr", number: item.number, source: `PR #${item.number}` },
    });
  }

  for (const commit of commitsResult.items) {
    documents.push({
      id: `commit-${commit.sha}`,
      source: `Commit ${commit.sha?.slice(0, 7) || "unknown"}`,
      text: `Commit ${commit.sha || ""}: ${commit.commit?.message || ""}\nAuthor: ${commit.author?.login || commit.commit?.author?.name || "unknown"}\nDate: ${commit.commit?.author?.date || ""}\nURL: ${commit.html_url || ""}`,
      metadata: { kind: "commit", sha: commit.sha, source: `Commit ${commit.sha?.slice(0, 7)}` },
    });
  }

  for (const contributor of contributorsResult.items) {
    documents.push({
      id: `contributor-${contributor.id || contributor.login}`,
      source: `Contributor ${contributor.login || "unknown"}`,
      text: `Contributor: ${contributor.login || "unknown"}\nContributions: ${contributor.contributions || 0}\nProfile: ${contributor.html_url || ""}`,
      metadata: { kind: "contributor", login: contributor.login, source: `Contributor ${contributor.login}` },
    });
  }

  return documents;
}

async function indexRepository(owner, repo, token) {
  const key = `${owner}/${repo}`;
  if (indexingStatus.get(key) === "running") return { status: "already_running" };
  
  indexingStatus.set(key, "running");
  
  try {
    const documents = await buildRepoDocuments(owner, repo, token);
    if (documents.length > 0) {
      await indexDocuments(owner, repo, documents);
    }
    indexingStatus.set(key, "complete");
    return { status: "complete", documentCount: documents.length };
  } catch (error) {
    console.error(`Indexing failed for ${key}:`, error.message);
    indexingStatus.set(key, "failed");
    return { status: "failed", error: error.message };
  }
}

function getIndexingStatus(owner, repo) {
  return indexingStatus.get(`${owner}/${repo}`) || "not_started";
}

function clearIndexingStatus(owner, repo) {
  indexingStatus.delete(`${owner}/${repo}`);
}

module.exports = { indexRepository, getIndexingStatus, clearIndexingStatus, buildRepoDocuments };