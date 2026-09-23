"""Caller/project-scoped operation receipts (idempotent retries).

Contract:
* A mutation may carry `Idempotency-Key`. The receipt is written in the SAME transaction
  as the effect, so a crash either leaves both or neither.
* Replaying a key with the same canonical request fingerprint returns the stored result
  (after re-checking that the caller can still read the project); the effect is not repeated.
* Replaying a key with a different fingerprint is an error (422 idempotency_key_mismatch).
* Only committed outcomes are stored. A request refused before commit (401/403/404/409/412
  raised as ApiError) stores nothing; retrying re-evaluates against current state.
* Retention: receipts carry expires_at = created + 7 days. Nothing purges them automatically
  during a run; `scripts/purge_receipts.py` is the only deletion path and is documented.
"""
import datetime
import json

from .authz import has
from .util import ApiError, digest, now

RETENTION_DAYS = 7


def fingerprint(operation, path, body, if_match=None):
    return digest({"op": operation, "path": path, "body": body, "if_match": if_match})


def execute(db, caller, project, operation_id, operation, fp, fn):
    """fn(c) -> (status, body, affected). Returns (status, body, replayed: bool)."""
    with db.tx() as c:
        if operation_id:
            row = c.execute("SELECT * FROM operation_receipt WHERE caller=? AND project=? AND operation_id=?",
                            (caller, project, operation_id)).fetchone()
            if row:
                if row["fingerprint"] != fp:
                    raise ApiError(422, "idempotency_key_mismatch",
                                   "This Idempotency-Key was already used for a different request.",
                                   {"operation": row["operation"]})
                if not has(c, caller, project, "read"):
                    raise ApiError(404, "not_found", "Resource not found.")
                return row["status_code"], json.loads(row["response_json"]), True
        status, body, affected = fn(c)
        if operation_id:
            exp = (datetime.datetime.utcnow() + datetime.timedelta(days=RETENTION_DAYS)).strftime("%Y-%m-%dT%H:%M:%SZ")
            c.execute("INSERT INTO operation_receipt VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                      (caller, project, operation_id, operation, fp, "committed" if status < 400 else "committed_rejection",
                       status, json.dumps(body), json.dumps(affected or {}), now(), exp))
        return status, body, False
