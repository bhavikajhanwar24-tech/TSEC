"""Optional PostgreSQL run-history store for agent analyses.

Used by the missing-info agent to record every analysis and to surface recent
analyses of similar issues in the same repo. Entirely optional: if no
DATABASE_URL (or POSTGRES_URL) is configured, every call is a silent no-op and
the agent keeps working exactly as before.
"""

from __future__ import annotations

import os
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, unquote, urlparse

_TABLE = "agent_analyses"

try:
    import pg8000.dbapi as _pg
    _PGSQL_AVAILABLE = True
except Exception:
    _PGSQL_AVAILABLE = False


def is_configured() -> bool:
    return _PGSQL_AVAILABLE and bool(_connection_url())


def _connection_url() -> Optional[str]:
    url = os.getenv("DATABASE_URL") or os.getenv("POSTGRES_URL") or ""
    return url.strip() or None


def _parse(url: str) -> Dict[str, Any]:
    parsed = urlparse(url)
    query = parse_qs(parsed.query)
    return {
        "user": unquote(parsed.username or ""),
        "password": unquote(parsed.password or ""),
        "host": parsed.hostname or "",
        "port": parsed.port or 5432,
        "database": unquote(parsed.path.lstrip("/") or ""),
        "sslmode": (query.get("sslmode") or [""])[0],
    }


def _connect():
    import ssl
    info = _parse(_connection_url())
    kwargs = {key: info[key] for key in ("user", "password", "host", "port", "database")}
    if info["sslmode"] in ("require", "verify-ca", "verify-full"):
        kwargs["ssl_context"] = ssl.create_default_context()
    return _pg.connect(**kwargs)


def _ensure_table(conn) -> None:
    conn.run(f"""
        CREATE TABLE IF NOT EXISTS {_TABLE} (
            id SERIAL PRIMARY KEY,
            repo TEXT NOT NULL,
            issue_number INTEGER NOT NULL,
            issue_type TEXT,
            title TEXT,
            required_fields TEXT,
            present_fields TEXT,
            missing_fields TEXT,
            missing_details TEXT,
            draft_comment TEXT,
            action TEXT,
            model TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    """)


def record_analysis(owner: str, repo: str, data: Dict[str, Any]) -> bool:
    """Insert one analysis into the run history. Returns False when no DB is
    configured or the write fails (never raises)."""
    if not is_configured():
        return False
    try:
        conn = _connect()
        try:
            _ensure_table(conn)
            conn.run(
                f"""INSERT INTO {_TABLE}
                    (repo, issue_number, issue_type, title, required_fields,
                     present_fields, missing_fields, missing_details, draft_comment, action, model)
                    VALUES (:repo, :num, :type, :title, :required, :present,
                            :missing, :details, :comment, :action, :model)""",
                repo=f"{owner}/{repo}",
                num=int(data.get("issue_number") or 0),
                type=data.get("issue_type") or "",
                title=data.get("title") or "",
                required=",".join(data.get("required_fields") or []),
                present=",".join(data.get("present_fields") or []),
                missing=",".join(data.get("missing_fields") or []),
                details=" | ".join(data.get("missing_details") or []),
                comment=data.get("draft_comment") or "",
                action=data.get("action") or "",
                model=data.get("model") or "",
            )
        finally:
            conn.close()
        return True
    except Exception:
        return False


def recent_analyses(owner: str, repo: str, limit: int = 5) -> List[Dict[str, Any]]:
    """Latest analyses recorded for this repo, newest first. Empty when no DB
    is configured or the query fails (never raises)."""
    if not is_configured():
        return []
    try:
        conn = _connect()
        try:
            _ensure_table(conn)
            rows = conn.run(
                f"""SELECT issue_type, title, required_fields, present_fields,
                           missing_fields, missing_details, draft_comment, action
                    FROM {_TABLE} WHERE repo = :repo
                    ORDER BY created_at DESC LIMIT :limit""",
                repo=f"{owner}/{repo}", limit=int(limit),
            )
        finally:
            conn.close()
        return [
            {
                "issue_type": row[0] or "",
                "title": row[1] or "",
                "required_fields": [x for x in (row[2] or "").split(",") if x],
                "present_fields": [x for x in (row[3] or "").split(",") if x],
                "missing_fields": [x for x in (row[4] or "").split(",") if x],
                "missing_details": [x for x in (row[5] or "").split(" | ") if x],
                "draft_comment": row[6] or "",
                "action": row[7] or "",
            }
            for row in rows
        ]
    except Exception:
        return []