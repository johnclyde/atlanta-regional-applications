"""Three regional-data applications with one versioned staff workspace."""

import asyncio
import base64
import hashlib
import hmac
import io
import json
import os
import re
import secrets
import time
from collections import defaultdict, deque
from pathlib import Path

import formats
import providers
import store
from authlib.integrations.starlette_client import OAuth
from starlette.applications import Starlette
from starlette.concurrency import run_in_threadpool
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.sessions import SessionMiddleware
from starlette.responses import (
    FileResponse,
    HTMLResponse,
    JSONResponse,
    RedirectResponse,
    Response,
)
from starlette.routing import Mount, Route
from starlette.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent
ORIGIN = os.environ.get("ARC_ORIGIN", "http://127.0.0.1:8788").rstrip("/")
TENANT = os.environ.get("ARC_ENTRA_TENANT", "")
CLIENT = os.environ.get("ARC_ENTRA_CLIENT", "")
COOKIE = "arc_staff"
MAX_BODY = 32 * 1024 * 1024
semaphore = asyncio.Semaphore(2)
rates = defaultdict(deque)
store.init()
oauth = OAuth()
if TENANT and CLIENT:
    if not re.fullmatch("[a-fA-F0-9-]{36}", TENANT):
        raise RuntimeError("Use the exact Entra tenant UUID.")
    oauth.register(
        name="entra",
        client_id=CLIENT,
        client_secret=os.environ["ARC_ENTRA_SECRET"],
        server_metadata_url=f"https://login.microsoftonline.com/{TENANT}/v2.0/.well-known/openid-configuration",
        client_kwargs={"scope": "openid profile", "code_challenge_method": "S256"},
    )


def password_hash(password, salt=None):
    salt = salt or secrets.token_hex(16)
    return (
        salt
        + ":"
        + hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1).hex()
    )


def who(request):
    return store.session(request.cookies.get(COOKIE, ""))


def require(request, role="editor"):
    s = who(request)
    if not s:
        raise PermissionError("Sign in to manage published data.")
    if role == "publisher" and s["role"] != "publisher":
        raise PermissionError("A publisher role is required.")
    if request.method not in {"GET", "HEAD"}:
        same_origin(request)
        if not hmac.compare_digest(request.headers.get("x-csrf-token", ""), s["csrf"]):
            raise PermissionError("Invalid request token. Reload the workspace.")
    return s


def same_origin(request):
    if request.headers.get("origin") != ORIGIN:
        raise PermissionError("This operation must originate from the application.")


def rate(request, key, limit=60):
    # Ephemeral rate-limit keys, never written to analytics or request logs.
    peer = request.client.host if request.client else "unknown"
    bucket = rates[(key, peer)]
    now = time.monotonic()
    while bucket and bucket[0] < now - 60:
        bucket.popleft()
    if len(bucket) >= limit:
        raise ValueError("Too many requests. Try again in a minute.")
    bucket.append(now)


async def body(request):
    raw = await request.body()
    if len(raw) > MAX_BODY:
        raise ValueError("Request exceeds 32 MB.")
    return json.loads(raw)


async def health(request):
    e = store.edition()
    c = e["catalog"]
    return JSONResponse(
        {
            "ok": True,
            "revision": e["revision"],
            "datasets": len(c["datasets"]),
            "indicators": sum(
                sum(not f.get("moe") for f in d["fields"]) for d in c["datasets"]
            ),
            "geographies": len(c["geographies"]),
        }
    )


async def catalog(request):
    return JSONResponse(store.edition())


