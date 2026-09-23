"""Local web UI (stdlib only). Binds to 127.0.0.1 by default.

Identity is chosen from a SIMULATED identity menu (no authentication). All
permission, freshness and review checks happen in the service layer; the UI only
calls services and renders results, so the same rules hold for CLI and tests.
"""
from __future__ import annotations

import html
import json
import secrets
import traceback
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from . import config, db, demo, drafting, export, importer, impact, opa, packages, review
from . import model as M
from .identity import Denied, revoke_user
from .util import digest_obj, short

CSRF = secrets.token_hex(16)
E = html.escape

CSS = """
:root{--bg:#fbfbf9;--fg:#1d1d1b;--mut:#5c5c57;--line:#d9d8d2;--card:#fff;--pass:#1e6b3a;--fail:#a4262c;--unk:#8a5a00;
--err:#6b2fa0;--acc:#1f4f8f;--stale:#8a5a00}
@media (prefers-color-scheme: dark){:root{--bg:#161615;--fg:#ecebe6;--mut:#a9a8a1;--line:#3a3935;--card:#1f1f1d;
--pass:#6fcf8e;--fail:#ff8a8f;--unk:#f2c46b;--err:#c9a2ff;--acc:#8fb8ff;--stale:#f2c46b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header b{font-size:18px}nav a{margin-right:14px;color:var(--acc);text-decoration:none}
main{padding:16px 20px;max-width:1300px}
.banner{background:var(--card);border:1px dashed var(--mut);padding:6px 10px;font-size:14px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:14px;color:var(--mut);font-weight:600}
.PASS,.CURRENT,.REVIEWED_FOR_DEMO,.ok{color:var(--pass);font-weight:700}.FAIL,.REJECTED,.bad{color:var(--fail);font-weight:700}
.UNKNOWN,.NONE,.INAPPLICABLE_ONLY,.CONFLICT,.NEEDS_REVIEW,.STALE{color:var(--unk);font-weight:700}.ERROR{color:var(--err);font-weight:700}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px}
button,select,input,textarea{font:inherit;padding:5px 10px}button{cursor:pointer}
.msg{padding:10px 14px;border-radius:6px;margin:10px 0;border:1px solid var(--line)}
.msg.err{border-color:var(--fail)}.kind{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-right:6px}
.flag{color:var(--fail);font-weight:700}.small{font-size:14px;color:var(--mut)}
form.inline{display:inline}
"""


def page(title, body, actor, msg=None, err=False):
    ids = "".join(f'<option value="{u}" {"selected" if u == actor else ""}>{u}</option>'
                  for u in ("bob", "alice", "carol", "sam", "mallory"))
    m = f'<div class="msg {"err" if err else ""}">{E(msg)}</div>' if msg else ""
    return f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>DMMC Evidence Workbench</title><style>{CSS}</style></head><body>
