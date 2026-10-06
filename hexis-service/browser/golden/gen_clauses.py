"""Golden vectors for HX.clauses (compiler/clauses.py): the real SKILL.md, hand-written edge documents and
seeded random documents. Offsets are Python string offsets (code points)."""

from __future__ import annotations

import random

from _common import ROOT, write

from hexis_service.compiler.clauses import CRITICAL_MARK, index_clauses, is_critical

rng = random.Random(28282828)

SKILL = (ROOT / "examples" / "procurement_onboarding" / "SKILL.md").read_text(encoding="utf-8")

DOCS = {
    "empty": "",
    "only newlines": "\n\n\n",
    "only whitespace": "  \t \n 　 \n\x0b\x0c",
    "no headings": "First paragraph line one\nline two\n\nSecond paragraph.\n- an item\n",
    "no trailing newline": "# T\n\npara",
    "title only": "# Just a title",
    "title then text": "# Title\nBody text.\n",
    "two titles": "# A\n# B\nbody\n",
    "title after clause": "intro\n# Not a title\nbody\n",
    "level 2 first": "## Section\ntext\n",
    "all heading levels": "# H1\n## H2\ntext2\n### H3\ntext3\n#### H4\n- i4\n##### H5\n1. i5\n###### H6\npara6\n####### H7 is text\n",
    "hash without space": "#nospace\n##\n#\n# \n#\ttab heading\n",
    "heading trailing spaces": "## Spaced   \t \nx\n",
    "heading unicode spaces": "##　Ideographic space \nx\n",
    "heading with nel": "## Head\x85x\n",
    "crlf": "# T\r\n\r\n## S\r\n- one\r\n- two\r\n\r\npara\r\nmore\r\n",
    "lone cr": "# T\r## S\r- a\rp1\rp2\r\rp3",
    "mixed separators": "a b c\x85d\x1ce\x1df\x1eg\x0bh\x0ci\n",
    "vertical tab paragraph": "line\x0bcontinues\x0c\nnext\n",
    "emoji before clauses": "😀😀 intro text\n# 🎉 Title\n- 😀 item with emoji\n- plain\n",
    "astral heading": "## 𝔘𝔫𝔦𝔠𝔬𝔡𝔢\n𝔟𝔬𝔡𝔶 text 😀\n",
    "astral offsets": "𐍈𐍈𐍈\n\n- 𐍈 x\n  𐍈𐍈 para\n",
    "nested lists": "## L\n- top\n  - nested\n    - deeper\n* star\n  * star nested\n",
    "numbered": "1. one\n2) two\n10. ten\n3.no space\n4.\n5)  spaced\n",
    "unicode digits": "١. arabic indic\n１. fullwidth\n𝟏. math bold\n٣) paren\n",
    "indented items": "   - three spaces\n\t- tab\n　- ideographic\n",
    "empty items": "- \n-   \n*\t\n- x\n",
    "dash alone": "-\n*\n--\n-- double\n",
    "item then para": "- item\ncontinuation line\n\npara\n",
    "para then item": "para\n- item\n",
    "multi-line para": "a\nb\n  c  \nd\n\n",
    "indented para": "    indented paragraph\n    second\n",
    "trailing spaces para": "para with trailing   \nnext line\t\n",
    "must marks": "## Rules\n- **MUST** do it\n- should do\n**MUST** paragraph\n- MUST lower\n- **MUST**\n",
    "must in heading": "## **MUST** heading\ntext\n",
    "blank lines with spaces": "a\n   \nb\n\t\nc\n　\nd\n",
    "form feed blank": "a\n\x0c\nb\n",
    "nel blank": "a\n\x85b\n",
    "x1c paragraph char": "a\x1cb\n",
    "x1f inside": "a\x1fb\n\x1f\n",
    "bom start": "﻿# T\ntext\n",
    "bom line": "a\n﻿\nb\n",
    "headings reset ordinal": "## A\n- 1\n- 2\n## B\n- 3\npara\n## C\n",
    "deep sections": "".join(f"## S{i}\n- item {i}\n" for i in range(12)),
    "long text": ("word " * 400 + "\n") * 3,
    "combining marks": "## Café\n- é combining\n",
    "zero width": "a​b\n​\n- ​\n",
    "tabs everywhere": "\t#\tnot heading\n#\theading\n\t1.\titem\n",
    "star bold not item": "**bold** text\n*italic* text\n",
    "plus not item": "+ plus\n",
    "html comment": "<!-- c -->\n# T\n",
    "crlf mixed with lf": "a\r\nb\nc\r\n\r\nd\n",
    "cr lf split": "a\r\r\nb\n",
}

# random documents
FRAGS = ["# ", "## ", "### ", "#### ", "####### ", "#", "- ", "* ", "1. ", "2) ", "10. ", "١. ", "  ", "\t", "　",
         "text", "word word", "**MUST**", "MUST", "😀", "é", "𝔘", "-", "*", ".", ")", ":"]
SEPS = ["\n", "\n", "\n", "\r\n", "\r", " ", " ", "\x85", "\x0b", "\x0c", "\x1c", "\x1d", "\x1e"]


def rand_doc() -> str:
    lines = []
    for _ in range(rng.randint(0, 14)):
        line = "".join(rng.choice(FRAGS) for _ in range(rng.randint(0, 4)))
        lines.append(line + rng.choice(SEPS))
    doc = "".join(lines)
    if rng.random() < 0.3 and doc:
        doc = doc[:-1]  # drop the final separator
    return doc


for i in range(220):
    DOCS[f"random-{i}"] = rand_doc()

cases = []
for name, text in [("SKILL.md", SKILL)] + list(DOCS.items()):
    clauses = index_clauses(text)
    for c in clauses:
        assert text[c.start:c.end] == c.text
    cases.append({"name": name, "text": text, "clauses": [c.model_dump(mode="json") for c in clauses],
                  "critical": [is_critical(c) for c in clauses]})

helpers = {
    "splitlines": [{"text": t, "keepends": t.splitlines(True), "plain": t.splitlines()}
                   for t in ["", "a", "a\n", "a\r\nb\rc\n\nd", "x y z\x85w\x0bv\x0cu\x1ct\x1ds\x1er\x1fq",
                             "\r\n\r\n", "\n\r", "😀\n😀"]],
    "strip": [{"text": t, "strip": t.strip(), "lstrip": t.lstrip(), "rstrip": t.rstrip()}
              for t in ["", "  a  ", "\x1c\x1d\x1e\x1fa\x1f", "　\xa0a ", "﻿a﻿", "​a​",
                        "\x85\x0b\x0c a \t\n\r", "😀 😀"]],
    "critical_mark": CRITICAL_MARK,
}

write("clauses", {"cases": cases, "helpers": helpers})
print(f"clauses: {len(cases)} documents, {sum(len(c['clauses']) for c in cases)} clauses; "
      f"SKILL.md has {len(cases[0]['clauses'])} clauses")
