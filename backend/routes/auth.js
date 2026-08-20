const express = require("express");
const crypto = require("crypto");

const router = express.Router();

const GITHUB_AUTH_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API = "https://api.github.com";

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    "User-Agent": "RepoGuardian",
    Accept: "application/vnd.github+json",
  };
}

router.get("/github", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    scope: "repo read:user",
    state,
  });

  res.redirect(`${GITHUB_AUTH_URL}?${params}`);
});

router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || state !== req.session.oauthState) {
    return res.status(400).send("Invalid OAuth state");
  }

  try {
    const tokenRes = await fetch(GITHUB_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: process.env.GITHUB_CLIENT_ID,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
      }),
    });

    const data = await tokenRes.json();
    if (!data.access_token) {
      return res.status(400).send("Failed to exchange code for token");
    }

    const userRes = await fetch(`${GITHUB_API}/user`, {
      headers: githubHeaders(data.access_token),
    });
    const user = await userRes.json();

    req.session.githubToken = data.access_token;
    req.session.githubUser = user;
    delete req.session.oauthState;

    res.redirect(process.env.FRONTEND_URL || "/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth login failed");
  }
});

router.get("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/"));
});

router.get("/me", (req, res) => {
  if (req.session.githubUser) {
    res.json(req.session.githubUser);
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});

module.exports = router;
