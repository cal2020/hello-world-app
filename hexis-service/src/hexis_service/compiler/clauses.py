"""Source clause indexing with exact byte-span provenance (brief §8 step 2).

Clause IDs are stable functions of document structure: ``S<section>.<ordinal>``, where section 0
is text before the first heading. Each list item and each paragraph is one clause. The recorded
``text`` is exactly ``source[start:end]``; hashes let admission detect any drift.
"""

from __future__ import annotations

import re

from ..artifacts.package import ClauseRef
from ..canonical import sha256_hex

_HEADING = re.compile(r"^(#{1,6})\s+(.*)$")
_ITEM = re.compile(r"^\s*(?:[-*]|\d+[.)])\s+")
CRITICAL_MARK = "**MUST**"


def index_clauses(text: str) -> list[ClauseRef]:
    clauses: list[ClauseRef] = []
    section, ordinal, heading = 0, 0, ""
    pos = 0
    para_start = None
    para_end = None

    def flush_para() -> None:
        nonlocal para_start, para_end, ordinal
        if para_start is not None and para_end is not None and text[para_start:para_end].strip():
            ordinal += 1
            body = text[para_start:para_end]
            clauses.append(ClauseRef(id=f"S{section}.{ordinal}", start=para_start, end=para_end, heading=heading,
                                     text=body, sha256=sha256_hex(body)))
        para_start = para_end = None

    for line in text.splitlines(keepends=True):
        start, content = pos, line.rstrip("\r\n")
        pos += len(line)
        h = _HEADING.match(content)
        if h:
            flush_para()
            if len(h.group(1)) == 1 and section == 0 and not clauses:
                heading = h.group(2).strip()  # document title stays section 0
                continue
            section += 1
            ordinal = 0
            heading = h.group(2).strip()
            continue
        if not content.strip():
            flush_para()
            continue
        m = _ITEM.match(content)
        if m:
            flush_para()
            ordinal += 1
            s = start + m.end()
            e = start + len(content)
            body = text[s:e]
            clauses.append(ClauseRef(id=f"S{section}.{ordinal}", start=s, end=e, heading=heading, text=body,
                                     sha256=sha256_hex(body)))
            continue
        if para_start is None:
            para_start = start + (len(content) - len(content.lstrip()))
        para_end = start + len(content)
    flush_para()
    return clauses


def is_critical(clause: ClauseRef) -> bool:
    return CRITICAL_MARK in clause.text
