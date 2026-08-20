"""JSON-lines bridge between the Node API and the shared Chroma memory store."""
from __future__ import annotations

import json
import sys
from typing import Any, Dict, List

import memory_store


def embedder():
    return memory_store.build_embedder()


def upsert(owner: str, repo: str, items: List[Dict[str, Any]]) -> Dict[str, Any]:
    model = embedder()
    texts = [str(item.get("text") or "") for item in items]
    embeddings = model.embed_documents(texts)
    payload = []
    for item, vector in zip(items, embeddings):
        payload.append({
            "id": item.get("id"),
            "text": item.get("text"),
            "embedding": vector,
            "metadata": item.get("metadata") or {},
            "tier": item.get("tier", "full"),
        })
    return {"count": memory_store.ingest(owner, repo, payload)}


def query(owner: str, repo: str, question: str, limit: int, tier: str = "full", since: int = None, until: int = None) -> Dict[str, Any]:
    model = embedder()
    return {
        "hits": memory_store.retrieve(
            owner, repo, model.embed_query(question), k=limit,
            tier=tier, since=since, until=until,
        )
    }


def main() -> None:
    for line in sys.stdin:
        if not line.strip():
            continue
        request = json.loads(line)
        operation = request.get("operation")
        if operation == "upsert":
            result = upsert(request["owner"], request["repo"], request.get("items") or [])
        elif operation == "query":
            result = query(
                request["owner"],
                request["repo"],
                request["question"],
                int(request.get("limit") or 8),
                tier=str(request.get("tier") or "full"),
                since=int(request["since"]) if request.get("since") is not None else None,
                until=int(request["until"]) if request.get("until") is not None else None,
            )
        else:
            raise ValueError(f"Unknown RAG operation: {operation}")
        print(json.dumps(result), flush=True)


if __name__ == "__main__":
    main()
