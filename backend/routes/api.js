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
