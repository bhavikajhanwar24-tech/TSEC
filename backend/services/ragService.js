const { spawn } = require("child_process");
const path = require("path");

const bridgeDir = path.join(__dirname, "..", "Agents", "common");
const bridgeScript = path.join(bridgeDir, "rag_bridge.py");

function pythonCommand() {
  return process.env.PYTHON_BIN || (process.platform === "win32" ? "python" : path.join(__dirname, "..", ".venv", "bin", "python"));
}

function runBridge(request, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonCommand(), [bridgeScript], {
      cwd: bridgeDir,
      env: process.env,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("RAG operation timed out"));
    }, timeoutMs);
    child.stdout.on("data", (data) => { stdout += data; });
    child.stderr.on("data", (data) => { stderr += data; });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.trim() || `RAG bridge exited with code ${code}`));
      try {
        resolve(JSON.parse(stdout.trim().split("\n").filter(Boolean).pop() || "{}"));
      } catch (error) {
        reject(new Error(`Invalid RAG bridge response: ${error.message}`));
      }
    });
    child.stdin.end(`${JSON.stringify(request)}\n`);
  });
}

function indexDocuments(owner, repo, items) {
  if (!items?.length) return Promise.resolve({ count: 0 });
  return runBridge({ operation: "upsert", owner, repo, items }, 30000).catch((error) => {
    console.error("RAG indexing failed:", error.message);
    return { count: 0, error: error.message };
  });
}

/** Metadata-first retrieval: query the lightweight "meta" tier by default
 * (titles, authors, files changed) — full bodies/diffs only when
 * `tier: "full"` is requested. since/until are epoch-seconds windows so
 * "last 30 days" never loads all history. */
function searchDocuments(owner, repo, question, limit = 8, options = {}) {
  return runBridge({
    operation: "query",
    owner,
    repo,
    question,
    limit,
    tier: options.tier || "meta",
    since: options.since ?? undefined,
    until: options.until ?? undefined,
  }, 12000).catch((error) => {
    console.error("RAG retrieval failed:", error.message);
    return { hits: [], error: error.message };
  });
}

module.exports = { indexDocuments, searchDocuments };