async def indicators(request):
    q = request.query_params
    words = q.get("q", "").lower().split()
    topic = q.get("topic")
    geo = q.get("geo", "County")
    moe = q.get("moe") == "1"
    out = []
    for d in store.edition()["catalog"]["datasets"]:
        if geo not in d["layers"] or topic and topic != d["id"]:
            continue
        for f in d["fields"]:
            if not moe and f.get("moe"):
                continue
            text = " ".join(
                [f["alias"], f["name"], d["title"], d["source"], str(d["year"])]
            ).lower()
            if all(w in text for w in words):
                out.append(
                    {
                        **f,
                        "id": d["id"] + "." + f["name"],
                        "dataset": d["title"],
                        "year": d["year"],
                        "source": d["source"],
                        "url": d["item_url"],
                        "period": d["period"],
                    }
                )
    offset = max(0, int(q.get("offset", 0)))
    return JSONResponse({"total": len(out), "results": out[offset : offset + 60]})


async def geographic(request):
    rate(request, "read", 120)
    result = await run_in_threadpool(
        providers.geometry,
        store.edition()["catalog"],
        request.query_params.get("geo", "County"),
    )
    return JSONResponse(result)


async def data(request):
    rate(request, "read", 120)
    q = request.query_params
    result = await run_in_threadpool(
        providers.query,
        store.edition()["catalog"],
        q.get("geo", "County"),
        q.get("keys", "").split(","),
    )
    return JSONResponse(result)


async def housing(request):
    return FileResponse(ROOT / "seed/housing.json", media_type="application/json")


async def preview(request):
    same_origin(request)
    rate(request, "preview", 40)
    p = await body(request)
    c = providers.validate_catalog(p["catalog"])
    if p.get("kind") == "geography":
        result = await run_in_threadpool(providers.geometry, c, p.get("geo", "County"))
    else:
        result = await run_in_threadpool(
            providers.query, c, p.get("geo", "County"), p.get("keys", [])
        )
    return JSONResponse(result)


async def import_file(request):
    same_origin(request)
    rate(request, "convert", 12)
    async with semaphore:
        form = await request.form(
            max_files=1, max_fields=2, max_part_size=formats.MAX_BYTES
        )
        f = form.get("file")
        if not f or not hasattr(f, "read"):
            raise ValueError("Choose a file.")
        raw = await f.read(formats.MAX_BYTES + 1)
        try:
            r = await run_in_threadpool(
                formats.convert, f.filename, raw, form.get("layer")
            )
        finally:
            await f.close()
        return JSONResponse(r)


def make_export(c, p):
    geo = p.get("geo", "County")
    keys = p.get("keys", [])
    result = providers.query(c, geo, keys)
    fc = providers.geometry(c, geo, True)
    wanted = set(map(str, p.get("selected", [])))
    only_selected = "selected" in p
    values = {r["GEOID"]: r for r in result["rows"]}
    fields = []
    names = set()
    for f in result["fields"]:
        name = f["name"]
        if name in names:
            name = f["id"].replace(".", "_").replace("-", "_")[:64]
        names.add(name)
        fields.append({**f, "name": name})
    custom = p.get("custom") or {}
    custom_rows = custom.get("rows", [])
    if len(custom_rows) > 15000:
        raise ValueError("Too many user rows.")
    join = custom.get("join", "GEOID")
    custom_index = {str(r.get(join, "")): r for r in custom_rows}
    cfields = []
    for i, col in enumerate(custom.get("fields", [])[:40]):
        name = "user_" + re.sub("[^A-Za-z0-9_]", "_", str(col))[:45] + "_" + str(i + 1)
        cfields.append(
            {
                "id": name,
                "name": name,
                "alias": str(col),
                "source": "User supplied",
                "period": "",
                "url": "",
            }
        )
    rows = []
    features = []
    for f in fc["features"]:
        a = f["properties"]
        gid = a["GEOID"]
        if only_selected and gid not in wanted:
            continue
        row = {"GEOID": gid, "Name": a["label"]}
        for field in fields:
            row[field["name"]] = values.get(gid, {}).get(field["id"])
        for field in cfields:
            row[field["name"]] = custom_index.get(gid, {}).get(field["alias"])
        rows.append(row)
        features.append(
            {"type": "Feature", "properties": row, "geometry": f["geometry"]}
        )
    fields += cfields
    kind = p.get("kind", "csv")
    if kind in {"csv", "xlsx"}:
        return formats.export_table(rows, fields, kind)
    return formats.export_geo(
        {"type": "FeatureCollection", "features": features},
        fields,
        kind,
        fc["crs_epsg"],
    )


