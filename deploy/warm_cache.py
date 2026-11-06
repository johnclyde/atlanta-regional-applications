#!/usr/bin/env python3
"""Warm only the approved public source cache, never staff or uploaded records."""

import concurrent.futures
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "site"))
import providers

c = json.loads((ROOT / "site/seed/catalog.json").read_text())


def warm(geo):
    providers.geometry(c, geo)
    for cfg in c["dashboards"].values():
        providers.query(c, geo, cfg["indicators"])
    print("Public cache ready:", geo, flush=True)


with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
    list(pool.map(warm, ["County", "City", "Tract"]))
