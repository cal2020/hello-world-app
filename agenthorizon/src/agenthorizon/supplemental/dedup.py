"""Deduplication and separation audit across AgentHorizon dataset versions and supplemental sources.

* Exact duplicates: identical normalized instruction (+ action sequence when available) hashes, and identical
  screenshot bytes (sha256) across sources.
* Possible duplicates: token-Jaccard similarity of normalized instructions above a threshold, found with token
  blocking. They are listed for human review and NEVER merged automatically.
* Intentional sharing: AgentHorizon examples that share a recording (matched/crossed pairs) are reported as
  intentional and are not duplicates.
* Aliases: the same native id across files/platforms (e.g. OSWorld Windows ports of Ubuntu tasks) is recorded as
  alias lineage, not merged.
* Leakage guard: any supplemental record overlapping an AgentHorizon evaluation example is flagged so it can be
  excluded from prompt development or training exports.
"""

from __future__ import annotations

from collections import defaultdict
from itertools import combinations

from agenthorizon.supplemental.records import normalize_text
from agenthorizon.util.hashing import sha256_text
from agenthorizon.util.io import utcnow_iso

SIMILARITY_THRESHOLD = 0.8
STOP = {"the", "a", "an", "to", "of", "and", "in", "on", "for", "with", "my", "is", "it", "that", "this", "please", "can", "you"}


def _tokens(text: str) -> set[str]:
    return {t for t in normalize_text(text).split() if t not in STOP and len(t) > 1}


def audit(items: list[dict], *, threshold: float = SIMILARITY_THRESHOLD, max_pairs: int = 2000) -> dict:
    """``items``: {"key", "source", "instruction", "screenshots": [sha256...], "recording": id|None, "native_id": id|None,
    "is_ah_eval": bool}. Returns exact duplicates, possible duplicates, intentional sharing, aliases, leakage flags."""
    by_instr: dict[str, list[dict]] = defaultdict(list)
    by_shot: dict[str, list[dict]] = defaultdict(list)
    by_rec: dict[tuple[str, str], list[dict]] = defaultdict(list)
    by_native: dict[str, list[dict]] = defaultdict(list)
    tokens: dict[str, set[str]] = {}
    for it in items:
        if it.get("instruction"):
            by_instr[sha256_text(normalize_text(it["instruction"]))].append(it)
            tokens[it["key"]] = _tokens(it["instruction"])
        for sh in set(it.get("screenshots") or []):
            by_shot[sh].append(it)
        if it.get("recording"):
            by_rec[(it["source"], it["recording"])].append(it)
        if it.get("native_id"):
            by_native[f"{it['source']}:{it['native_id']}"].append(it)

    exact_instr = [{"normalized_instruction_sha256": h, "members": sorted(x["key"] for x in g),
                    "sources": sorted({x["source"] for x in g}), "cross_source": len({x["source"] for x in g}) > 1}
                   for h, g in by_instr.items() if len(g) > 1]
    exact_shots = []
    for h, g in by_shot.items():
        keys = sorted({x["key"] for x in g})
        recs = {(x["source"], x.get("recording")) for x in g}
        if len(keys) > 1 and not (len(recs) == 1 and None not in {r[1] for r in recs}):
            exact_shots.append({"screenshot_sha256": h, "members": keys, "sources": sorted({x["source"] for x in g})})
    intentional = [{"recording": rec, "source": src, "members": sorted(x["key"] for x in g)}
                   for (src, rec), g in by_rec.items() if len(g) > 1]
    aliases = [{"native_id": k, "members": sorted(x["key"] for x in g)} for k, g in by_native.items() if len(g) > 1]

    index: dict[str, set[str]] = defaultdict(set)
    for k, toks in tokens.items():
        for t in toks:
            index[t].add(k)
    src = {it["key"]: it["source"] for it in items}
    candidates: set[tuple[str, str]] = set()
    for ks in index.values():
        if 1 < len(ks) <= 200:  # very common tokens carry no signal and explode the pair count
            for a, b in combinations(sorted(ks), 2):
                candidates.add((a, b))
    possible = []
    exact_pairs = {tuple(sorted(p)) for g in exact_instr for p in combinations(g["members"], 2)}
    for a, b in sorted(candidates):
        if (a, b) in exact_pairs:
            continue
        ta, tb = tokens[a], tokens[b]
        if not ta or not tb:
            continue
        j = len(ta & tb) / len(ta | tb)
        if j >= threshold:
            possible.append({"a": a, "b": b, "jaccard": round(j, 3), "cross_source": src[a] != src[b],
                             "decision": "review (never auto-merged)"})
    possible.sort(key=lambda x: -x["jaccard"])
    ah = {it["key"] for it in items if it.get("is_ah_eval")}
    leak = sorted({m for g in exact_instr if g["cross_source"] for m in g["members"] if m not in ah and set(g["members"]) & ah} |
                  {p[k] for p in possible if p["cross_source"] for k in ("a", "b")
                   if p[k] not in ah and ({p["a"], p["b"]} & ah)} |
                  {m for g in exact_shots for m in g["members"] if m not in ah and set(g["members"]) & ah})
    return {"generated_at": utcnow_iso(), "items": len(items), "by_source": _count(items),
            "exact_instruction_duplicates": exact_instr, "exact_screenshot_duplicates": exact_shots,
            "intentional_shared_recordings": intentional, "native_id_aliases": aliases,
            "possible_duplicates": possible[:max_pairs], "possible_duplicates_total": len(possible),
            "supplemental_overlapping_ah_evaluation": leak,
            "method": {"exact": "sha256 of normalized instruction; sha256 of screenshot bytes",
                       "possible": f"token Jaccard >= {threshold} (stopwords removed) with token blocking",
                       "merge_policy": "nothing is merged automatically; matched/crossed AgentHorizon pairs that share a "
                                       "recording are intentional"},
            "limitations": ["sources without instructions or screenshots here (e.g. annotation-only records) cannot be "
                            "compared and are counted under by_source only"]}


def _count(items: list[dict]) -> dict:
    out: dict[str, dict] = {}
    for it in items:
        d = out.setdefault(it["source"], {"items": 0, "with_instruction": 0, "with_screenshots": 0})
        d["items"] += 1
        d["with_instruction"] += bool(it.get("instruction"))
        d["with_screenshots"] += bool(it.get("screenshots"))
    return out


def items_from_dataset(dv) -> list[dict]:
    from agenthorizon.data.materialize import current_assets

    assets = current_assets(dv)
    out = []
    for e in dv.examples():
        shots = [assets[s["asset_key"]]["sha256"] for s in dv.steps(e["recording_id"])
                 if s.get("asset_key") and (assets.get(s["asset_key"]) or {}).get("sha256")]
        out.append({"key": f"{dv.id}:{e['example_id']}", "source": dv.id, "instruction": e["instruction"],
                    "screenshots": shots, "recording": e["recording_id"], "native_id": None,
                    "is_ah_eval": dv.info.get("benchmark") in ("agenthorizon", "fixture-synthetic")})
    return out


def items_from_supplemental(records: list[dict]) -> list[dict]:
    out = []
    for r in records:
        shots = [s["observation"].get("sha256") for s in (r.get("steps") or []) if s["observation"].get("sha256")]
        out.append({"key": r["record_id"], "source": r["source_id"], "instruction": r.get("instruction"),
                    "screenshots": shots, "recording": None,
                    # task definitions can share a native id across files/platforms (aliases); trajectories are unique
                    "native_id": r["native_ids"].get("id") if r["kind"] == "task_definition" else None,
                    "is_ah_eval": False})
    return out
