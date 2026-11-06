"""Bounded ArcGIS REST reads. Public data cache is separate from uploaded files."""

import concurrent.futures
import gzip
import hashlib
import json
import math
import os
import re
import threading
import time
import urllib.parse
import urllib.request
from typing import Any, TypedDict

from store import ROOT, STATE

CACHE = STATE / "cache"
CACHE.mkdir(exist_ok=True)


class FeatureBatch(TypedDict):
    """A bounded batch from the external JSON source or a validated staff layer."""

    features: list[dict[str, Any]]
    stale: bool
    fetched: float


ALLOWED = {
    "services1.arcgis.com",
    "services.arcgis.com",
    "services2.arcgis.com",
    "services3.arcgis.com",
    "services5.arcgis.com",
    "services6.arcgis.com",
    "services7.arcgis.com",
    "services8.arcgis.com",
    "services9.arcgis.com",
}
ALLOWED.update(
    x.strip() for x in os.environ.get("ARC_SOURCE_HOSTS", "").split(",") if x.strip()
)
MAX_FEATURES = 15000
REGION = {
    "13057",
    "13063",
    "13067",
    "13089",
    "13097",
    "13113",
    "13117",
    "13121",
    "13135",
    "13151",
    "13247",
}
LOCKS = {}
GUARD = threading.Lock()


def safe_url(url):
    u = urllib.parse.urlsplit(url)
    if (
        u.scheme != "https"
        or u.hostname not in ALLOWED
        or u.port not in (None, 443)
        or u.username
        or u.password
        or u.query
        or u.fragment
        or not re.search(r"/FeatureServer(?:/\d+)?$", u.path, re.I)
    ):
        raise ValueError("Use an approved HTTPS ArcGIS FeatureServer URL.")
    return url.replace(" ", "%20").rstrip("/")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise ValueError("Source redirects are not accepted.")


def remote(url, params):
    safe_url(url.removesuffix("/query"))
    req = urllib.request.Request(
        url + "?" + urllib.parse.urlencode(params),
        headers={"User-Agent": "ClydeRegionalData/1.0", "Accept": "application/json"},
    )
    with urllib.request.build_opener(NoRedirect).open(req, timeout=40) as r:
        raw = r.read(64 * 1024 * 1024 + 1)
    if len(raw) > 64 * 1024 * 1024:
        raise ValueError("Source response exceeds the 64 MB limit.")
    result = json.loads(raw)
    if "error" in result:
        raise ValueError(
            "The ArcGIS source could not complete this query: "
            + str(result["error"].get("message", "error"))
        )
    return result


def cached(url, params, ttl=86400):
    key = (
        hashlib.sha256(json.dumps([url, params], sort_keys=True).encode()).hexdigest()
        + ".json.gz"
    )
    path = CACHE / key
    seed = ROOT / "seed/cache" / key
    with GUARD:
        lock = LOCKS.setdefault(key, threading.Lock())
    with lock:
        old = None
        for p in (path, seed):
            if p.exists():
                try:
                    old = json.loads(gzip.decompress(p.read_bytes()))
                except (ValueError, OSError):
                    continue
                if time.time() - old["fetched"] < ttl:
                    return old
                break
        try:
            result = {
                "fetched": time.time(),
                "data": remote(url, params),
                "stale": False,
            }
            tmp = path.with_suffix(".tmp")
            tmp.write_bytes(
                gzip.compress(json.dumps(result, separators=(",", ":")).encode())
            )
            tmp.replace(path)
            return result
        except Exception:
            if old:
                return {**old, "stale": True}
            raise


def metadata(url):
    return cached(safe_url(url), {"f": "json"})["data"]


def features(url, fields="*", geometry=False, precise=False) -> FeatureBatch:
    url = safe_url(url)
    out = []
    offset = 0
    stale = False
    fetched = []
    while True:
        params = {
            "f": "geojson" if geometry else "json",
            "where": "1=1",
            "outFields": fields,
            "returnGeometry": "true" if geometry else "false",
            "resultRecordCount": 1000,
            "resultOffset": offset,
            "orderByFields": "OBJECTID",
        }
        if geometry:
            params.update(
                outSR=4326,
                maxAllowableOffset=0 if precise else 0.0004,
                geometryPrecision=7 if precise else 5,
            )
        result = cached(url + "/query", params)
        d = result["data"]
        part = d.get("features", [])
        out.extend(part)
        stale = stale or result.get("stale", False)
        fetched.append(result["fetched"])
        if len(out) > MAX_FEATURES:
            raise ValueError("Layer exceeds the supported 15,000-feature limit.")
        if not d.get("exceededTransferLimit") and len(part) < 1000:
            break
        if not part:
            break
        offset += len(part)
    return {"features": out, "stale": stale, "fetched": min(fetched)}


