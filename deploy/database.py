#!/usr/bin/env python3
"""Consistent SQLite backup and integrity verification. Stop service before restore."""

import argparse
import sqlite3
from pathlib import Path

p = argparse.ArgumentParser()
p.add_argument("action", choices=["backup", "check"])
p.add_argument("database")
p.add_argument("destination", nargs="?")
a = p.parse_args()
with sqlite3.connect(
    "file:" + str(Path(a.database).resolve()) + "?mode=ro", uri=True
) as c:
    if c.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
        raise SystemExit("Database integrity check failed")
    if a.action == "backup":
        if not a.destination or Path(a.destination).exists():
            raise SystemExit("Provide a new backup filename")
        with sqlite3.connect(a.destination) as out:
            c.backup(out)
        Path(a.destination).chmod(0o600)
print("Database " + a.action + " passed.")
