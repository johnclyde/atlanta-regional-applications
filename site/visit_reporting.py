"""Optional private demo reporting. Disabled by default in client deployments.

Locations are resolved from a local database. No IP address is persisted or sent
for lookup. Records contain times, public-page paths, coarse location and random
browser-session/event IDs. No content, form values, GPS or cross-site identity.
"""

import hashlib
import ipaddress
import os
import re
import threading
import time
from datetime import UTC, datetime, timedelta

ENABLED = os.environ.get("ARC_DEMO_REPORTING", "0") == "1"
GEO_DB = os.environ.get("ARC_GEO_DB", "")
PAGES = {
    "/",
    "/explorer",
    "/housing",
    "/mobility",
    "/admin",
    "/guide",
    "/delivery",
    "/about",
}
TRUSTED_PROXIES = set(os.environ.get("ARC_TRUSTED_PROXIES", "127.0.0.1,::1").split(","))
UUID = re.compile(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")
_reader = None
_geo_lock = threading.Lock()
_rates = {}
_rate_lock = threading.Lock()


def initialize(c):
    c.executescript("""CREATE TABLE IF NOT EXISTS demo_visits(
        id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE,
        occurred_at TEXT NOT NULL, session_id TEXT NOT NULL, page TEXT NOT NULL,
        country TEXT NOT NULL, region TEXT NOT NULL, city TEXT NOT NULL,
        geo_status TEXT NOT NULL, excluded INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS demo_visits_time ON demo_visits(occurred_at);
        CREATE INDEX IF NOT EXISTS demo_visits_session ON demo_visits(session_id);""")


def client_address(peer, forwarded):
    """Only trust forwarding from the loopback Caddy proxy; last hop is its client."""
    raw = (
        forwarded.split(",")[-1].strip()
        if peer in TRUSTED_PROXIES and forwarded
        else peer
    )
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return ""


def location(address):
    global _reader
    unknown = {"country": "", "region": "", "city": "", "geo_status": "unavailable"}
    try:
        ip = ipaddress.ip_address(address)
        if not ip.is_global:
            return {**unknown, "geo_status": "local network"}
        if not GEO_DB:
            return unknown
        with _geo_lock:
            if _reader is None:
                import maxminddb

                _reader = maxminddb.open_database(GEO_DB, maxminddb.MODE_MMAP)
            record = _reader.get(str(ip)) or {}
        if not isinstance(record, dict):
            return unknown

        def name(x):
            if not isinstance(x, dict) or not isinstance(x.get("names"), dict):
                return ""
            return str(x["names"].get("en", ""))[:120]

        subdivisions = record.get("subdivisions") or []
        if not isinstance(subdivisions, list):
            subdivisions = []
        return {
            "country": name(record.get("country")),
            "region": name(subdivisions[0]) if subdivisions else "",
            "city": name(record.get("city")),
            "geo_status": "approximate" if record else "unavailable",
        }
    except (ValueError, OSError, ImportError):
        return unknown


def valid_event(body):
    if not isinstance(body, dict) or set(body) != {"event_id", "session_id", "page"}:
        raise ValueError("Invalid visit event.")
    if not all(
        isinstance(body[k], str) and UUID.fullmatch(body[k])
        for k in ["event_id", "session_id"]
    ):
        raise ValueError("Invalid visit identifier.")
    p = body["page"]
    if not isinstance(p, str) or p not in PAGES:
        raise ValueError("Unknown public page.")
    return body


def record(c, body, address, authenticated=False):
    if not ENABLED or authenticated:
        return {"recorded": False}
    valid_event(body)
    now = time.time()
    with _rate_lock:
        # Transient rate state is never written to disk or returned in reports.
        for key, (_, expiry) in list(_rates.items()):
            if expiry < now:
                del _rates[key]
        count, expiry = _rates.get(address, (0, now + 60))
        if count >= 60:
            return {"recorded": False}
        if len(_rates) > 2048:
            _rates.clear()
        _rates[address] = (count + 1, expiry)
    geo = location(address)
    stamp = datetime.now(UTC).isoformat()
    cursor = c.execute(
        "INSERT OR IGNORE INTO demo_visits(event_id,occurred_at,session_id,page,country,region,city,geo_status) VALUES(?,?,?,?,?,?,?,?)",
        (
            body["event_id"],
            stamp,
            body["session_id"],
            body["page"],
            geo["country"],
            geo["region"],
            geo["city"],
            geo["geo_status"],
        ),
    )
    cutoff = (datetime.now(UTC) - timedelta(days=90)).isoformat()
    c.execute("DELETE FROM demo_visits WHERE occurred_at < ?", (cutoff,))
    c.execute(
        "DELETE FROM demo_visits WHERE id < (SELECT MAX(id)-200000 FROM demo_visits)"
    )
    return {"recorded": cursor.rowcount == 1}


def report(c, after_id=0, enabled=None):
    if type(after_id) is not int or after_id < 0:
        raise ValueError("Invalid report cursor.")
    enabled = ENABLED if enabled is None else enabled
    latest = max(
        after_id,
        c.execute(
            "SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='demo_visits'),0)"
        ).fetchone()[0],
    )
    rows = c.execute(
        "SELECT id,occurred_at,session_id,page,country,region,city,geo_status FROM demo_visits WHERE excluded=0 AND id>? ORDER BY id LIMIT 10000",
        (after_id,),
    ).fetchall()
    columns = [
        "id",
        "occurred_at",
        "session_id",
        "page",
        "country",
        "region",
        "city",
        "geo_status",
    ]
    rows = [dict(zip(columns, row)) for row in rows]
    grouped = {}
    pages = {}
    for row in rows:
        sid = row["session_id"]
        item = grouped.setdefault(
            sid,
            {
                "first_seen": row["occurred_at"],
                "last_seen": row["occurred_at"],
                "country": row["country"],
                "region": row["region"],
                "city": row["city"],
                "geo_status": row["geo_status"],
                "pages": [],
            },
        )
        item["last_seen"] = row["occurred_at"]
        item["pages"].append({"at": row["occurred_at"], "path": row["page"]})
        pages[row["page"]] = pages.get(row["page"], 0) + 1
    # Internal random IDs never leave the report; visits are anonymous sessions.
    return {
        "enabled": enabled,
        "generated_at": datetime.now(UTC).isoformat(),
        "after_id": after_id,
        "last_event_id": rows[-1]["id"] if len(rows) == 10000 else latest,
        "has_more": len(rows) == 10000,
        "pageviews": len(rows),
        "browser_sessions": len(grouped),
        "page_counts": pages,
        "visits": [
            {"session_key": hashlib.sha256(sid.encode()).hexdigest()[:20], **item}
            for sid, item in grouped.items()
        ],
        "location_note": "Approximate network location; may reflect a VPN, mobile network or provider. It does not identify the visitor.",
        "geolocation_attribution": {
            "name": "IP Geolocation by DB-IP",
            "url": "https://db-ip.com",
            "license": "CC BY 4.0",
        },
    }