def index(catalog):
    return {d["id"]: d for d in catalog["datasets"]}, {
        g["id"]: g for g in catalog["geographies"]
    }


def indicator(catalog, key, geo):
    ds, gs = index(catalog)
    if key.count(".") != 1:
        raise ValueError("Invalid indicator identifier.")
    did, field = key.split(".")
    d = ds.get(did)
    if not d or geo not in d["layers"]:
        raise ValueError("This indicator is not available for the selected geography.")
    f = next((f for f in d["fields"] if f["name"] == field), None)
    if not f:
        raise ValueError("Indicator not found.")
    return d, f


def clean_value(v):
    if isinstance(v, int | float) and (not math.isfinite(v) or v <= -100000000):
        return None
    return v


def query(catalog, geo, keys):
    if not 1 <= len(keys) <= 40:
        raise ValueError("Select between 1 and 40 indicators.")
    ds, gs = index(catalog)
    if geo not in gs:
        raise ValueError("Geography not found.")
    grouped = {}
    fields = []
    for key in dict.fromkeys(keys):
        d, f = indicator(catalog, key, geo)
        grouped.setdefault(d["id"], []).append(f["name"])
        fields.append(
            {
                **f,
                "id": key,
                "dataset": d["title"],
                "source": d["source"],
                "period": d["period"],
                "url": d["item_url"],
            }
        )

    def load(pair):
        did, names = pair
        d = ds[did]
        if "records" in d:
            records = d["records"].get(geo, [])
            return did, {
                "features": [{"attributes": r} for r in records],
                "stale": False,
                "fetched": time.time(),
            }
        return did, features(
            d["url"] + "/" + str(d["layers"][geo]),
            ",".join([d.get("geokey", "GEOID")] + names),
        )

    rows = {}
    stale = False
    dates = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=5) as pool:
        for did, result in pool.map(load, grouped.items()):
            stale = stale or result["stale"]
            dates.append(result["fetched"])
            for feature in result["features"]:
                a = feature["attributes"]
                gid = str(a.get(ds[did].get("geokey", "GEOID"), ""))
                row = rows.setdefault(gid, {"GEOID": gid})
                overrides = ds[did].get("overrides", {}).get(geo, {}).get(gid, {})
                for f in grouped[did]:
                    row[did + "." + f] = clean_value(
                        overrides[f] if f in overrides else a.get(f)
                    )
    return {
        "rows": list(rows.values()),
        "fields": fields,
        "stale": stale,
        "fetched": min(dates),
        "geography": geo,
    }


def geometry(catalog, geo, precise=False):
    _, gs = index(catalog)
    if geo not in gs:
        raise ValueError("Geography not found.")
    g = gs[geo]
    result: FeatureBatch
    if "features" in g:
        result = {"features": g["features"], "stale": False, "fetched": time.time()}
    else:
        meta = metadata(g["url"])
        names = [f["name"] for f in meta["fields"]]
        fields = [
            n
            for n in names
            if n
            in [
                g.get("geokey", "GEOID"),
                "Name",
                "NAME",
                "ShortLabel",
                "PlanningRegion",
                "County",
                "COUNTY",
                "CountyName",
            ]
        ]
        result = features(g["url"], ",".join(fields), True, precise)
    for f in result["features"]:
        a = f["properties"]
        a["GEOID"] = str(a.get(g.get("geokey", "GEOID"), ""))
        a["label"] = str(
            a.get("ShortLabel") or a.get("Name") or a.get("NAME") or a["GEOID"]
        )
        a["region"] = (
            a["GEOID"] in REGION
            if geo == "County"
            else a.get("PlanningRegion") == "Atlanta Regional Commission"
            or (geo == "Tract" and a["GEOID"][:5] in REGION)
        )
    return {
        "type": "FeatureCollection",
        **result,
        "source": g.get("url", "Uploaded staff geography"),
        "crs_epsg": g.get("crs", 4326),
    }