<header><b>DMMC evidence workbench</b><nav><a href="/">Dashboard</a><a href="/model">Model</a><a href="/evidence">Evidence</a>
<a href="/impact">Impact</a><a href="/audit">Audit</a></nav>
<form method="post" action="/whoami" class="inline">SIMULATED identity (no authentication):
<select name="actor" onchange="this.form.submit()">{ids}</select><input type="hidden" name="csrf" value="{CSRF}"></form></header>
<main><div class="banner">Synthetic data only. Fixture evidence is not an observation of a real system. Outputs are partial drafts for expert review,
not an SSP, assessment or authorization decision.</div>{m}<h2>{E(title)}</h2>{body}</main></body></html>"""


def btn(action, label, **fields):
    hidden = "".join(f'<input type="hidden" name="{k}" value="{E(str(v))}">' for k, v in fields.items())
    return (f'<form method="post" action="/act" class="inline"><input type="hidden" name="action" value="{action}">'
            f'<input type="hidden" name="csrf" value="{CSRF}">{hidden}<button>{E(label)}</button></form>')


def cite_link(c):
    return f'<a class="mono" href="/cite?c={quote(c)}">{E(c.split(":")[0])}:{E(short(c.split(":", 1)[1], 18))}</a>'


class H(BaseHTTPRequestHandler):
    conn = None

    def log_message(self, *a):
        pass

    @property
    def actor(self):
        c = SimpleCookie(self.headers.get("Cookie", ""))
        return c["actor"].value if "actor" in c else "bob"

    def send(self, body, code=200, ctype="text/html; charset=utf-8", headers=None):
        b = body.encode() if isinstance(body, str) else body
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(b)))
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'")
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(b)

    def redirect(self, to, msg=None, err=False):
        if msg:
            to += ("&" if "?" in to else "?") + f"msg={quote(msg)}" + ("&err=1" if err else "")
        self.send_response(303)
        self.send_header("Location", to)
        self.end_headers()

    # --- GET ---
    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        msg, err = q.get("msg"), bool(q.get("err"))
        try:
            if u.path == "/":
                body, title = self.dashboard(), "Dashboard"
            elif u.path.startswith("/package/"):
                pid = u.path.split("/")[2]
                body, title = self.package(pid), f"Package {pid}"
            elif u.path == "/model":
                body, title = self.model(q.get("snap")), "Model explorer"
            elif u.path == "/cite":
                body, title = self.cite(q["c"]), "Citation"
            elif u.path == "/evidence":
                body, title = self.evidence(), "Evidence"
            elif u.path.startswith("/evidence/"):
                return self.evidence_raw(u.path.split("/")[2])
            elif u.path == "/impact":
                body, title = self.impact(q), "Change impact"
            elif u.path == "/audit":
                body, title = self.audit(), "Audit events"
            elif u.path.startswith("/files/"):
                return self.file(u.path[len("/files/"):])
            else:
                return self.send("not found", 404, "text/plain")
            self.send(page(title, body, self.actor, msg, err))
        except Exception as e:
            self.send(page("Error", f"<pre>{E(traceback.format_exc())}</pre>", self.actor, str(e), True), 500)

    def dashboard(self):
        c = self.conn
        snap = M.current_snapshot(c, demo.PROJECT)
        dep = packages.dependency_manifest(c, demo.PROJECT) if snap else None
        rows = []
        for p in packages.list_packages(c, demo.PROJECT):
            st = packages.status(c, p["id"])
            cov = json.loads(p["rows_json"])
            n = sum(1 for r in cov if r["evidence_state"] == "CURRENT")
            rows.append(f"<tr><td><a href='/package/{p['id']}'>{p['id']}</a></td><td>{E(p['snapshot_id'])}</td>"
                        f"<td>{E(p['drafter_mode'])}</td><td>{n} of {len(cov)}</td>"
                        f"<td class='{st['freshness']}'>{st['freshness']}</td><td class='{st['review_state']}'>{st['review_state']}</td>"
                        f"<td class='{st['effective_state']}'>{st['effective_state']}</td></tr>")
        steps = (f"<div class='card'><b>Demo controls</b><p>"
                 f"{btn('reset', 'Reset demo state')} {btn('import_model', 'Import model A', which='A')} "
                 f"{btn('import_evidence', 'Import evidence set A', which='A')} "
                 f"{btn('import_model', 'Import model B', which='B')} {btn('import_evidence', 'Import evidence set B', which='B')}</p>"
                 f"<p>{btn('build', 'Build package (fixture drafter)', mode='fixture')} "
                 f"{btn('build', 'Build package (seeded drafter errors)', mode='fixture-seeded')} "
                 f"{btn('build', 'Build package (live model)', mode='live')}</p>"
                 f"<p class='small'>Quarantined candidate policy: {btn('candidate', 'Evaluate generated candidate', which='missing_project_check')} "
                 f"{btn('candidate', 'Evaluate candidate using http.send', which='uses_http_send')}</p></div>")
        cur = (f"<div class='card'>Current model: <b>{E(snap['id'])}</b> revision <b>{E(snap['revision'])}</b> "
               f"digest <code>{short(snap['digest'])}</code> · imported by {E(snap['imported_by'])}<br>"
               f"Dependency manifest digest: <code>{short(digest_obj(dep))}</code></div>"
               if snap else "<div class='card'>No model imported.</div>")
        return (cur + steps + "<div class='card'><table><tr><th>Package</th><th>Snapshot</th><th>Drafter</th>"
                "<th>Rows with current evidence</th><th>Freshness</th><th>Review</th><th>Effective</th></tr>"
                + "".join(rows) + "</table></div>")

    def package(self, pid):
        c = self.conn
        p = packages.get(c, pid)
        st = packages.status(c, pid)
        rows = json.loads(p["rows_json"])
        draft = json.loads(p["draft_json"])
        val = json.loads(p["validation_json"])
        man = json.loads(p["manifest_json"])
        n = sum(1 for r in rows if r["evidence_state"] == "CURRENT")
        head = (f"<div class='card'>Freshness <span class='{st['freshness']}'>{st['freshness']}</span> · review "
                f"<span class='{st['review_state']}'>{st['review_state']}</span> · effective "
                f"<span class='{st['effective_state']}'>{st['effective_state']}</span><br>"
                f"<span class='small'>{E('; '.join(st['reasons']))}</span><br>"
                f"package digest <code>{short(p['package_digest'], 20)}</code> · drafter <b>{E(p['drafter_mode'])}</b>"
                f" · OPA {E(man['tools']['opa'])} · code <code>{short(man['code']['workbench_digest'])}</code><br>"
                f"<b>{n} of {len(rows)}</b> selected demo obligation rows have current applicable evidence (not a compliance %).<br>"
                f"Draft validation: {E(json.dumps(val['counts']))}</div>")
        mt = ["<div class='card'><h3>Control and evidence matrix</h3><table><tr><th>Row</th><th>Control stmt / params</th>"
              "<th>Object (rev)</th><th>Design</th><th>Evidence</th><th>Check</th><th>Gaps</th></tr>"]
        for r in rows:
            d = r["detail"]
            design = ""
            if isinstance(d.get("design"), dict):
                ds = d["design"]
                design = f"<span class='{ 'ok' if ds['state'] == 'PRESENT' else 'UNKNOWN'}'>{ds['state']}</span> {E(str(ds['value']))}"
            evs = "".join(f"<div class='small'>{'✔' if e['applicable'] else '✘'} <a href='/evidence/{e['evidence_id']}'>"
                          f"{E(e['evidence_id'])}</a> {E(e['kind'])} {E(str(e.get('result', '')))} "
                          f"{E('; '.join(e['reasons']))}</div>" for e in d.get("evidence", []))
            if r["check"] == "ac3_policy_matches_model" and d.get("tests"):
                t = d["tests"]
                evs += (f"<div class='small'>policy <code>{short(d['policy_digest'])}</code> tests {t['passed']} pass / "
                        f"{t['failed']} fail / {t['errored']} error</div>")
                evs += "".join(f"<div class='small bad'>mismatch: {E(m['role'])} {E(m['action'])} model="
                               f"{m['model_declares']} policy={m['policy_allows']}</div>" for m in d.get("mismatches", []))
            params = "".join(f"<div class='small'>{E(k)}: <span class='UNKNOWN'>{v['state']}</span></div>"
                             for k, v in r["params"].items())
            mt.append(f"<tr><td class='mono'>{E(r['row_id'])}</td><td><code>{E(r['statement_id'])}</code>{params}</td>"
                      f"<td>{E(r['object_id'])} ({E(r['object_revision'])})</td><td>{design}</td>"
                      f"<td><span class='{r['evidence_state']}'>{r['evidence_state']}</span>{evs}</td>"
                      f"<td><span class='{r['result']}'>{r['result']}</span>"
                      f"<div class='small'>{cite_link('check:' + r['check_run_id'])}</div></td>"
                      f"<td class='small'>{'<br>'.join(E(g) for g in r['gaps'])}</td></tr>")
        mt.append("</table></div>")
        dr = ["<div class='card'><h3>Draft (proposed text; validated claims)</h3>"]
        for s in draft["sections"]:
            dr.append(f"<h4>{E(s['title'])}</h4><ul>")
            for cl in s["claims"]:
                v = cl.get("validation", {})
                bad = v.get("status") not in ("CITATIONS_RESOLVE", "NO_CITATION_REQUIRED")
                dr.append(f"<li><span class='kind'>{E(cl['kind'])}</span>{E(cl['text'])} "
                          + " ".join(cite_link(x) for x in cl.get("cites", []))
                          + (f" <span class='flag'>⚠ {E('; '.join(v['problems']))}</span>" if bad else "")
                          + "</li>")
            dr.append("</ul>")
        if draft.get("risks"):
            dr.append("<h4>Proposed risks (hypotheses)</h4><ul>")
            for rk in draft["risks"]:
                dr.append(f"<li><span class='kind'>hypothesis</span>{E(rk['hypothesis'])} — <i>mitigation proposal:</i> "
                          f"{E(rk['proposed_mitigation'])} " + " ".join(cite_link(x) for x in rk.get("triggering", [])) + "</li>")
            dr.append("</ul>")
        if draft.get("questions"):
            dr.append("<h4>Questions for reviewer</h4><ul>" + "".join(f"<li>{E(q['text'])}</li>" for q in draft["questions"]) + "</ul>")
        dr.append("</div>")
        decs = packages.decisions(c, pid)
        rv = ["<div class='card'><h3>Review (document review for the demo; not a control or authorization decision)</h3><ul>"]
        for d in decs:
            rv.append(f"<li><b>{d['id']}</b> {d['decision']} by {E(d['actor'])} — {E(d['reason'])} "
                      f"<span class='small'>bound to <code>{short(d['package_digest'])}</code>; gap rows acknowledged: "
                      f"{len(d['limitations'])}</span>"
                      + (f" <span class='bad'>REVOKED ({E(d['revoked']['reason'])})</span>" if d["revoked"]
                         else " " + btn("revoke_decision", "Revoke", decision_id=d["id"], back=pid)) + "</li>")
        rv.append("</ul>")
        rv.append(f"""<form method="post" action="/act"><input type="hidden" name="action" value="review">
