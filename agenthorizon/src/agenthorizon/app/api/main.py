"""FastAPI application factory."""

from __future__ import annotations

import secrets as _secrets
import time

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from pydantic import BaseModel
from sqlalchemy import Engine, text

from agenthorizon.app.api import admin, catalog, research, runs
from agenthorizon.app.api.auth import PERMISSIONS, SESSION_COOKIE, Principal, current_principal, login, logout
from agenthorizon.config import PROJECT_ROOT, Settings, get_settings

FRONTEND_DIST = PROJECT_ROOT / "frontend" / "dist"
CSP = ("default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
       "connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'")


class LoginIn(BaseModel):
    token: str


def create_app(settings: Settings | None = None, engine: Engine | None = None) -> FastAPI:
    from agenthorizon.app.db import engine as make_engine

    s = settings or get_settings()
    app = FastAPI(title="AgentHorizon workbench API", version="0.1.0",
                  description="Research core API: catalogue, judge runs, scoring, review. Labels are privileged.")
    app.state.settings = s
    app.state.engine = engine or make_engine("api", s)

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        rid = request.headers.get("x-request-id") or _secrets.token_hex(8)
        request.state.request_id = rid[:64]
        t0 = time.perf_counter()
        response: Response = await call_next(request)
        response.headers["X-Request-ID"] = request.state.request_id
        response.headers["Server-Timing"] = f"app;dur={(time.perf_counter() - t0) * 1000:.1f}"
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        if not request.url.path.startswith("/api/"):
            response.headers.setdefault("Content-Security-Policy", CSP)
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        d = exc.detail if isinstance(exc.detail, dict) else {"code": "error", "message": str(exc.detail)}
        body = {"error": {**{k: v for k, v in d.items() if k not in ("plan",)}, "request_id": getattr(request.state, "request_id", None)}}
        if isinstance(exc.detail, dict) and "plan" in exc.detail:
            body["plan"] = exc.detail["plan"]
        return JSONResponse(body, status_code=exc.status_code, headers=getattr(exc, "headers", None))

    @app.exception_handler(RequestValidationError)
    async def validation_error(request: Request, exc: RequestValidationError):
        return JSONResponse({"error": {"code": "validation", "message": "invalid request",
                                       "details": [{"loc": e["loc"], "msg": e["msg"]} for e in exc.errors()],
                                       "request_id": getattr(request.state, "request_id", None)}}, status_code=422)

    @app.get("/api/health")
    def health():
        return {"status": "ok"}

    @app.get("/api/ready")
    def ready(request: Request):
        from agenthorizon.app.db import migration_head

        checks = {}
        try:
            with app.state.engine.connect() as c:
                cur = c.execute(text("SELECT version_num FROM alembic_version")).scalar()
            checks["database"] = {"ok": True}
            checks["migrations"] = {"ok": cur == migration_head(), "current": cur, "head": migration_head()}
        except Exception as exc:  # noqa: BLE001 — readiness reports, never raises
            checks["database"] = {"ok": False, "detail": type(exc).__name__}
        for name, path in (("media_dir", s.media_dir), ("runs_dir", s.runs_dir)):
            path.mkdir(parents=True, exist_ok=True)
            checks[name] = {"ok": path.is_dir()}
        ok = all(v.get("ok") for v in checks.values())
        return JSONResponse({"ready": ok, "checks": checks}, status_code=200 if ok else 503)

    @app.post("/api/auth/login")
    def do_login(body: LoginIn, response: Response):
        sid, p = login(app.state.engine, body.token, s.session_ttl_hours)
        response.set_cookie(SESSION_COOKIE, sid, httponly=True, samesite="strict", secure=s.mode == "hosted",
                            max_age=s.session_ttl_hours * 3600, path="/")
        return {"user_id": p.user_id, "role": p.role, "permissions": sorted(PERMISSIONS[p.role])}

    @app.post("/api/auth/logout")
    def do_logout(request: Request, response: Response, p: Principal = Depends(current_principal)):
        sid = request.cookies.get(SESSION_COOKIE)
        if sid:
            logout(app.state.engine, sid)
        response.delete_cookie(SESSION_COOKIE, path="/")
        return {"ok": True}

    @app.get("/api/auth/me")
    def me(p: Principal = Depends(current_principal)):
        return {"user_id": p.user_id, "role": p.role, "permissions": sorted(PERMISSIONS[p.role]), "via": p.via,
                "mode": s.mode}

    for r in (catalog.router, runs.router, research.router, admin.router):
        app.include_router(r)

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(404, detail={"code": "not_found", "message": "no such API route"})
        target = (FRONTEND_DIST / path).resolve()
        if path and FRONTEND_DIST in target.parents and target.is_file():
            cache = "public, max-age=31536000, immutable" if "/assets/" in f"/{path}" else "no-cache"
            return FileResponse(target, headers={"Cache-Control": cache})
        index = FRONTEND_DIST / "index.html"
        if index.is_file():
            return FileResponse(index, headers={"Cache-Control": "no-cache"})
        return JSONResponse({"error": {"code": "frontend_not_built",
                                       "message": "run `npm run build` in frontend/ (or use the Vite dev server)"}},
                            status_code=503)

    return app
