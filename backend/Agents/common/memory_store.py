"""Shared persistent vector memory (Chroma) for all RepoGuardian agents.

Every agent ingests the issues/PRs it fetches and can retrieve similar past
items on later runs, so knowledge accumulates per repository across runs.

Design rules:
- Chroma is optional: if it is not installed or errors, every function returns
  empty results and the agents degrade to live-only behavior (never fabricate).
- Collection name is "<owner>__<repo>".
- Documents carry clean metadata (kind, number, state, resolution, ...) so
  retrieval can be filtered (e.g. only past security-sensitive issues).
- Embeddings are supplied by the caller (NVIDIA or local fallback), so the
  store works in every runtime mode.
"""

import hashlib
import math
import os
import re
from collections import Counter
from typing import Any, Dict, List, Optional

PERSIST_DIR = os.environ.get("MEMORY_STORE_DIR") or os.path.join(
    os.path.dirname(os.path.abspath(__file__)), ".memory_store"
)


def _client():
    try:
        import chromadb
        return chromadb.PersistentClient(path=PERSIST_DIR)
    except Exception:
        return None


_DENSE_DIM = 512


def _to_dense(vector: Any, dim: int = _DENSE_DIM) -> Optional[List[float]]:
    """Chroma only accepts dense float vectors. Convert sparse token dicts
    (local offline embedders) into fixed-dimension vectors via hashing."""
    if vector is None:
        return None
    if isinstance(vector, dict):  # sparse {token: weight}
        out = [0.0] * dim
        for token, weight in vector.items():
            idx = int(hashlib.md5(str(token).encode("utf-8")).hexdigest(), 16) % dim
            out[idx] += float(weight)
        norm = math.sqrt(sum(v * v for v in out)) or 1.0
        return [v / norm for v in out]
    try:
        arr = [float(x) for x in vector]
    except Exception:
        return None
    return arr


def _collection(owner: str, repo: str, tier: str = "full"):
    client = _client()
    if client is None:
        return None
    suffix = "" if tier == "full" else "__meta"
    name = re.sub(r"[^a-zA-Z0-9_]", "_", f"{owner}__{repo}{suffix}")
    try:
        return client.get_or_create_collection(name, metadata={"hnsw:space": "cosine"})
    except Exception:
        return None


