"""Authentication and role-based permissions (enforced server-side on every route).

Browsers log in with a token and receive an HttpOnly, SameSite=Strict session cookie; scripts use
``Authorization: Bearer <token>``. Cookie-authenticated mutations must carry ``X-AH-Request: 1`` (a custom header a
cross-site form cannot send), which blocks CSRF without exposing tokens to page scripts.
"""

from __future__ import annotations

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from fastapi import Depends, HTTPException, Request
from sqlalchemy import Engine, insert, select, update

from agenthorizon.app.schema import api_tokens, audit_events, sessions, users

ROLES = ("viewer", "reviewer", "researcher", "operator")
PERMISSIONS: dict[str, set[str]] = {
    "viewer": {"catalog.read", "runs.read", "scores.read", "reference.read"},
    "reviewer": {"catalog.read", "runs.read", "scores.read", "reference.read", "review.write", "review.reveal_own"},
    "researcher": {"catalog.read", "runs.read", "scores.read", "reference.read", "review.write", "review.reveal_own",
                   "research.labels", "runs.write", "scores.write", "exports.write", "review.export"},
    "operator": {"catalog.read", "runs.read", "scores.read", "reference.read", "review.write", "review.reveal_own",
                 "research.labels", "runs.write", "scores.write", "exports.write", "review.export", "data.write",
                 "jobs.admin", "audit.read", "users.admin", "judges.refresh"},
}
SESSION_COOKIE = "ah_session"
CSRF_HEADER = "x-ah-request"


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def new_token() -> str:
    return "aht_" + secrets.token_urlsafe(32)


@dataclass
class Principal:
    user_id: str
    role: str
    via: str  # session | token

    def can(self, perm: str) -> bool:
        return perm in PERMISSIONS.get(self.role, set())


def create_user(engine: Engine, user_id: str, role: str, display_name: str | None = None, label: str = "initial") -> str:
    if role not in ROLES:
        raise ValueError(f"role must be one of {ROLES}")
    tok = new_token()
    with engine.begin() as c:
        exists = c.execute(select(users.c.user_id).where(users.c.user_id == user_id)).first()
        if not exists:
            c.execute(insert(users).values(user_id=user_id, role=role, display_name=display_name or user_id))
        c.execute(insert(api_tokens).values(token_hash=token_hash(tok), user_id=user_id, label=label))
    return tok


def _now() -> datetime:
    return datetime.now(UTC)


def login(engine: Engine, token: str, ttl_hours: int) -> tuple[str, Principal]:
    with engine.begin() as c:
        r = c.execute(select(users.c.user_id, users.c.role).select_from(api_tokens.join(users))
                      .where((api_tokens.c.token_hash == token_hash(token)) & api_tokens.c.revoked_at.is_(None)
                             & ((api_tokens.c.expires_at.is_(None)) | (api_tokens.c.expires_at > _now()))
                             & users.c.disabled.is_(False))).first()
        if r is None:
            raise HTTPException(401, detail={"code": "invalid_token", "message": "unknown, expired, or revoked token"})
        sid = secrets.token_urlsafe(32)
        c.execute(insert(sessions).values(session_hash=token_hash(sid), user_id=r[0], expires_at=_now() + timedelta(hours=ttl_hours)))
    return sid, Principal(r[0], r[1], "session")


def logout(engine: Engine, sid: str) -> None:
    with engine.begin() as c:
        c.execute(update(sessions).where(sessions.c.session_hash == token_hash(sid)).values(revoked_at=_now()))


def resolve_principal(engine: Engine, request: Request) -> Principal | None:
    authz = request.headers.get("authorization", "")
    if authz.lower().startswith("bearer "):
        tok = authz[7:].strip()
        with engine.connect() as c:
            r = c.execute(select(users.c.user_id, users.c.role).select_from(api_tokens.join(users))
                          .where((api_tokens.c.token_hash == token_hash(tok)) & api_tokens.c.revoked_at.is_(None)
                                 & ((api_tokens.c.expires_at.is_(None)) | (api_tokens.c.expires_at > _now()))
                                 & users.c.disabled.is_(False))).first()
        return Principal(r[0], r[1], "token") if r else None
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        return None
    with engine.connect() as c:
        r = c.execute(select(users.c.user_id, users.c.role).select_from(sessions.join(users))
                      .where((sessions.c.session_hash == token_hash(sid)) & sessions.c.revoked_at.is_(None)
                             & (sessions.c.expires_at > _now()) & users.c.disabled.is_(False))).first()
    return Principal(r[0], r[1], "session") if r else None


def current_principal(request: Request) -> Principal:
    p = resolve_principal(request.app.state.engine, request)
    if p is None:
        raise HTTPException(401, detail={"code": "unauthenticated", "message": "log in first"})
    if p.via == "session" and request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CSRF_HEADER) != "1":
        raise HTTPException(403, detail={"code": "csrf", "message": "missing X-AH-Request header"})
    request.state.principal = p
    return p


def require(perm: str):
    def dep(p: Principal = Depends(current_principal)) -> Principal:
        if not p.can(perm):
            raise HTTPException(403, detail={"code": "forbidden", "message": f"role {p.role} lacks {perm}"})
        return p
    return dep


def audit(engine: Engine, principal: Principal | None, action: str, target: str | None, detail: dict | None = None,
          request_id: str | None = None) -> None:
    with engine.begin() as c:
        c.execute(insert(audit_events).values(actor=principal.user_id if principal else None,
                                              role=principal.role if principal else None, action=action, target=target,
                                              request_id=request_id, detail=detail or {}))
