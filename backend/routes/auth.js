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

function createOAuthState() {
  const payload = Buffer.from(JSON.stringify({
    nonce: crypto.randomBytes(16).toString("hex"),
    expiresAt: Date.now() + 10 * 60 * 1000,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", process.env.SESSION_SECRET || "dev-secret-change-me")
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

function isValidOAuthState(state) {
  try {
    const [payload, signature] = state.split(".");
    const expected = crypto.createHmac("sha256", process.env.SESSION_SECRET || "dev-secret-change-me")
      .update(payload)
      .digest("base64url");
    const validSignature = signature && payload && crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    );
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return validSignature && data.expiresAt > Date.now();
  } catch {
    return false;
  }
}

router.get("/github", (req, res) => {
  const state = createOAuthState();

  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID,
    scope: "read:user user:email repo",
    state,
  });

  res.redirect(`${GITHUB_AUTH_URL}?${params}`);
});

router.get("/github/install", (req, res) => {
  const configuredUrl = process.env.GITHUB_APP_INSTALL_URL;
  const appSlug = process.env.GITHUB_APP_SLUG || "repoguardian";
  const installUrl = configuredUrl || `https://github.com/apps/${encodeURIComponent(appSlug)}/installations/new`;
  res.redirect(installUrl);
});

router.get("/github/callback", async (req, res) => {
  const { code, state } = req.query;

  if (!code || !state || !isValidOAuthState(state)) {
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
    req.session.save((err) => {
      if (err) {
        console.error("OAuth session save error:", err);
        return res.status(500).send("OAuth login failed");
      }
      res.redirect(process.env.FRONTEND_URL || "/");
    });
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth login failed");
  }
});

router.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error("Logout session destroy error:", err);
      return res.status(500).json({ error: "Logout failed" });
    }

    res.clearCookie("connect.sid", {
      httpOnly: true,
      sameSite: process.env.NODE_ENV === "production" || process.env.FRONTEND_URL?.startsWith("https://") ? "none" : "lax",
      secure: process.env.NODE_ENV === "production" || process.env.FRONTEND_URL?.startsWith("https://"),
    });

    if (req.query.format === "json") return res.json({ loggedOut: true });
    res.redirect(process.env.FRONTEND_URL || "/");
  });
});

router.get("/me", (req, res) => {
  if (req.session.githubUser) {
    res.json(req.session.githubUser);
  } else {
    res.status(401).json({ error: "Not logged in" });
  }
});

module.exports = router;