def _clean_metadata(meta: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Chroma only accepts primitive metadata values (str/int/float/bool)."""
    clean: Dict[str, Any] = {}
    for key, value in (meta or {}).items():
        if value is None:
            continue
        if isinstance(value, bool):
            clean[key] = value
        elif isinstance(value, (str, int, float)):
            clean[key] = value
        elif isinstance(value, (list, tuple)):
            clean[key] = ",".join(str(v) for v in value)
    return clean


def ingest(owner: str, repo: str, items: List[Dict[str, Any]]) -> int:
    """Persist items to the repo's memory collection.

    items: [{"id": str, "text": str, "embedding": list|None, "metadata": {...},
             "tier": "meta"|"full" (default "full")}]

    Two-tier design (metadata-first retrieval):
      - "full": bodies, diffs, comments — the deep tier, queried only when a
        deeper inspection is warranted.
      - "meta": lightweight records (title, author, files changed, kind,
        state, timestamps) — the fast tier queried first; it answers "which
        PRs touched auth/ last month?" without loading full text.
    """
    by_tier: Dict[str, List[Dict[str, Any]]] = {"full": [], "meta": []}
    for item in items:
        by_tier[item.get("tier", "full")].append(item)
    total = 0
    for tier, tier_items in by_tier.items():
        col = _collection(owner, repo, tier)
        if col is None or not tier_items:
            continue
        ids, docs, metas, emb = [], [], [], []
        for item in tier_items:
            text = item.get("text")
            if not text:
                continue
            ids.append(str(item.get("id") or hashlib.sha1(text.encode("utf-8")).hexdigest()))
            docs.append(text)
            metas.append(_clean_metadata(item.get("metadata")))
            if item.get("embedding") is not None:
                emb.append(_to_dense(item["embedding"]))
        if not ids:
            continue
        try:
            if len(emb) == len(ids) and all(e is not None for e in emb):
                col.upsert(ids=ids, documents=docs, metadatas=metas, embeddings=emb)
            else:
                col.upsert(ids=ids, documents=docs, metadatas=metas)
            total += len(ids)
        except Exception:
            continue
    return total


def retrieve(
    owner: str,
    repo: str,
    query_embedding: Any,
    k: int = 5,
    where: Optional[Dict[str, Any]] = None,
    tier: str = "full",
    since: Optional[int] = None,
    until: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Top-k similar items from the repo's memory, nearest first.

    tier: "meta" (lightweight records — the fast path) or "full" (bodies/diffs).
    since/until: epoch-seconds window filter on the item's `updated_ts`
    metadata, e.g. last-30-days retrieval without loading all history.

    Each hit: {"id", "text", "metadata", "distance", "score"} (score = 1 - distance).
    """
    col = _collection(owner, repo, tier)
    if col is None or query_embedding is None:
        return []
    dense = _to_dense(query_embedding)
    if dense is None:
        return []
    if since is not None or until is not None:
        base = where or {}
        if since is not None and until is not None:
            range_where = [
                {"updated_ts": {"$gte": int(since)}},
                {"updated_ts": {"$lte": int(until)}},
            ]
            if "$and" in base:
                base["$and"] = list(base["$and"]) + range_where
            elif base:
                where = {"$and": [base, *range_where]}
            else:
                where = {"$and": range_where}
        else:
            operator = "$gte" if since is not None else "$lte"
            value = int(since) if since is not None else int(until)
            if "$and" in base:
                base["$and"] = list(base["$and"]) + [{"updated_ts": {operator: value}}]
            else:
                where = {**base, "updated_ts": {operator: value}}
    try:
        res = col.query(query_embeddings=[dense], n_results=k, where=where)
        ids = res.get("ids", [[]])[0]
        docs = res.get("documents", [[]])[0]
        metas = res.get("metadatas", [[]])[0]
        dists = res.get("distances", [[]])[0]
        return [
            {
                "id": ids[i],
                "text": docs[i],
                "metadata": metas[i] or {},
                "distance": round(float(dists[i]), 4),
                "score": round(max(0.0, 1.0 - float(dists[i])), 4),
            }
            for i in range(len(ids))
        ]
    except Exception:
        return []


def count(owner: str, repo: str) -> int:
    col = _collection(owner, repo)
    if col is None:
        return 0
    try:
        return col.count()
    except Exception:
        return 0


# ---------------------------------------------------------------------------
# Shared embedder (NVIDIA or deterministic local fallback)
# ---------------------------------------------------------------------------

def _sparse_vector(text: str) -> Dict[str, float]:
    tokens = re.findall(r"[a-z0-9_#.+-]+", text.lower())
    counts = Counter(tokens)
    norm = math.sqrt(sum(v * v for v in counts.values())) or 1.0
    return {tok: v / norm for tok, v in counts.items()}


def _has_key() -> bool:
    key = os.getenv("NVIDIA_API_KEY", "")
    return bool(key) and "your_" not in key and "xxx" not in key


class LocalEmbeddings:
    """Deterministic offline embedder (bag-of-tokens) used without an API key."""

    def embed_documents(self, texts: List[str]) -> List[Dict[str, float]]:
        return [_sparse_vector(t) for t in texts]

    def embed_query(self, text: str) -> Dict[str, float]:
        return _sparse_vector(text)


def build_embedder() -> Any:
    """NVIDIA embedder (nv-embedqa-e5-v5) if a key is configured, else local."""
    if _has_key():
        try:
            from langchain_nvidia_ai_endpoints import NVIDIAEmbeddings
            return NVIDIAEmbeddings(
                model=os.getenv("NVIDIA_EMBED_MODEL", "nvidia/nv-embedqa-e5-v5"),
                api_key=os.getenv("NVIDIA_API_KEY"),
                truncate="END",
            )
        except Exception:
            return LocalEmbeddings()
    return LocalEmbeddings()