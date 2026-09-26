"""Evidence receipts tied to subjects and versions (brief §12.3), not durable booleans.

A receipt records: verifier identity/version, claim, the digest of each subject variable at
verification time, the observed result, the source action receipt and the observation time.
Any later change to a subject variable, or a failed freshness re-check against the external
system, invalidates it.
"""

from __future__ import annotations

from typing import Any, Optional

from ..canonical import digest

POSITIVE_RESULTS = ("pass", "match")


def subject_of(values: dict, names: list[str]) -> dict[str, str]:
    return {n: digest(values[n]) if n in values else "unset" for n in names}


def make_receipt(run_id: str, claim: str, verifier: str, verifier_version: str, subject: dict, result: str,
                 source_ref: str, observed_at: float, receipt_id: Optional[str] = None) -> dict:
    body = {"run_id": run_id, "claim": claim, "verifier": verifier, "verifier_version": verifier_version,
            "subject": subject, "subject_digest": digest(subject), "result": result, "source_ref": source_ref,
            "observed_at": observed_at}
    body["receipt_id"] = receipt_id or ("ev_" + digest({k: v for k, v in body.items() if k != "observed_at"})[7:31])
    return body


def is_current(rec: dict, values: dict) -> bool:
    if rec.get("invalidated_at") is not None:
        return False
    return all(subject_of(values, [k])[k] == v for k, v in rec["subject"].items())


def valid_positive(receipts: list[dict], values: dict, claim: Optional[str] = None) -> list[dict]:
    return [r for r in receipts if r["result"] in POSITIVE_RESULTS and is_current(r, values)
            and (claim is None or r["claim"] == claim)]


def evidence_scope(receipts: list[dict], values: dict) -> list[dict[str, Any]]:
    """Evidence versions an approval binds: every currently valid positive receipt."""
    return sorted(({"receipt_id": r["receipt_id"], "claim": r["claim"], "subject_digest": r["subject_digest"]}
                   for r in valid_positive(receipts, values)), key=lambda x: x["receipt_id"])
