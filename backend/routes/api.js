const express = require("express");
const { indexDocuments, searchDocuments } = require("../services/ragService");

const router = express.Router();

const GITHUB_API = "https://api.github.com";
const chatCache = new Map();

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "RepoGuardian",
    Accept: "application/vnd.github+json",
  };
}

async function fetchCodeFrequency(url, headers) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, { headers });
    if (response.status !== 202) {
      return { data: response.ok ? await response.json() : [], pending: false };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return { data: [], pending: true };
}

async function fetchOptionalList(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) return [];
  const data = await response.json().catch(() => []);
  return Array.isArray(data) ? data : [];
}

function tokens(value) {
  return new Set(String(value || "").toLowerCase().match(/[a-z0-9_#-]{3,}/g) || []);
}

function rankDocuments(documents, question) {
  const queryTokens = tokens(question);
  return documents
    .map((document) => {
      const documentTokens = tokens(document.text);
      const score = [...queryTokens].reduce((total, token) => total + (documentTokens.has(token) ? 1 : 0), 0);
      return { ...document, score };
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 12);
}

function compact(value, limit = 1800) {
  const text = String(value || "").trim();
  return text.length > limit ? `${text.slice(0, limit)}...` : text;
}

function semanticDocuments(hits) {
  return (hits || []).map((hit) => ({
    id: hit.id,
    source: hit.metadata?.source || `${hit.metadata?.kind || "Record"}${hit.metadata?.number ? ` #${hit.metadata.number}` : ""}`,
    text: hit.text || "",
    score: Number(hit.score || 0),
  }));
}

async function answerWithNvidia(question, context) {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.NVIDIA_CHAT_MODEL || process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
        temperature: 0.1,
        max_tokens: 700,
        messages: [
          { role: "system", content: "You are RepoGuardian's repository historian. Answer only from the supplied repository context. Be concise and precise. Distinguish confirmed facts from inference. If the context does not contain the answer, say that clearly and suggest where to look. Never invent issue numbers, PRs, fixes, authors, dates, or status. Do not reveal hidden reasoning." },
          { role: "user", content: `Question:\n${question}\n\nRepository context:\n${context}` },
        ],
      }),
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function requireAuth(req, res, next) {
  if (req.path.startsWith("/webhooks")) return next();
  if (!req.session.githubToken) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

router.use(requireAuth);

router.get("/repos", async (req, res) => {
  try {
    const repos = [];
    let page = 1;

    while (true) {
      const params = new URLSearchParams({
        per_page: "100",
        page: String(page),
        sort: "updated",
      });
      const response = await fetch(
        `${GITHUB_API}/user/repos?${params}`,
        { headers: githubHeaders(req.session.githubToken) }
      );

      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        console.error("GitHub repositories error:", error);
        return res.status(response.status).json({ error: error.message || "GitHub API error" });
      }

      const data = await response.json();
      repos.push(...data);
      if (data.length < 100) break;
      page++;
    }

    res.json(repos);
  } catch (err) {
    console.error("Failed to fetch repos:", err);
    res.status(500).json({ error: "Failed to fetch repos" });
  }
});

router.get("/repos/:owner/:repo/details", async (req, res) => {
  const { owner, repo } = req.params;
  const headers = githubHeaders(req.session.githubToken);
  const baseUrl = `${GITHUB_API}/repos/${owner}/${repo}`;

  try {
    const [repoResponse, issues, pulls, commits, contributors, codeFrequency] = await Promise.all([
      fetch(baseUrl, { headers }),
      fetchOptionalList(`${baseUrl}/issues?state=all&per_page=30`, headers),
      fetchOptionalList(`${baseUrl}/pulls?state=all&per_page=30`, headers),
      fetchOptionalList(`${baseUrl}/commits?per_page=30`, headers),
      fetchOptionalList(`${baseUrl}/contributors?per_page=30`, headers),
      fetchCodeFrequency(`${baseUrl}/stats/code_frequency`, headers),
    ]);

    if (!repoResponse.ok) return res.status(repoResponse.status).json({ error: "Repo not found" });

    const repoData = await repoResponse.json();
    const contributorFallback = commits.reduce((byLogin, commit) => {
      const login = commit.author?.login || commit.commit?.author?.name;
      if (!login) return byLogin;
      const current = byLogin.get(login) || {
        id: `commit-author-${login}`,
        login,
        avatar_url: commit.author?.avatar_url || "",
        contributions: 0,
      };
      current.contributions += 1;
      byLogin.set(login, current);
      return byLogin;
    }, new Map());
    const normalizedContributors = contributors.length
      ? contributors.map((contributor) => ({
        ...contributor,
        login: contributor.login || contributor.name || "Anonymous contributor",
        contributions: Number(contributor.contributions) || 0,
      }))
      : [...contributorFallback.values()].sort((left, right) => right.contributions - left.contributions);

    res.json({
      repo: repoData,
      issues,
      pulls,
      commits,
      contributors: normalizedContributors,
      codeFrequency: Array.isArray(codeFrequency.data) ? codeFrequency.data : [],
      codeFrequencyPending: codeFrequency.pending,
    });
  } catch (err) {
    console.error("Failed to fetch repository details:", err);
    res.status(500).json({ error: "Failed to fetch repository details" });
  }
});

router.post("/repos/:owner/:repo/chat", async (req, res) => {
  const { owner, repo } = req.params;
  const question = String(req.body?.question || "").trim();
  if (!question) return res.status(400).json({ error: "A question is required" });
  if (question.length > 1200) return res.status(400).json({ error: "Question is too long" });
  const cacheKey = `${owner}/${repo}:${question.toLowerCase()}`;
  const cached = chatCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return res.json({ ...cached.value, cached: true });
  chatCache.delete(cacheKey);

  try {
    const { Issue } = require("../models");
    const storedIssuesPromise = Issue.findAll({
      where: { repoFullName: `${owner}/${repo}` },
      include: [{ association: "agentRuns" }, { association: "timelines" }],
      order: [["updatedAt", "DESC"]],
      limit: 80,
    }).catch((error) => {
      console.error("Repository chat database retrieval failed:", error.message);
      return [];
    });
    const headers = githubHeaders(req.session.githubToken);
    const [storedIssues, repository, githubIssues, githubCommits, githubContributors] = await Promise.all([
      storedIssuesPromise,
      fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers })
        .then((response) => response.ok ? response.json() : null)
        .catch(() => null),
      fetchOptionalList(`${GITHUB_API}/repos/${owner}/${repo}/issues?state=all&per_page=80`, headers),
      fetchOptionalList(`${GITHUB_API}/repos/${owner}/${repo}/commits?per_page=50`, headers),
      fetchOptionalList(`${GITHUB_API}/repos/${owner}/${repo}/contributors?per_page=50`, headers),
    ]);

    const documents = [];
    if (repository) {
      documents.push({
        id: "repository-overview",
        source: "Repository overview",
        text: `Repository ${repository.full_name}: ${repository.description || "No description"}\nLanguage: ${repository.language || "Not specified"}\nDefault branch: ${repository.default_branch}\nVisibility: ${repository.private ? "private" : "public"}\nStars: ${repository.stargazers_count || 0}\nForks: ${repository.forks_count || 0}\nOpen issues: ${repository.open_issues_count || 0}\nCreated: ${repository.created_at}\nUpdated: ${repository.updated_at}\nLicense: ${repository.license?.name || "Not specified"}`,
      });
    }
    storedIssues.forEach((issue) => {
      const issueJson = issue.toJSON();
      const kind = issueJson.isPullRequest ? "PR" : "Issue";
      documents.push({
        id: `stored-${issueJson.githubIssueId || issueJson.number}`,
        source: `${kind} #${issueJson.number}`,
        text: `${kind} #${issueJson.number}: ${issueJson.title}\n${issueJson.body || ""}\nState: ${issueJson.state}\nWorkflow: ${issueJson.workflowStatus} at step ${issueJson.workflowStep}\n${(issueJson.agentRuns || []).map((run) => `${run.agentName} (${run.status}): ${run.reasoning}\n${JSON.stringify(run.output || {})}`).join("\n")}\n${(issueJson.timelines || []).map((timeline) => `${timeline.actor}: ${timeline.body}`).join("\n")}`,
      });
    });
    githubIssues.forEach((item) => {
      documents.push({
        id: `github-${item.id || item.number}`,
        source: `${item.pull_request ? "PR" : "Issue"} #${item.number}`,
        text: `${item.pull_request ? "PR" : "Issue"} #${item.number}: ${item.title}\n${item.body || ""}\nState: ${item.state}\nAuthor: ${item.user?.login || "unknown"}\nCreated: ${item.created_at || ""}\nUpdated: ${item.updated_at || ""}`,
      });
    });
    githubCommits.forEach((commit) => {
      documents.push({
        id: `commit-${commit.sha}`,
        source: `Commit ${commit.sha?.slice(0, 7) || "unknown"}`,
        text: `Commit ${commit.sha || ""}: ${commit.commit?.message || ""}\nAuthor: ${commit.author?.login || commit.commit?.author?.name || "unknown"}\nDate: ${commit.commit?.author?.date || ""}\nURL: ${commit.html_url || ""}`,
      });
    });
    githubContributors.forEach((contributor) => {
      documents.push({
        id: `contributor-${contributor.id || contributor.login}`,
        source: `Contributor ${contributor.login || "unknown"}`,
        text: `Contributor: ${contributor.login || "unknown"}\nContributions: ${contributor.contributions || 0}\nProfile: ${contributor.html_url || ""}`,
      });
    });

    const indexable = documents.map(({ id, source, text }) => ({ id, text, metadata: { kind: "repository", source } }));
    let semantic = semanticDocuments((await searchDocuments(owner, repo, question, 8)).hits);
    if (!semantic.length && indexable.length) {
      await indexDocuments(owner, repo, indexable);
      semantic = semanticDocuments((await searchDocuments(owner, repo, question, 8)).hits);
    }
    const keyword = rankDocuments(documents, question);
    const combined = [...semantic, ...keyword].filter((document, index, all) => all.findIndex((item) => item.id === document.id) === index).slice(0, 12);
    const context = combined.length
      ? combined.slice(0, 8).map((document) => `SOURCE: ${document.source}\n${compact(document.text, 900)}`).join("\n\n")
      : "No stored issue, pull request, or workflow records were found for this repository.";
    const answer = await answerWithNvidia(question, context);
    const fallback = combined.length
      ? `I found ${combined.length} related repository record${combined.length === 1 ? "" : "s"}: ${combined.map((document) => document.source).join(", ")}. Review the matching records in the dashboard for the confirmed details.`
      : "I could not find matching issue, pull request, or workflow history for that question.";
    const value = { answer: answer || fallback, sources: combined.map(({ source, score }) => ({ source, score })) };
    chatCache.set(cacheKey, { value, expiresAt: Date.now() + 60_000 });
    if (chatCache.size > 200) chatCache.delete(chatCache.keys().next().value);
    res.json(value);
  } catch (error) {
    console.error("Repository chat error:", error);
    res.status(500).json({ error: "Repository chat is temporarily unavailable" });
  }
});

router.get("/repos/:owner/:repo/commits/:sha", async (req, res) => {
  const { owner, repo, sha } = req.params;

  try {
    const response = await fetch(`${GITHUB_API}/repos/${owner}/${repo}/commits/${sha}`, {
      headers: githubHeaders(req.session.githubToken),
    });
    const data = await response.json();
    if (!response.ok) return res.status(response.status).json({ error: data.message || "Failed to fetch commit changes" });
    res.json(data);
  } catch (err) {
    console.error("Failed to fetch commit changes:", err);
    res.status(500).json({ error: "Failed to fetch commit changes" });
  }
});

router.get("/repos/:owner/:repo/tree", async (req, res) => {
  const { owner, repo } = req.params;
  const headers = githubHeaders(req.session.githubToken);

  try {
    const repoRes = await fetch(`${GITHUB_API}/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) {
      return res.status(repoRes.status).json({ error: "Repo not found" });
    }
    const repoData = await repoRes.json();

    const treeRes = await fetch(
      `${GITHUB_API}/repos/${owner}/${repo}/git/trees/${repoData.default_branch}?recursive=1`,
      { headers }
    );
    if (!treeRes.ok) {
      return res.status(treeRes.status).json({ error: "Failed to fetch repository tree" });
    }
    const tree = await treeRes.json();

    res.json({ default_branch: repoData.default_branch, tree });
  } catch (err) {
    console.error("Failed to fetch tree:", err);
    res.status(500).json({ error: "Failed to fetch repository tree" });
  }
});

module.exports = router;
