const express = require("express");

const router = express.Router();

const GITHUB_API = "https://api.github.com";

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

    res.json({
      repo: repoData,
      issues,
      pulls,
      commits,
      contributors,
      codeFrequency: Array.isArray(codeFrequency.data) ? codeFrequency.data : [],
      codeFrequencyPending: codeFrequency.pending,
    });
  } catch (err) {
    console.error("Failed to fetch repository details:", err);
    res.status(500).json({ error: "Failed to fetch repository details" });
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