async def export(request):
    same_origin(request)
    rate(request, "export", 12)
    p = await body(request)
    c = (
        providers.validate_catalog(p["catalog"])
        if p.get("catalog")
        else store.edition()["catalog"]
    )
    async with semaphore:
        raw, mime, name = await run_in_threadpool(make_export, c, p)
    return Response(
        raw,
        media_type=mime,
        headers={
            "Content-Disposition": f'attachment; filename="{name}"',
            "Cache-Control": "no-store",
        },
    )


async def report(request):
    same_origin(request)
    rate(request, "report", 12)
    p = await body(request)

    def build():
        from PIL import Image
        from reportlab.lib.utils import ImageReader
        from reportlab.pdfgen import canvas

        raw = base64.b64decode(p.get("image", "").split(",")[-1], validate=True)
        if len(raw) > 10 * 1024 * 1024:
            raise ValueError("Graphic exceeds 10 MB.")
        im = Image.open(io.BytesIO(raw))
        if im.width * im.height > 16000000:
            raise ValueError("Graphic dimensions are too large.")
        out = io.BytesIO()
        pdf = canvas.Canvas(out, pagesize=(792, 612))
        pdf.setTitle(str(p.get("title", "Regional data"))[:150])
        pdf.setFont("Helvetica-Bold", 18)
        pdf.drawString(36, 574, str(p.get("title", "Regional data"))[:80])
        pdf.drawImage(
            ImageReader(im),
            36,
            80,
            width=720,
            height=470,
            preserveAspectRatio=True,
            anchor="c",
        )
        pdf.setFont("Helvetica", 9)
        for i, line in enumerate(str(p.get("source", "")).split("\n")[:3]):
            pdf.drawString(36, 56 - i * 12, line[:145])
        pdf.showPage()
        pdf.save()
        return out.getvalue()

    return Response(
        await run_in_threadpool(build),
        media_type="application/pdf",
        headers={
            "Content-Disposition": 'attachment; filename="regional-data.pdf"',
            "Cache-Control": "no-store",
        },
    )


async def auth_status(request):
    s = who(request)
    return JSONResponse(
        {
            "signed_in": bool(s),
            "actor": s["actor"] if s else None,
            "role": s["role"] if s else None,
            "csrf": s["csrf"] if s else None,
            "entra": bool(TENANT and CLIENT),
            "owner_login": bool(os.environ.get("ARC_OWNER_HASH")) and not TENANT,
        }
    )


async def owner_login(request):
    same_origin(request)
    rate(request, "login", 5)
    if TENANT or not os.environ.get("ARC_OWNER_HASH"):
        raise PermissionError("Owner password sign-in is disabled.")
    p = await body(request)
    saved = os.environ["ARC_OWNER_HASH"]
    password = str(p.get("password", ""))
    if len(password) > 512 or not hmac.compare_digest(
        password_hash(password, saved.split(":")[0]), saved
    ):
        raise PermissionError("Sign-in failed.")
    token = store.create_session("Demo owner", "publisher")
    r = JSONResponse({"ok": True})
    r.set_cookie(
        COOKIE,
        token,
        httponly=True,
        secure=ORIGIN.startswith("https:"),
        samesite="strict",
        max_age=28800,
    )
    store.audit("Demo owner", "sign in", "owner")
    return r


async def entra_login(request):
    if not TENANT:
        raise PermissionError("Entra sign-in requires the client tenant configuration.")
    return await oauth.entra.authorize_redirect(request, ORIGIN + "/auth/callback")


