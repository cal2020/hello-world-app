"""Bundle the browser engine + lab UI into one self-contained HTML page.

Outputs (in dist/):
  hexis-lab.html        Artifact fragment: starts with <title>, no doctype/html/head/body (the Artifact host
                        wraps it), all CSS/JS/data inline, no network access.
  hexis-lab.local.html  The same page wrapped in a full document with a strict Content-Security-Policy for
                        local testing (Playwright), mirroring the Artifact viewer's restrictions.

Template placeholders in app/index.template.html:
  {{HX:CSS}}     app/NN_*.css concatenated        {{HX:ENGINE}}  src/NN_*.js concatenated
  {{HX:APP}}     app/NN_*.js concatenated         {{HX:EMBED}}   JSON object built from app/embed.json
                                                                  ({"key": "path relative to browser/"})
Run: python build.py [--check]   (--check also fails on size > 15 MB)
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC, APP, DIST = HERE / "src", HERE / "app", HERE / "dist"
NUMBERED = re.compile(r"^\d\d_.*")

CSP = ("default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src https://fonts.gstatic.com; img-src data: blob:; connect-src 'none'; worker-src blob:; "
       "frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
SKELETON_HEAD = (
    "<!doctype html>\n<html lang=\"en\"><head><meta charset=\"utf-8\">"
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1, viewport-fit=cover\">"
    f"<meta http-equiv=\"Content-Security-Policy\" content=\"{CSP}\">"
    "<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);"
    "padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px/1.4 system-ui,-apple-system,sans-serif;"
    "background:#fafafa}img{max-width:100%}[hidden]{display:none!important}</style>"
    "</head><body>\n")
SKELETON_TAIL = "\n</body></html>\n"
ALLOWED_STYLE_HOSTS = ("https://fonts.googleapis.com/",)


def numbered(directory: Path, suffix: str) -> list[Path]:
    if not directory.exists():
        return []
    return sorted(p for p in directory.iterdir() if p.suffix == suffix and NUMBERED.match(p.name))


def script_safe(code: str) -> tuple[str, int]:
    """Make JS safe to inline in <script>: neutralize '</script' and '<!--' sequences."""
    n = len(re.findall(r"</script", code, flags=re.I)) + code.count("<!--")
    code = re.sub(r"</(script)", r"<\\/\1", code, flags=re.I).replace("<!--", "<\\!--")
    return code, n


def concat(files: list[Path], comment: str) -> str:
    parts = []
    for f in files:
        parts.append(f"{comment.format(name=f.name)}\n{f.read_text(encoding='utf-8')}")
    return "\n".join(parts)


def build(check: bool = False) -> dict:
    template_path = APP / "index.template.html"
    if not template_path.exists():
        raise SystemExit(f"missing {template_path}")
    template = template_path.read_text(encoding="utf-8")
    engine, n1 = script_safe(concat(numbered(SRC, ".js"), "/* ==== src/{name} ==== */"))
    app_js, n2 = script_safe(concat(numbered(APP, ".js"), "/* ==== app/{name} ==== */"))
    css = concat(numbered(APP, ".css"), "/* ==== app/{name} ==== */")
    if "</style" in css.lower():
        raise SystemExit("CSS contains '</style'")
    embed = {}
    embed_spec = APP / "embed.json"
    if embed_spec.exists():
        for key, rel in json.loads(embed_spec.read_text(encoding="utf-8")).items():
            embed[key] = json.loads((HERE / rel).read_text(encoding="utf-8"))
    embed_json = json.dumps(embed, sort_keys=True, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = (template.replace("{{HX:CSS}}", css).replace("{{HX:ENGINE}}", engine)
            .replace("{{HX:APP}}", app_js).replace("{{HX:EMBED}}", embed_json))
    leftover = re.findall(r"\{\{HX:[A-Z]+\}\}", page)
    if leftover:
        raise SystemExit(f"unreplaced placeholders: {leftover}")
    head = page.lstrip()[:400].lower()
    if not head.startswith("<title>"):
        raise SystemExit("fragment must start with <title>")
    for tag in ("<!doctype", "<html", "<head", "<body"):
        if tag in page.lower()[:2000]:
            raise SystemExit(f"fragment must not contain {tag}")
    problems = []
    for m in re.finditer(r"<script[^>]*\bsrc\s*=", page, flags=re.I):
        problems.append(f"external <script src> at {m.start()}")
    for m in re.finditer(r"<link[^>]*href\s*=\s*\"([^\"]+)\"", page, flags=re.I):
        if not m.group(1).startswith(ALLOWED_STYLE_HOSTS) and not m.group(1).startswith("https://fonts.gstatic.com"):
            problems.append(f"external <link href> {m.group(1)}")
    for m in re.finditer(r"url\(\s*['\"]?https?://", css, flags=re.I):
        problems.append(f"external CSS url() at {m.start()}")
    if problems:
        raise SystemExit("build refuses external resources:\n  " + "\n  ".join(problems))
    DIST.mkdir(exist_ok=True)
    (DIST / "hexis-lab.html").write_text(page, encoding="utf-8")
    (DIST / "hexis-lab.local.html").write_text(SKELETON_HEAD + page + SKELETON_TAIL, encoding="utf-8")
    size = len(page.encode("utf-8"))
    if check and size > 15 * 1024 * 1024:
        raise SystemExit(f"page too large: {size} bytes")
    info = {"bytes": size, "engine_files": len(numbered(SRC, ".js")), "app_files": len(numbered(APP, ".js")),
            "css_files": len(numbered(APP, ".css")), "embedded": sorted(embed), "escaped_sequences": n1 + n2}
    return info


if __name__ == "__main__":
    print(json.dumps(build(check="--check" in sys.argv)))
