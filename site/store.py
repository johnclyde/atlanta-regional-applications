"""Immutable catalog editions and hashed, revocable staff sessions."""

import hashlib
import json
import os
import secrets
import sqlite3
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
STATE = Path(os.environ.get("ARC_STATE", ROOT / "state"))
STATE.mkdir(parents=True, exist_ok=True)
DB = STATE / "regional.sqlite3"


def db():
    c = sqlite3.connect(DB, timeout=15)
    c.row_factory = sqlite3.Row
    c.execute("PRAGMA journal_mode=WAL")
    c.execute("PRAGMA foreign_keys=ON")
    return c


def init():
    with db() as c:
        c.executescript(
            """CREATE TABLE IF NOT EXISTS editions(id INTEGER PRIMARY KEY, created REAL NOT NULL, actor TEXT NOT NULL, note TEXT NOT NULL, catalog TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY, created REAL NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, expires REAL NOT NULL, actor TEXT NOT NULL, role TEXT NOT NULL, csrf TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS drafts(actor TEXT PRIMARY KEY, base INTEGER NOT NULL, catalog TEXT NOT NULL, updated REAL NOT NULL);"""
        )
        if not c.execute("SELECT 1 FROM editions LIMIT 1").fetchone():
            c.execute(
                "INSERT INTO editions(created,actor,note,catalog) VALUES(?,?,?,?)",
                (
                    time.time(),
                    "initial release",
                    "Public-source demonstration",
                    (ROOT / "seed/catalog.json").read_text(),
                ),
            )


def edition(revision=None):
    with db() as c:
        r = (
            c.execute("SELECT * FROM editions WHERE id=?", (revision,)).fetchone()
            if revision
            else c.execute("SELECT * FROM editions ORDER BY id DESC LIMIT 1").fetchone()
        )
    if not r:
        raise ValueError("Edition not found")
    return {
        "revision": r["id"],
        "created": r["created"],
        "catalog": json.loads(r["catalog"]),
    }


def audit(actor, action, detail):
    with db() as c:
        c.execute(
            "INSERT INTO audit(created,actor,action,detail) VALUES(?,?,?,?)",
            (time.time(), actor, action, str(detail)[:1000]),
        )


def publish(catalog, base, actor, note):
    with db() as c:
        c.execute("BEGIN IMMEDIATE")
        if c.execute("SELECT MAX(id) FROM editions").fetchone()[0] != base:
            raise RuntimeError("A newer edition exists. Reload before publishing.")
        cur = c.execute(
            "INSERT INTO editions(created,actor,note,catalog) VALUES(?,?,?,?)",
            (
                time.time(),
                actor,
                note[:500],
                json.dumps(catalog, separators=(",", ":")),
            ),
        )
        c.execute(
            "INSERT INTO audit(created,actor,action,detail) VALUES(?,?,?,?)",
            (time.time(), actor, "publish", str(cur.lastrowid)),
        )
        return cur.lastrowid


def create_session(actor, role):
    token = secrets.token_urlsafe(32)
    csrf = secrets.token_urlsafe(32)
    with db() as c:
        c.execute("DELETE FROM sessions WHERE expires<?", (time.time(),))
        c.execute(
            "INSERT INTO sessions VALUES(?,?,?,?,?)",
            (
                hashlib.sha256(token.encode()).hexdigest(),
                time.time() + 28800,
                actor,
                role,
                csrf,
            ),
        )
    return token


def session(token):
    if not token:
        return None
    with db() as c:
        r = c.execute(
            "SELECT * FROM sessions WHERE token=? AND expires>?",
            (hashlib.sha256(token.encode()).hexdigest(), time.time()),
        ).fetchone()
    return dict(r) if r else None


def revoke(token):
    with db() as c:
        c.execute(
            "DELETE FROM sessions WHERE token=?",
            (hashlib.sha256(token.encode()).hexdigest(),),
        )