def validate_catalog(c):
    if not isinstance(c, dict) or c.get("schema") != 1:
        raise ValueError("Unsupported catalog schema.")
    if (
        not 1 <= len(c.get("datasets", [])) <= 200
        or not 1 <= len(c.get("geographies", [])) <= 100
    ):
        raise ValueError("Catalog must contain 1-200 datasets and 1-100 geographies.")
    ds, gs = index(c)
    if len(ds) != len(c["datasets"]) or len(gs) != len(c["geographies"]):
        raise ValueError("Duplicate dataset or geography ID.")
    for g in c["geographies"]:
        if not re.fullmatch("[A-Za-z0-9_-]{1,80}", g["id"]):
            raise ValueError("Invalid geography ID.")
        if "features" not in g:
            safe_url(g["url"])
        else:
            if not isinstance(g["features"], list) or len(g["features"]) > MAX_FEATURES:
                raise ValueError("Too many uploaded features.")
            from shapely.geometry import shape

            seen = set()
            for f in g["features"]:
                if (
                    not isinstance(f, dict)
                    or f.get("type") != "Feature"
                    or not isinstance(f.get("properties"), dict)
                ):
                    raise ValueError("Invalid geographic feature.")
                gid = str(f["properties"].get(g.get("geokey", "GEOID"), ""))
                if not gid or gid in seen:
                    raise ValueError("Geographic IDs must be nonempty and unique.")
                seen.add(gid)
                geom = shape(f.get("geometry"))
                if not geom.is_valid or geom.is_empty:
                    raise ValueError("Invalid or empty geometry.")
                if not all(math.isfinite(v) for v in geom.bounds):
                    raise ValueError("Nonfinite geometry.")
        if not isinstance(g.get("label"), str) or not g["label"].strip():
            raise ValueError("Geography needs a display name.")
    for d in c["datasets"]:
        if not re.fullmatch("[a-z0-9-]{1,80}", d["id"]):
            raise ValueError("Invalid dataset ID.")
        if "records" not in d:
            safe_url(d["url"])
        if len(d.get("fields", [])) > 6000:
            raise ValueError("Too many fields.")
        names = [f["name"] for f in d["fields"]]
        if len(names) != len(set(names)) or any(
            not re.fullmatch("[A-Za-z][A-Za-z0-9_]{0,63}", n) for n in names
        ):
            raise ValueError("Field names must be unique GIS identifiers.")
        if any(g not in gs for g in d["layers"]):
            raise ValueError("Dataset refers to an unknown geography.")
        for k in ("title", "source", "period", "item_url"):
            if not isinstance(d.get(k), str) or not d[k].strip():
                raise ValueError("Dataset metadata is incomplete: " + k)
        if not isinstance(d.get("year"), int | float) or not math.isfinite(d["year"]):
            raise ValueError("Dataset year must be a number.")
        for f in d["fields"]:
            if not isinstance(f.get("alias"), str) or f.get("unit") not in {
                "number",
                "percent",
                "points",
                "dollars",
            }:
                raise ValueError("Field labels and units are required.")
        if "records" in d:
            if not isinstance(d["records"], dict):
                raise ValueError("Invalid imported table.")
            for geo, records in d["records"].items():
                if (
                    geo not in d["layers"]
                    or not isinstance(records, list)
                    or len(records) > MAX_FEATURES
                ):
                    raise ValueError("Invalid imported geography or record count.")
                seen = set()
                for row in records:
                    if not isinstance(row, dict):
                        raise ValueError("Invalid imported row.")
                    gid = str(row.get(d.get("geokey", "GEOID"), ""))
                    if not gid or gid in seen:
                        raise ValueError(
                            "Imported geographic IDs must be nonempty and unique."
                        )
                    seen.add(gid)
                    for name in names:
                        value = row.get(name)
                        if value is not None and (
                            not isinstance(value, int | float)
                            or not math.isfinite(value)
                        ):
                            raise ValueError(
                                "Imported indicators must be finite numbers or null."
                            )
    for goal in c.get("goals", []):
        if not isinstance(goal.get("title"), str) or not goal.get("source"):
            raise ValueError("Goals need a title and source.")
        if goal.get("page") not in {"housing", "mobility", "explorer"}:
            raise ValueError("Unknown goal application.")
        if goal.get("status") == "Completed" and not goal.get("date"):
            raise ValueError("Completed milestones need a completion date.")
        for k in ("baseline", "current", "target"):
            v = goal.get(k)
            if v is not None and (
                not isinstance(v, int | float) or not math.isfinite(v)
            ):
                raise ValueError("Goal values must be finite numbers or null.")
    for cfg in c.get("dashboards", {}).values():
        if not 1 <= len(cfg.get("indicators", [])) <= 40:
            raise ValueError("Dashboards need 1-40 indicators.")
        for key in cfg.get("indicators", []):
            indicator(c, key, cfg.get("geography", "County"))
    return c