<input type="hidden" name="csrf" value="{CSRF}"><input type="hidden" name="package_id" value="{pid}">
<input type="hidden" name="seen_digest" value="{p['package_digest']}"><input type="hidden" name="seen_head" value="{st['head_decision'] or ''}">
<select name="decision"><option>ACCEPT</option><option>REQUEST_CHANGES</option><option>REJECT</option></select>
<input name="reason" size="60" placeholder="reason (required)"> <button>Record decision as current identity</button></form>""")
        rv.append(f"<p>{btn('export', 'Export as currently reviewed', package_id=pid, mode='current')} "
                  f"{btn('export', 'Export historical copy', package_id=pid, mode='historical')}</p>")
        exps = c.execute("SELECT * FROM exports WHERE package_id=? ORDER BY created_at", (pid,)).fetchall()
        for x in exps:
            rel = Path(x["path"]).relative_to(config.exports_dir())
            links = " · ".join(f"<a href='/files/{rel}/{f}'>{f}</a>" for f in json.loads(x["files_json"]))
            rv.append(f"<div class='small'>{x['id']} ({x['mode']}, status at export {x['status_at_export']}): {links}</div>")
        rv.append("</div>")
        return head + mt[0] + "".join(mt[1:]) + "".join(rv) + "".join(dr)

    def model(self, sid):
        c = self.conn
        snaps = c.execute("SELECT * FROM snapshots ORDER BY seq").fetchall()
        if not snaps:
            return "<p>No model imported.</p>"
        cur = M.current_snapshot(c, demo.PROJECT)
        sid = sid or cur["id"]
        sn = M.snapshot(c, sid)
        pick = " ".join(f"<a href='/model?snap={s['id']}'>{s['id']}</a>" for s in snaps)
        els, fls, bnds = M.elements(c, sid), M.flows(c, sid), M.boundaries(c, sid)
        cite = lambda ptr: cite_link(f"model:{sn['digest']}#{ptr}")
        out = [f"<p>Snapshots: {pick}</p><div class='card'>Snapshot <b>{sid}</b> · source {E(sn['source_id'])} rev "
               f"{E(sn['revision'])} · digest <code>{short(sn['digest'], 20)}</code> · adapter {E(sn['adapter_version'])}"
               f" · synthetic={bool(sn['synthetic'])}</div>"]
        out.append("<div class='card'><h3>Boundaries</h3><ul>" + "".join(
            f"<li>{E(b['id'])} — {E(b['name'])} ({E(b['kind'])}) {cite(b['pointer'])}</li>" for b in bnds.values()) + "</ul>")
        out.append("<h3>Components</h3><table><tr><th>Id</th><th>Rev</th><th>Boundary</th><th>Attributes (null = UNKNOWN)</th><th>Source</th></tr>")
        for e in els.values():
            attrs = e["data"].get("attributes", {})
            a = "<br>".join(f"{E(k)}: " + ("<span class='UNKNOWN'>UNKNOWN</span>" if v is None else f"<code>{E(json.dumps(v))[:160]}</code>")
                            for k, v in attrs.items())
            out.append(f"<tr><td>{E(e['id'])}</td><td>{E(e['revision'])}</td><td>{E(e['boundary'])}</td><td>{a}</td><td>{cite(e['pointer'])}</td></tr>")
        out.append("</table><h3>Flows</h3><table><tr><th>Id</th><th>From → To</th><th>Crosses boundary</th><th>Transport (design)</th><th>Source</th></tr>")
        for f in fls.values():
            t = (f["data"].get("attributes") or {}).get("transport", {}) or {}
            prot = t.get("protection")
            out.append(f"<tr><td>{E(f['id'])}</td><td>{E(f['source'])} → {E(f['target'])}</td>"
                       f"<td class='{'UNKNOWN' if f['crosses'] else ''}'>{'yes' if f['crosses'] else 'no'}</td>"
                       f"<td>{'<span class=UNKNOWN>UNKNOWN</span>' if prot is None else E(prot)}</td><td>{cite(f['pointer'])}</td></tr>")
        out.append("</table></div>")
        return "".join(out)

    def cite(self, c):
        try:
            val = drafting.resolve_citation(self.conn, c)
            shown = val if isinstance(val, str) else json.dumps(val, indent=2)
            return (f"<div class='card'><code>{E(c)}</code><p class='ok'>Resolves against the immutable version.</p>"
                    f"<pre>{E(shown)}</pre><p class='small'>Resolution shows the cited content exists at this digest. "
                    "Whether it supports a claim is a reviewer judgement.</p></div>")
        except Exception as e:
            return f"<div class='card'><code>{E(c)}</code><p class='bad'>Does not resolve: {E(str(e))}</p></div>"

    def evidence(self):
        c = self.conn
        snap = M.current_snapshot(c, demo.PROJECT)
        els = M.elements(c, snap["id"]) if snap else {}
        fls = M.flows(c, snap["id"]) if snap else {}
        rows = ["<table><tr><th>Id</th><th>Kind / type</th><th>Target</th><th>Status</th><th>Applicable to current model</th><th>Digest</th><th></th></tr>"]
        for ev in M.all_evidence(c, demo.PROJECT):
            ok, why = M.applicability(ev, els, fls) if snap else (False, ["no model"])
            act = (btn("evidence_status", "Withdraw", evidence_id=ev["id"], status="withdrawn") if ev["status"] == "active"
                   else btn("evidence_status", "Restore", evidence_id=ev["id"], status="active"))
            rows.append(f"<tr><td><a href='/evidence/{ev['id']}'>{E(ev['id'])}</a></td><td>{E(ev['kind'])} / {E(ev['type'])}"
                        f"{' (synthetic)' if ev['synthetic'] else ''}</td><td class='small'>{E(json.dumps(ev['meta']['target']))}</td>"
                        f"<td>{E(ev['status'])}</td><td class='{'ok' if ok else 'UNKNOWN'}'>{'yes' if ok else 'no'}"
                        f"<div class='small'>{E('; '.join(why))}</div></td><td><code>{short(ev['digest'])}</code></td><td>{act}</td></tr>")
        rows.append("</table>")
        return "<div class='card'>" + "".join(rows) + "<p class='small'>Withdrawal never deletes bytes or history.</p></div>"

    def evidence_raw(self, eid):
        r = self.conn.execute("SELECT raw, meta_json, digest FROM evidence WHERE id=?", (eid,)).fetchone()
        if not r:
            return self.send("not found", 404, "text/plain")
        body = (f"<div class='card'><b>{E(eid)}</b> digest <code>{E(r['digest'])}</code><h4>Envelope</h4>"
                f"<pre>{E(json.dumps(json.loads(r['meta_json']), indent=2))}</pre><h4>Original bytes</h4>"
                f"<pre>{E(r['raw'].decode('utf-8', errors='replace'))}</pre></div>")
        self.send(page(f"Evidence {eid}", body, self.actor))

    def impact(self, q):
        c = self.conn
        snaps = c.execute("SELECT id FROM snapshots ORDER BY seq").fetchall()
        if len(snaps) < 2:
            return "<p>Import two model revisions to compare.</p>"
        a, b = q.get("from", snaps[-2]["id"]), q.get("to", snaps[-1]["id"])
        prior = c.execute("SELECT id FROM packages WHERE snapshot_id=? ORDER BY seq DESC LIMIT 1", (a,)).fetchone()
        rep = impact.impact_report(c, demo.PROJECT, a, b, prior["id"] if prior else None)
        li = lambda xs: "<ul>" + "".join(f"<li>{x}</li>" for x in xs) + "</ul>"
        return (f"<div class='card'><b>{E(a)} → {E(b)}</b>"
                f"<h4>Model changes (by stable id)</h4>" + li(
                    [f"{E(x['change'])} {E(x['kind'])} <b>{E(x['id'])}</b> {E(', '.join(x.get('fields', [])))}"
                     + (" <span class='UNKNOWN'>crosses boundary</span>" if x.get("crosses_boundary") else "")
                     for x in rep["changes"]])
                + "<h4>Affected rows</h4>" + li([f"<code>{E(x['row_id'])}</code>: {E('; '.join(x['why']))}" for x in rep["affected_rows"]])
                + "<h4>Evidence no longer applicable</h4>" + li(
                    [f"{E(x['evidence_id'])}: {E('; '.join(x['reasons']))}" for x in rep["evidence_applicability_changes"]])
                + "<h4>Draft sections citing changed objects</h4>" + li(
                    [f"{E(x['section_id'])} ({E(', '.join(x['because']))})" for x in rep["draft_sections_citing_changed_objects"]])
                + f"<p><b>{E(rep['review_effect'])}</b></p><p class='small'>{E(rep['completeness'])}</p></div>")

    def audit(self):
        c = self.conn
        ch = db.verify_audit_chain(c)
        rows = "".join(f"<tr><td>{r['seq']}</td><td class='small'>{E(r['at'])}</td><td>{E(r['actor'])}</td><td>{E(r['operation'])}</td>"
                       f"<td class='{'ok' if r['outcome'] == 'ok' else 'bad'}'>{E(r['outcome'])}</td><td class='mono'>{E(r['target'] or '')}</td>"
                       f"<td class='small'>{E(r['detail_json'][:200])}</td></tr>"
                       for r in c.execute("SELECT * FROM audit_events ORDER BY seq DESC LIMIT 200"))
        return (f"<div class='card'>Hash chain: <span class='{'ok' if ch['ok'] else 'bad'}'>{'intact' if ch['ok'] else 'BROKEN'}</span> "
                f"({ch['events']} events). <span class='small'>Application-level tamper evidence; a database administrator can "
                f"rewrite the whole chain.</span><table><tr><th>#</th><th>At</th><th>Actor</th><th>Operation</th><th>Outcome</th>"
                f"<th>Target</th><th>Detail</th></tr>{rows}</table></div>")

    def file(self, rel):
        base = config.exports_dir().resolve()
        p = (base / rel).resolve()
        if base not in p.parents or not p.is_file():
            return self.send("not found", 404, "text/plain")
        ctype = "application/json" if p.suffix == ".json" else "text/plain; charset=utf-8"
        self.send(p.read_bytes(), ctype=ctype)

    # --- POST ---
    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        f = {k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()}
        if f.get("csrf") != CSRF:
            return self.send("bad csrf token", 403, "text/plain")
        if self.path == "/whoami":
            self.send_response(303)
            self.send_header("Set-Cookie", f"actor={f.get('actor', 'bob')}; Path=/; SameSite=Strict")
            self.send_header("Location", self.headers.get("Referer") or "/")
            self.end_headers()
            return
        a, actor, c = f.get("action"), self.actor, self.conn
        back = "/"
        try:
            if a == "reset":
                H.conn, _ = demo.reset()
                return self.redirect("/", "State reset. Users and pinned reference data loaded; no model imported.")
            if a == "import_model":
                r = importer.import_model(c, actor, (demo.MODEL_A if f["which"] == "A" else demo.MODEL_B).read_bytes())
                msg = f"Imported {r['snapshot_id']} (created={r['created']}). Existing reviews are now checked against it."
            elif a == "import_evidence":
                r = importer.import_evidence_dir(c, actor, demo.EVIDENCE_A if f["which"] == "A" else demo.EVIDENCE_B)
                msg = f"Imported evidence: {', '.join(x['evidence_id'] for x in r)}"
                back = "/evidence"
            elif a == "evidence_status":
                importer.set_evidence_status(c, actor, f["evidence_id"], f["status"], "via UI")
                msg, back = f"{f['evidence_id']} is now {f['status']}", "/evidence"
            elif a == "build":
                r = packages.build_package(c, actor, demo.PROJECT, mode=f.get("mode", "fixture"))
                msg, back = f"Built {r['package_id']}: {r['coverage']['statement']}", f"/package/{r['package_id']}"
            elif a == "review":
                r = review.decide(c, actor, f["package_id"], f["decision"], f.get("reason", ""),
                                  seen_package_digest=f["seen_digest"], seen_head_decision_id=f.get("seen_head") or None)
                msg, back = f"Recorded {r['decision_id']} {r['decision']}", f"/package/{f['package_id']}"
            elif a == "revoke_decision":
                review.revoke(c, actor, f["decision_id"], "revoked via UI")
                msg, back = f"Revoked {f['decision_id']}", f"/package/{f['back']}"
            elif a == "export":
                r = export.export_package(c, actor, f["package_id"], mode=f["mode"])
                msg, back = f"Exported {r['export_id']} (status at export {r['status_at_export']})", f"/package/{f['package_id']}"
            elif a == "candidate":
                path = config.FIXTURES / "candidates" / f"candidate_{f['which']}.rego"
                r = opa.evaluate_candidate(path.read_text())
                t = r.get("tests", {})
                msg = (f"Candidate {f['which']}: {r['verdict']}"
                       + (f" ({t.get('passed')} pass / {t.get('failed')} fail: {t.get('failed_names')})" if t else
                          f" ({r.get('compile', {}).get('stderr', '')[:200]})")
                       + f". Enforcement policy unchanged: {r['enforcement_policy_unchanged']}.")
            elif a == "revoke_user":
                revoke_user(c, actor, f["user_id"], "via UI")
                msg = f"Revoked {f['user_id']}"
            else:
                return self.redirect("/", f"unknown action {a}", True)
            self.redirect(back, msg)
        except (Denied, review.ReviewConflict, export.ExportRefused, drafting.DraftingError,
                importer.ImportError_, opa.OpaUnavailable, ValueError, LookupError) as e:
            self.redirect(self.headers.get("Referer", "/").split("?")[0].replace(f"http://{self.headers.get('Host')}", "") or "/",
                          f"{type(e).__name__}: {e}", True)


def serve(host="127.0.0.1", port=8765):
    H.conn = db.connect()
    from .identity import seed_users
    from . import reference
    with db.tx(H.conn):
        seed_users(H.conn)
    reference.install(H.conn)
    print(f"DMMC workbench on http://{host}:{port}  (simulated identities; local demo only)")
    HTTPServer((host, port), H).serve_forever()
