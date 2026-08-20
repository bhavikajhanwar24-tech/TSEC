/**
 * CacheService — RepoGuardian
 *
 * Small TTL cache used to cut GitHub API latency on read-heavy aggregation
 * routes (cross-repo dashboards, summaries). Keyed by method+url, values are
 * the parsed JSON. Size-capped so long-running servers don't grow unbounded.
 */

const TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 500;

const store = new Map(); // key -> { value, expiresAt }

function keyFor(url, options = {}) {
  return `${options.method || "GET"} ${url}`;
}

function get(url, options = {}) {
  const key = keyFor(url, options);
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  entry.hits = (entry.hits || 0) + 1;
  return entry.value;
}

function set(url, value, options = {}) {
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    store.delete(oldest);
  }
  store.set(keyFor(url, options), { value, expiresAt: Date.now() + TTL_MS });
}

/** fetch wrapper: returns parsed JSON, cached for TTL_MS. */
async function fetchJson(url, options = {}) {
  const cached = get(url, options);
  if (cached !== undefined) return cached;
  const response = await fetch(url, options);
  if (!response.ok) {
    const error = new Error(`GitHub API ${response.status} for ${url}`);
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  set(url, data, options);
  return data;
}

function stats() {
  return { entries: store.size, ttl_ms: TTL_MS };
}

function clear() {
  store.clear();
}

module.exports = { get, set, fetchJson, stats, clear, TTL_MS };