"""Bundle the browser engine + lab UI into one self-contained HTML page.

Outputs (in dist/):
  hexis-lab.html        Artifact fragment: starts with <title>, no doctype/html/head/body (the Artifact host
                        wraps it), all CSS/JS/data inline, no network access.
  hexis-lab.local.html  The same page wrapped in a full document with a strict Content-Security-Policy for
                        local testing (Playwright), mirroring the Artifact viewer's restrictions.

Template placeholders in app/index.template.html:
  {{HX:CSS}}      app/NN_*.css concatenated (goes inside one <style>)
  {{HX:ENGINE}}   one <script> element per src/NN_*.js module
  {{HX:APP}}      one <script> element per app/NN_*.js file
  {{HX:EMBED}}    JSON object built from app/embed.json ({"key": "path relative to browser/"}), placed inside
                  <script type="application/json" id="hx-embed">
Each module gets its own <script> element, so a module that fails to parse or throws at load time only loses its
own namespace (the boot code reports which ones are missing) instead of taking the whole engine down.

Run: python build.py [--check] [--engine-prefixes 00,05,10,15] [--app-prefixes 00,35] [--out DIR]
  --check            also fail if the page is larger than the 3 MB budget of specs/UI.md (the platform's hard
                     cap is 15 MB)
  --engine-prefixes  include only the src modules with these two-digit prefixes (UI development against a
                     partially ported engine); the default includes every module
  --app-prefixes     the same filter for app/ files (.css and .js), for developing one UI file in isolation
  --out DIR          write into DIR (relative to browser/) instead of dist/, so parallel builds don't collide;
                     run the E2E tests against it with HX_PAGE=DIR/hexis-lab.local.html
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC, APP, DIST = HERE / "src", HERE / "app", HERE / "dist"
NUMBERED = re.compile(r"^\d\d_.*")
BUDGET_BYTES = 3 * 1024 * 1024  # specs/UI.md section 6: the page (with the golden sample) stays under 3 MB

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


def script_elements(files: list[Path], folder: str) -> tuple[str, int]:
    """One <script> element per file, each made safe to inline."""
    out, escaped = [], 0
    for f in files:
        code, n = script_safe(f.read_text(encoding="utf-8"))
        escaped += n
        out.append(f'<script data-hx-module="{folder}/{f.name}">/* ==== {folder}/{f.name} ==== */\n{code}\n</script>')
    return "\n".join(out), escaped


def build(check: bool = False, engine_prefixes: list[str] | None = None, out: Path = DIST,
          app_prefixes: list[str] | None = None) -> dict:
    template_path = APP / "index.template.html"
    if not template_path.exists():
        raise SystemExit(f"missing {template_path}")
    template = template_path.read_text(encoding="utf-8")
    engine_files = numbered(SRC, ".js")
    if engine_prefixes is not None:
        engine_files = [f for f in engine_files if f.name[:2] in engine_prefixes]
    app_files, css_files = numbered(APP, ".js"), numbered(APP, ".css")
    if app_prefixes is not None:
        app_files = [f for f in app_files if f.name[:2] in app_prefixes]
        css_files = [f for f in css_files if f.name[:2] in app_prefixes]
    engine, n1 = script_elements(engine_files, "src")
    app_js, n2 = script_elements(app_files, "app")
    css = concat(css_files, "/* ==== app/{name} ==== */")
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
    out.mkdir(parents=True, exist_ok=True)
    for name, text in (("hexis-lab.html", page), ("hexis-lab.local.html", SKELETON_HEAD + page + SKELETON_TAIL)):
        tmp = out / (name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(out / name)  # atomic: a test never loads a half-written page
    size = len(page.encode("utf-8"))
    if check and size > 15 * 1024 * 1024:
        raise SystemExit(f"page too large: {size} bytes (the platform cap is 15 MB)")
    if check and size > BUDGET_BYTES:
        raise SystemExit(f"page over budget: {size} bytes; specs/UI.md budgets the page under 3 MB ({BUDGET_BYTES} bytes)")
    info = {"bytes": size, "engine_files": [f.name for f in engine_files], "app_files": [f.name for f in app_files],
            "css_files": [f.name for f in css_files], "embedded": sorted(embed), "escaped_sequences": n1 + n2}
    return info


def prefix_arg(argv: list[str], flag: str) -> list[str] | None:
    if flag not in argv:
        return None
    i = argv.index(flag)
    if i + 1 >= len(argv):
        raise SystemExit(f"{flag} needs a comma-separated list of two-digit prefixes, e.g. 00,05,10,15")
    return [x.strip() for x in argv[i + 1].split(",") if x.strip()]


def main(argv: list[str]) -> None:
    prefixes = prefix_arg(argv, "--engine-prefixes")
    app_prefixes = prefix_arg(argv, "--app-prefixes")
    out = DIST
    if "--out" in argv:
        i = argv.index("--out")
        if i + 1 >= len(argv):
            raise SystemExit("--out needs a directory")
        out = (HERE / argv[i + 1]).resolve()
    print(json.dumps(build(check="--check" in argv, engine_prefixes=prefixes, out=out, app_prefixes=app_prefixes)))


if __name__ == "__main__":
    main(sys.argv[1:])
