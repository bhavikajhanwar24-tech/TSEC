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

function requireAuth(req, res, next) {
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
      const response = await fetch(
        `${GITHUB_API}/user/repos?per_page=100&page=${page}&sort=updated`,
        { headers: githubHeaders(req.session.githubToken) }
      );

      if (!response.ok) {
        return res.status(response.status).json({ error: "GitHub API error" });
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
    const responses = await Promise.all([
      fetch(baseUrl, { headers }),
      fetch(`${baseUrl}/issues?state=all&per_page=30`, { headers }),
      fetch(`${baseUrl}/pulls?state=all&per_page=30`, { headers }),
      fetch(`${baseUrl}/commits?per_page=30`, { headers }),
      fetch(`${baseUrl}/contributors?per_page=30`, { headers }),
      fetch(`${baseUrl}/stats/code_frequency`, { headers }),
    ]);

    if (!responses[0].ok) return res.status(responses[0].status).json({ error: "Repo not found" });

    const [repoData, issues, pulls, commits, contributors, codeFrequency] = await Promise.all(
      responses.map((response) => response.json())
    );

    res.json({
      repo: repoData,
      issues: Array.isArray(issues) ? issues : [],
      pulls: Array.isArray(pulls) ? pulls : [],
      commits: Array.isArray(commits) ? commits : [],
      contributors: Array.isArray(contributors) ? contributors : [],
      codeFrequency: Array.isArray(codeFrequency) ? codeFrequency : [],
    });
  } catch (err) {
    console.error("Failed to fetch repository details:", err);
    res.status(500).json({ error: "Failed to fetch repository details" });
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
