const express = require("express");
const { searchDocuments } = require("../services/ragService");
const { indexRepository, getIndexingStatus } = require("../services/indexingService");
const { ChatSession, ChatMessage } = require("../models");

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

async function fetchPaginatedList(url, headers, maxPages = 100) {
  const items = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const separator = url.includes("?") ? "&" : "?";
    let response;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      response = await fetch(`${url}${separator}per_page=100&page=${page}`, { headers });
      if (response.status !== 202) break;
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
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
    const [repoResponse, issues, pulls, commits, contributorResult, codeFrequency] = await Promise.all([
      fetch(baseUrl, { headers }),
      fetchOptionalList(`${baseUrl}/issues?state=all&per_page=30`, headers),
      fetchOptionalList(`${baseUrl}/pulls?state=all&per_page=30`, headers),
      fetchOptionalList(`${baseUrl}/commits?per_page=30`, headers),
      fetchPaginatedList(`${baseUrl}/contributors?anon=1`, headers),
      fetchCodeFrequency(`${baseUrl}/stats/code_frequency`, headers),
    ]);

    if (!repoResponse.ok) return res.status(repoResponse.status).json({ error: "Repo not found" });

    const repoData = await repoResponse.json();
    const contributors = contributorResult.items;
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
      contributorsPending: contributorResult.pending,
    });
  } catch (err) {
    console.error("Failed to fetch repository details:", err);
    res.status(500).json({ error: "Failed to fetch repository details" });
  }
});