async def callback(request):
    if not TENANT:
        raise PermissionError("Entra is not configured.")
    token = await oauth.entra.authorize_access_token(request)
    user = token.get("userinfo", {})
    roles = user.get("roles", [])
    if user.get("tid") != TENANT or not set(roles) & {"ARC.Editor", "ARC.Publisher"}:
        raise PermissionError("This account has no assigned application role.")
    role = "publisher" if "ARC.Publisher" in roles else "editor"
    actor = str(user.get("oid", ""))
    if not actor:
        raise PermissionError("Missing staff identity.")
    request.session.clear()
    session = store.create_session(actor, role)
    r = RedirectResponse("/admin")
    r.set_cookie(
        COOKIE, session, httponly=True, secure=True, samesite="strict", max_age=28800
    )
    store.audit(actor, "sign in", "Entra " + role)
    return r


async def logout(request):
    s = require(request)
    store.revoke(request.cookies[COOKIE])
    request.session.clear()
    r = JSONResponse({"ok": True})
    r.delete_cookie(COOKIE)
    store.audit(s["actor"], "sign out", "")
    return r


async def save_draft(request):
    s = require(request)
    p = await body(request)
    providers.validate_catalog(p["catalog"])
    with store.db() as c:
        c.execute(
            "INSERT OR REPLACE INTO drafts VALUES(?,?,?,?)",
            (s["actor"], int(p["revision"]), json.dumps(p["catalog"]), time.time()),
        )
    store.audit(s["actor"], "save draft", p["revision"])
    return JSONResponse({"ok": True})


async def draft(request):
    s = require(request)
    with store.db() as c:
        r = c.execute("SELECT * FROM drafts WHERE actor=?", (s["actor"],)).fetchone()
    return JSONResponse(
        {"revision": r["base"], "catalog": json.loads(r["catalog"])}
        if r
        else store.edition()
    )


async def publish(request):
    s = require(request, "publisher")
    p = await body(request)
    catalog = providers.validate_catalog(p["catalog"])
    try:
        r = store.publish(
            catalog,
            int(p["revision"]),
            s["actor"],
            str(p.get("note", "Staff publication")),
        )
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"revision": r})


async def history(request):
    require(request)
    with store.db() as c:
        editions = [
            dict(r)
            for r in c.execute(
                "SELECT id,created,actor,note FROM editions ORDER BY id DESC LIMIT 100"
            )
        ]
        audit = [
            dict(r) for r in c.execute("SELECT * FROM audit ORDER BY id DESC LIMIT 100")
        ]
    return JSONResponse({"editions": editions, "audit": audit})


async def restore(request):
    s = require(request, "publisher")
    p = await body(request)
    old = store.edition(int(p["edition"]))
    try:
        r = store.publish(
            old["catalog"],
            int(p["revision"]),
            s["actor"],
            "Restored edition " + str(p["edition"]),
        )
    except RuntimeError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return JSONResponse({"revision": r})


async def inspect_source(request):
    same_origin(request)
    rate(request, "inspect", 15)
    p = await body(request)
    url = providers.safe_url(str(p.get("url", "")))
    return JSONResponse(await run_in_threadpool(providers.metadata, url))


async def page(request):
    if os.environ.get("ARC_AUDIT_DIR"):
        html = (
            (ROOT / "static/index.html")
            .read_text()
            .replace(
                "</head>",
                '<script src="/__audit/axe.min.js" defer></script><script src="/__audit/audit.js" defer></script></head>',
            )
        )
        return HTMLResponse(html)
    return FileResponse(ROOT / "static/index.html", media_type="text/html")


async def error(request, exc):
    code = (
        403
        if isinstance(exc, PermissionError)
        else 400
        if isinstance(exc, ValueError | KeyError | TypeError)
        else 502
    )
    msg = (
        str(exc)
        if code != 502
        else "The data service is temporarily unavailable. Try again; previously loaded data remain available."
    )
    return JSONResponse({"error": msg}, status_code=code)


