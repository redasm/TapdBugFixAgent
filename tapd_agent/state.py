"""SQLite 状态库：控制态 / bug 任务 / 审计日志。线程安全（web + worker 共用）。"""
from __future__ import annotations

import sqlite3
import threading
import time
from typing import Any, Optional

from .models import Bug, dumps, loads

_SCHEMA = """
CREATE TABLE IF NOT EXISTS control (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    state TEXT NOT NULL,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
    bug_id INTEGER PRIMARY KEY,
    workspace_id TEXT,
    title TEXT,
    priority TEXT,
    priority_label TEXT,
    tapd_status TEXT,
    agent_state TEXT,
    changelist INTEGER,
    generated_description TEXT,
    files TEXT,
    manual_assets TEXT,
    failure_reason TEXT,
    agent TEXT,
    attempts INTEGER DEFAULT 0,
    started_at TEXT,
    finished_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT,
    level TEXT,
    bug_id INTEGER,
    msg TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_state ON jobs(agent_state);
CREATE INDEX IF NOT EXISTS idx_events_bug ON events(bug_id);
"""


def _now() -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S")


class StateStore:
    def __init__(self, path: str = "tapd_agent.db"):
        self._lock = threading.RLock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self._lock, self.conn:
            self.conn.executescript(_SCHEMA)
            self.conn.execute(
                "INSERT OR IGNORE INTO control(id, state, updated_at) VALUES (1, 'stopped', ?)",
                (_now(),),
            )

    # ---------- control ----------
    def get_control(self) -> str:
        with self._lock:
            row = self.conn.execute("SELECT state FROM control WHERE id=1").fetchone()
            return row["state"] if row else "stopped"

    def close(self) -> None:
        """关闭数据库连接（Windows 上不关闭会锁文件导致无法删除）。"""
        with self._lock:
            try:
                self.conn.close()
            except Exception:
                pass

    def set_control(self, state: str) -> str:
        with self._lock, self.conn:
            self.conn.execute(
                "UPDATE control SET state=?, updated_at=? WHERE id=1", (state, _now())
            )
        return state

    # ---------- jobs ----------
    def upsert_job(self, bug: Bug, **fields: Any) -> None:
        """插入或更新一条任务。优先保证业务关键字段。"""
        with self._lock, self.conn:
            self.conn.execute(
                """INSERT INTO jobs (bug_id, workspace_id, title, priority, priority_label,
                                     tapd_status, agent_state, started_at)
                   VALUES (?,?,?,?,?,?,?,?)
                   ON CONFLICT(bug_id) DO UPDATE SET
                     title=excluded.title,
                     priority=excluded.priority,
                     priority_label=excluded.priority_label,
                     tapd_status=excluded.tapd_status,
                     agent_state=excluded.agent_state""",
                (
                    bug.id,
                    bug.workspace_id,
                    bug.title,
                    bug.priority,
                    bug.priority_label,
                    bug.status,
                    "pending",
                    _now(),
                ),
            )
            if fields:
                self._update_fields(bug.id, fields)

    def update_job(self, bug_id: int, **fields: Any) -> None:
        with self._lock:
            self._update_fields(bug_id, fields)

    def _update_fields(self, bug_id: int, fields: dict) -> None:
        allowed = {
            "title", "priority", "priority_label", "tapd_status", "agent_state",
            "changelist", "generated_description", "files", "manual_assets",
            "failure_reason", "agent", "attempts", "started_at", "finished_at",
        }
        cols, vals = [], []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key in ("files", "manual_assets") and not isinstance(value, str):
                value = dumps(value)
            cols.append(f"{key}=?")
            vals.append(value)
        if not cols:
            return
        vals.append(bug_id)
        with self.conn:
            self.conn.execute(f"UPDATE jobs SET {', '.join(cols)} WHERE bug_id=?", vals)

    def get_job(self, bug_id: int) -> Optional[dict]:
        with self._lock:
            row = self.conn.execute(
                "SELECT * FROM jobs WHERE bug_id=?", (bug_id,)
            ).fetchone()
        return dict(row) if row else None

    def list_jobs(self, agent_state: Optional[str] = None, search: Optional[str] = None) -> list[dict]:
        sql = "SELECT * FROM jobs"
        where, params = [], []
        if agent_state and agent_state != "all":
            where.append("agent_state=?")
            params.append(agent_state)
        if search:
            where.append("(title LIKE ? OR CAST(bug_id AS TEXT) LIKE ?)")
            like = f"%{search}%"
            params.extend([like, like])
        if where:
            sql += " WHERE " + " AND ".join(where)
        sql += " ORDER BY started_at DESC, bug_id DESC"
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]

    def job_state_counts(self) -> dict:
        with self._lock:
            rows = self.conn.execute(
                "SELECT agent_state, COUNT(*) AS n FROM jobs GROUP BY agent_state"
            ).fetchall()
        return {r["agent_state"]: r["n"] for r in rows}

    def job_count(self) -> int:
        with self._lock:
            row = self.conn.execute("SELECT COUNT(*) AS n FROM jobs").fetchone()
        return int(row["n"])

    def queued_count(self) -> int:
        """仍待处理（未进入终态）的任务数。"""
        with self._lock:
            row = self.conn.execute(
                "SELECT COUNT(*) AS n FROM jobs WHERE agent_state IN ('pending','in_progress')"
            ).fetchone()
        return int(row["n"])

    # ---------- events ----------
    def add_event(self, msg: str, level: str = "info", bug_id: Optional[int] = None) -> None:
        with self._lock, self.conn:
            self.conn.execute(
                "INSERT INTO events(ts, level, bug_id, msg) VALUES (?,?,?,?)",
                (_now(), level, bug_id, msg[:2000]),
            )

    def list_events(self, bug_id: Optional[int] = None, limit: int = 200) -> list[dict]:
        if bug_id is not None:
            sql = "SELECT * FROM events WHERE bug_id=? ORDER BY id DESC LIMIT ?"
            params = (bug_id, limit)
        else:
            sql = "SELECT * FROM events ORDER BY id DESC LIMIT ?"
            params = (limit,)
        with self._lock:
            rows = self.conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