router.post("/repos/:owner/:repo/chat", async (req, res) => {
  const { owner, repo } = req.params;
  const question = String(req.body?.question || "").trim();
  const sessionId = req.body?.sessionId;
  const stream = req.body?.stream === true;
  
  if (!question) return res.status(400).json({ error: "A question is required" });
  if (question.length > 2000) return res.status(400).json({ error: "Question is too long" });

  try {
    let session;
    if (sessionId) {
      session = await ChatSession.findByPk(sessionId, { include: [{ model: ChatMessage, as: "messages", order: [["createdAt", "ASC"]], limit: 20 }] });
    }
    if (!session) {
      session = await ChatSession.create({ owner, repo, githubUserId: req.session.githubUser?.login || req.session.githubUserId });
    }

    await ChatMessage.create({ sessionId: session.id, role: "user", content: question });

    const status = getIndexingStatus(owner, repo);
    if (status !== "complete") {
      indexRepository(owner, repo, req.session.githubToken).catch(() => {});
    }

    const result = await searchDocuments(owner, repo, question, 10, { tier: "meta" });
    const semantic = (result.hits || []).map((hit) => ({
      id: hit.id,
      source: hit.metadata?.source || `${hit.metadata?.kind || "Record"}${hit.metadata?.number ? ` #${hit.metadata.number}` : ""}`,
      text: hit.text || "",
      score: Number(hit.score || 0),
    }));

    const context = semantic.length
      ? semantic.slice(0, 6).map((doc) => `SOURCE: ${doc.source}\n${doc.text.slice(0, 1200)}`).join("\n\n")
      : "No indexed repository records found yet. Indexing may still be in progress.";

    const history = session.messages?.slice(-10).map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`).join("\n") || "";

    const apiKey = process.env.NVIDIA_API_KEY;
    if (!apiKey) {
      const fallback = semantic.length
        ? `I found ${semantic.length} relevant records: ${semantic.map((d) => d.source).join(", ")}. (Configure NVIDIA_API_KEY for AI responses.)`
        : "Repository not indexed yet. Please wait a moment and try again.";
      const assistantMsg = await ChatMessage.create({ sessionId: session.id, role: "assistant", content: fallback });
      return res.json({ answer: fallback, sources: semantic.map(({ source, score }) => ({ source, score })), sessionId: session.id });
    }

    const messages = [
      { role: "system", content: `You are RepoGuardian, an AI assistant for GitHub repository analysis. You have access to indexed repository data (issues, PRs, commits, contributors, agent analyses).

Guidelines:
- Answer naturally and conversationally, like a knowledgeable colleague
- Use the provided context to give specific, accurate answers with references
- If context doesn't contain the answer, say so and suggest where to look (GitHub UI, specific files, etc.)
- Cite sources inline like [Issue #123] or [PR #45] when making specific claims
- Don't invent issue numbers, PRs, fixes, authors, dates, or status
- Keep responses concise but complete
- You can discuss code, architecture, history, team dynamics, and workflow patterns` },
      { role: "user", content: `Conversation history:\n${history || "(none)"}\n\nRepository context:\n${context}\n\nQuestion: ${question}` },
    ];

    if (stream) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.setHeader("Transfer-Encoding", "chunked");
      res.setHeader("X-Session-Id", session.id);

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30000);

      try {
        const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
          method: "POST",
          signal: controller.signal,
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: process.env.NVIDIA_CHAT_MODEL || process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
            temperature: 0.3,
            max_tokens: 1500,
            stream: true,
            messages,
          }),
        });

        if (!response.ok) throw new Error(`NVIDIA API error: ${response.status}`);

        let fullAnswer = "";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          const lines = chunk.split("\n");
          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data);
                const content = parsed.choices?.[0]?.delta?.content;
                if (content) {
                  fullAnswer += content;
                  res.write(content);
                }
              } catch {}
            }
          }
        }

        await ChatMessage.create({ sessionId: session.id, role: "assistant", content: fullAnswer });
        res.end();
      } catch (error) {
        console.error("Streaming error:", error.message);
        if (!res.writableEnded) {
          res.write("\n\n[Error: Failed to stream response]");
          res.end();
        }
      } finally {
        clearTimeout(timeout);
      }
      return;
    }

    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: process.env.NVIDIA_CHAT_MODEL || process.env.NVIDIA_MODEL || "nvidia/nemotron-3-ultra-550b-a55b",
        temperature: 0.3,
        max_tokens: 1500,
        messages,
      }),
    });

    if (!response.ok) throw new Error(`NVIDIA API error: ${response.status}`);

    const data = await response.json();
    const answer = data.choices?.[0]?.message?.content?.trim() || "No response generated.";
    
    await ChatMessage.create({ sessionId: session.id, role: "assistant", content: answer });

    res.json({ answer, sources: semantic.map(({ source, score }) => ({ source, score })), sessionId: session.id });
  } catch (error) {
    console.error("Repository chat error:", error);
    res.status(500).json({ error: "Repository chat is temporarily unavailable" });
  }
});

router.get("/repos/:owner/:repo/chat/sessions", async (req, res) => {
  try {
    const sessions = await ChatSession.findAll({
      where: { owner, repo, githubUserId: req.session.githubUser?.login || req.session.githubUserId },
      order: [["updatedAt", "DESC"]],
      limit: 20,
      include: [{ model: ChatMessage, as: "messages", limit: 1, order: [["createdAt", "DESC"]] }],
    });
    res.json(sessions);
  } catch (error) {
    console.error("Chat sessions error:", error);
    res.status(500).json({ error: "Failed to load chat sessions" });
  }
});

router.get("/repos/:owner/:repo/chat/sessions/:sessionId", async (req, res) => {
  try {
    const session = await ChatSession.findOne({
      where: { id: req.params.sessionId, owner, repo },
      include: [{ model: ChatMessage, as: "messages", order: [["createdAt", "ASC"]] }],
    });
    if (!session) return res.status(404).json({ error: "Session not found" });
    res.json(session);
  } catch (error) {
    console.error("Chat session error:", error);
    res.status(500).json({ error: "Failed to load chat session" });
  }
});

router.delete("/repos/:owner/:repo/chat/sessions/:sessionId", async (req, res) => {
  try {
    const session = await ChatSession.findOne({ where: { id: req.params.sessionId, owner, repo } });
    if (!session) return res.status(404).json({ error: "Session not found" });
    await session.destroy();
    res.json({ deleted: true });
  } catch (error) {
    console.error("Chat session delete error:", error);
    res.status(500).json({ error: "Failed to delete chat session" });
  }
});

router.post("/repos/:owner/:repo/chat/index", async (req, res) => {
  try {
    const result = await indexRepository(req.params.owner, req.params.repo, req.session.githubToken);
    res.json(result);
  } catch (error) {
    console.error("Manual index error:", error);
    res.status(500).json({ error: "Failed to trigger indexing" });
  }
});

router.get("/repos/:owner/:repo/chat/index/status", async (req, res) => {
  res.json({ status: getIndexingStatus(req.params.owner, req.params.repo) });
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