routes = [
    Route("/api/health", health),
    Route("/api/catalog", catalog),
    Route("/api/indicators", indicators),
    Route("/api/geography", geographic),
    Route("/api/data", data),
    Route("/api/housing", housing),
    Route("/api/preview", preview, methods=["POST"]),
    Route("/api/import", import_file, methods=["POST"]),
    Route("/api/export", export, methods=["POST"]),
    Route("/api/report", report, methods=["POST"]),
    Route("/api/auth", auth_status),
    Route("/api/login", owner_login, methods=["POST"]),
    Route("/api/logout", logout, methods=["POST"]),
    Route("/auth/login", entra_login),
    Route("/auth/callback", callback),
    Route("/api/draft", draft),
    Route("/api/draft", save_draft, methods=["POST"]),
    Route("/api/publish", publish, methods=["POST"]),
    Route("/api/history", history),
    Route("/api/restore", restore, methods=["POST"]),
    Route("/api/inspect", inspect_source, methods=["POST"]),
    Mount("/static", StaticFiles(directory=ROOT / "static"), name="static"),
] + [
    Route(p, page)
    for p in [
        "/",
        "/explorer",
        "/housing",
        "/mobility",
        "/admin",
        "/guide",
        "/delivery",
        "/about",
    ]
]
app = Starlette(
    routes=routes,
    exception_handlers={
        Exception: error,
        ValueError: error,
        PermissionError: error,
        KeyError: error,
    },
)
if os.environ.get("ARC_AUDIT_DIR"):
    app.mount("/__audit", StaticFiles(directory=os.environ["ARC_AUDIT_DIR"]))
secret = os.environ.get("ARC_SESSION_SECRET")
if not secret:
    secret_path = store.STATE / "session-secret"
    if not secret_path.exists():
        secret_path.write_text(secrets.token_urlsafe(48))
        secret_path.chmod(0o600)
    secret = secret_path.read_text()
app.add_middleware(
    SessionMiddleware,
    secret_key=secret,
    https_only=ORIGIN.startswith("https:"),
    same_site="lax",
    max_age=600,
)


class RequestLimit:
    """Bound actual request bytes, including chunked multipart requests."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        try:
            length = int(dict(scope["headers"]).get(b"content-length", b"0"))
            if length < 0:
                raise ValueError
        except ValueError:
            return await JSONResponse(
                {"error": "Invalid request length."}, status_code=400
            )(scope, receive, send)
        if length > MAX_BODY:
            return await JSONResponse(
                {"error": "Request exceeds 32 MB."}, status_code=413
            )(scope, receive, send)
        if scope["method"] not in {"POST", "PUT", "PATCH"}:
            return await self.app(scope, receive, send)
        chunks = []
        size = 0
        while True:
            message = await receive()
            if message["type"] == "http.disconnect":
                return
            chunk = message.get("body", b"")
            size += len(chunk)
            if size > MAX_BODY:
                return await JSONResponse(
                    {"error": "Request exceeds 32 MB."}, status_code=413
                )(scope, receive, send)
            chunks.append(chunk)
            if not message.get("more_body", False):
                break
        raw = b"".join(chunks)
        sent = False

        async def replay():
            nonlocal sent
            if not sent:
                sent = True
                return {"type": "http.request", "body": raw, "more_body": False}
            return await receive()

        await self.app(scope, replay, send)


app.add_middleware(RequestLimit)


async def headers(request, call_next):
    response = await call_next(request)
    response.headers.update(
        {
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "strict-origin-when-cross-origin",
            "X-Frame-Options": "SAMEORIGIN",
            "Permissions-Policy": "geolocation=(), camera=(), microphone=()",
            "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://tile.openstreetmap.org https://server.arcgisonline.com; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'; worker-src 'self' blob:",
        }
    )
    if request.url.path.startswith("/api/") or request.url.path.startswith("/auth/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.add_middleware(BaseHTTPMiddleware, dispatch=headers)
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(
        app,
        host=os.environ.get("ARC_BIND", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8788")),
        access_log=False,
    )
