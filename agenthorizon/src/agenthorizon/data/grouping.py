"""Pair grouping for leakage audits, split construction, and grouped resampling (scorer-only data).

Two label-derived definitions from the authors' code are reproduced, not reinvented:

* ``component_id`` — union-find over deliverable ids, with an edge ``original_id — paired_id`` for every
  negative and positives attached through ``original_id`` (``scripts/split_agenthorizon.py:group_items``).
* ``pair_group_id`` — ``sha1("::".join(sorted({original_id, paired_id})))[:12]``
  (``scripts/aggregate_difficulty.py:pair_group_id_for_item``).

A content-derived grouping (union-find over shared recordings and identical instruction texts) is also
computed so audits still work if label files lack the identifier fields; its limitation (it cannot link two
swapped negatives whose positives were excluded) is reported alongside it.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict
from collections.abc import Iterable


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[str, str] = {}

    def find(self, x: str) -> str:
        self.parent.setdefault(x, x)
        root = x
        while self.parent[root] != root:
            root = self.parent[root]
        while self.parent[x] != root:
            self.parent[x], x = root, self.parent[x]
        return root

    def union(self, a: str, b: str) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.parent[max(ra, rb)] = min(ra, rb)


def pair_group_id(original_id: str | None, paired_id: str | None) -> str:
    parts = [p for p in (original_id, paired_id) if p]
    if not parts:
        return ""
    canonical = "::".join(sorted(set(parts)))
    return hashlib.sha1(canonical.encode(), usedforsecurity=False).hexdigest()[:12]


def instruction_source_id(label: str, original_id: str | None, paired_id: str | None) -> str | None:
    return original_id if label == "positive" else paired_id


def label_components(rows: Iterable[dict]) -> dict[str, dict]:
    """rows: dicts with example_id, label, original_id, paired_id. Returns per-example grouping info."""
    rows = list(rows)
    uf = UnionFind()
    for r in rows:
        if r.get("original_id"):
            uf.find(r["original_id"])
        if r.get("paired_id"):
            uf.find(r["paired_id"])
        if r["label"] == "negative" and r.get("original_id") and r.get("paired_id"):
            uf.union(r["original_id"], r["paired_id"])
    members: dict[str, list[str]] = defaultdict(list)
    for r in rows:
        seed = r.get("original_id") or r.get("paired_id")
        if seed:
            members[uf.find(seed)].append(r["example_id"])
    out: dict[str, dict] = {}
    for r in rows:
        seed = r.get("original_id") or r.get("paired_id")
        root = uf.find(seed) if seed else None
        out[r["example_id"]] = {
            "component_id": f"cmp-{hashlib.sha256(root.encode()).hexdigest()[:12]}" if root else None,
            "component_size": len(members[root]) if root else None,
            "pair_group_id": pair_group_id(r.get("original_id"), r.get("paired_id")) or None,
            "instruction_source_id": instruction_source_id(r["label"], r.get("original_id"), r.get("paired_id")),
            "recording_owner_id": r.get("original_id"),
        }
    return out


def content_components(examples: Iterable[dict]) -> dict[str, str]:
    """Union examples that share a recording or an identical instruction text."""
    uf = UnionFind()
    exs = list(examples)
    for e in exs:
        uf.union(f"ex:{e['example_id']}", f"rec:{e['recording_id']}")
        uf.union(f"ex:{e['example_id']}", f"ins:{e['instruction_id']}")
    return {e["example_id"]: "ccmp-" + hashlib.sha256(uf.find(f"ex:{e['example_id']}").encode()).hexdigest()[:12]
            for e in exs}


def size_distribution(groups: dict[str, str | None]) -> dict[int, int]:
    counts: dict[str, int] = defaultdict(int)
    for g in groups.values():
        if g:
            counts[g] += 1
    dist: dict[int, int] = defaultdict(int)
    for c in counts.values():
        dist[c] += 1
    return dict(sorted(dist.items()))


def overlap_audit(a_ids: set[str], b_ids: set[str], keyed: dict[str, dict]) -> dict:
    """Overlap between two example sets by component, recording, and instruction (all scorer-only)."""
    def keys(ids: set[str], field: str) -> set[str]:
        return {keyed[i][field] for i in ids if i in keyed and keyed[i].get(field)}

    out = {"examples": len(a_ids & b_ids)}
    for field in ("component_id", "recording_id", "instruction_id", "pair_group_id"):
        ka, kb = keys(a_ids, field), keys(b_ids, field)
        out[field] = {"shared": len(ka & kb), "a_total": len(ka), "b_total": len(kb)}
    return out
