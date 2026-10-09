"""Shared API helpers: typed errors, cursors, idempotency."""

from __future__ import annotations

import base64
import json

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from sqlalchemy import Engine, insert, select

from agenthorizon.app.schema import idempotency_keys
from agenthorizon.util.hashing import digest_json


def err(status: int, code: str, message: str, **extra) -> HTTPException:
    return HTTPException(status, detail={"code": code, "message": message, **extra})


def enc_cursor(obj) -> str:
    return base64.urlsafe_b64encode(json.dumps(obj).encode()).decode().rstrip("=")


def dec_cursor(s: str | None):
    if not s:
        return None
    try:
        return json.loads(base64.urlsafe_b64decode(s + "=" * (-len(s) % 4)))
    except (ValueError, json.JSONDecodeError) as exc:
        raise err(400, "bad_cursor", "malformed cursor") from exc


def eng(request: Request) -> Engine:
    return request.app.state.engine


def idempotent(request: Request, user_id: str, body: dict, produce) -> JSONResponse:
    """Replay the stored response for a repeated Idempotency-Key; reject reuse with a different body."""
    key = request.headers.get("idempotency-key")
    if not key:
        status, payload = produce()
        return JSONResponse(payload, status_code=status)
    if len(key) > 128:
        raise err(400, "bad_idempotency_key", "Idempotency-Key longer than 128 characters")
    route = f"{request.method} {request.url.path}"
    digest = digest_json(body)
    e = eng(request)
    with e.connect() as c:
        row = c.execute(select(idempotency_keys).where((idempotency_keys.c.key == key)
                                                       & (idempotency_keys.c.user_id == user_id))).mappings().first()
    if row:
        if row["request_digest"] != digest or row["route"] != route:
            raise err(422, "idempotency_conflict", "Idempotency-Key reused with a different request")
        return JSONResponse(row["response"], status_code=row["status_code"], headers={"Idempotent-Replay": "true"})
    status, payload = produce()
    if status < 500:
        with e.begin() as c:
            c.execute(insert(idempotency_keys).values(key=key, user_id=user_id, route=route, request_digest=digest,
                                                      response=json.loads(json.dumps(payload, default=str)),
                                                      status_code=status))
    return JSONResponse(payload, status_code=status)
