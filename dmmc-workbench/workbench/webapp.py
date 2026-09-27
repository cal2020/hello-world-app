"""Transport-independent web UI: the same pages and actions for the local HTTP server
(server.py) and the in-browser build (Pyodide; web/worker.js).

Identity is chosen from a SIMULATED identity menu (no authentication). All permission,
freshness and review checks happen in the service layer; this module only calls services
and renders HTML, so the same rules hold for the CLI, tests, the server and the browser.
Everything interpolated into HTML goes through html.escape.
"""
from __future__ import annotations

import html
import json
import os
import platform
import secrets
import sys
import traceback
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from . import config, db, demo, drafting, export, importer, impact, opa, packages, reference, review
from . import model as M
from .identity import Denied, revoke_user, seed_users
from .util import digest_obj, now, short

E = html.escape
USERS = ("bob", "alice", "carol", "sam", "mallory")

CSS = """
:root{--bg:#fbfbf9;--fg:#1d1d1b;--mut:#5c5c57;--line:#d9d8d2;--card:#fff;--pass:#1e6b3a;--fail:#a4262c;--unk:#8a5a00;
--err:#6b2fa0;--acc:#1f4f8f;--stale:#8a5a00}
@media (prefers-color-scheme: dark){:root{color-scheme:dark;--bg:#161615;--fg:#ecebe6;--mut:#a9a8a1;--line:#3a3935;--card:#1f1f1d;
--pass:#6fcf8e;--fail:#ff8a8f;--unk:#f2c46b;--err:#c9a2ff;--acc:#8fb8ff;--stale:#f2c46b}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
header{padding:12px 20px;border-bottom:1px solid var(--line);display:flex;gap:18px;align-items:center;flex-wrap:wrap}
header b{font-size:18px}nav{display:flex;flex-wrap:wrap;gap:4px 14px}nav a{color:var(--acc);text-decoration:none}
nav a:hover,nav a:focus-visible{text-decoration:underline}
main{padding:16px 20px;max-width:1300px}
.banner{background:var(--card);border:1px dashed var(--mut);padding:6px 10px;font-size:14px;color:var(--mut)}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:14px 0;overflow-x:auto}
table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
th{font-size:14px;color:var(--mut);font-weight:600}
.PASS,.CURRENT,.REVIEWED_FOR_DEMO,.ok{color:var(--pass);font-weight:700}.FAIL,.REJECTED,.bad{color:var(--fail);font-weight:700}
.UNKNOWN,.NONE,.INAPPLICABLE_ONLY,.CONFLICT,.NEEDS_REVIEW,.STALE{color:var(--unk);font-weight:700}.ERROR{color:var(--err);font-weight:700}
code,.mono{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:14px;overflow-wrap:anywhere}
pre{white-space:pre-wrap;overflow-wrap:anywhere}
button,select,input,textarea{font:inherit;padding:5px 10px;max-width:100%}button{cursor:pointer}
textarea{width:100%;font-family:ui-monospace,Menlo,Consolas,monospace;font-size:13px}
:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
.msg{padding:10px 14px;border-radius:6px;margin:10px 0;border:1px solid var(--line)}
.msg.err{border-color:var(--fail)}.kind{font-size:12px;border:1px solid var(--line);border-radius:4px;padding:1px 5px;margin-right:6px}
.flag{color:var(--fail);font-weight:700}.small{font-size:14px;color:var(--mut)}
form.inline{display:inline}
"""

ERRORS = (Denied, review.ReviewConflict, export.ExportRefused, drafting.DraftingError, importer.ImportError_,
          opa.OpaUnavailable, db.OperationConflict, ValueError, LookupError)


@dataclass
class Response:
    status: int = 200
    body: str | bytes = ""
    ctype: str = "text/html; charset=utf-8"
    location: str | None = None
    set_actor: str | None = None
    # Parts of an HTML page, so the browser shell can render without replacing its own document.
    title: str | None = None
    header_html: str | None = None
    main_html: str | None = None
    headers: dict = field(default_factory=dict)

    def as_dict(self) -> dict:
        b = self.body
        return {"status": self.status, "ctype": self.ctype, "location": self.location, "set_actor": self.set_actor,
                "title": self.title, "header_html": self.header_html, "main_html": self.main_html,
                "body": b.decode("utf-8", errors="replace") if isinstance(b, bytes) else b}


class WebApp:
    def __init__(self, conn=None, *, runtime_note: str | None = None):
        if conn is None:
            conn = db.connect()
            with db.tx(conn):
                seed_users(conn)
            reference.install(conn)
        self.conn = conn
        self.csrf = secrets.token_hex(16)
        self.runtime_note = runtime_note

    # --- rendering helpers -------------------------------------------------------------

    def btn(self, action, label, **fields):
        hidden = "".join(f'<input type="hidden" name="{E(k)}" value="{E(str(v))}">' for k, v in fields.items())
        return (f'<form method="post" action="/act" class="inline"><input type="hidden" name="action" value="{E(action)}">'
                f'<input type="hidden" name="csrf" value="{self.csrf}">{hidden}<button>{E(label)}</button></form>')

    @staticmethod
    def cite_link(c):
        return f'<a class="mono" href="/cite?c={quote(c)}">{E(c.split(":")[0])}:{E(short(c.split(":", 1)[1], 18))}</a>'

    def header(self, actor):
        ids = "".join(f'<option value="{u}"{" selected" if u == actor else ""}>{u}</option>' for u in USERS)
        return (f'<b>DMMC evidence workbench</b><nav aria-label="Sections"><a href="/">Dashboard</a><a href="/model">Model</a>'
                f'<a href="/evidence">Evidence</a><a href="/impact">Impact</a><a href="/audit">Audit</a>'
                f'<a href="/eval">Acceptance suite</a><a href="/about">About</a></nav>'
                f'<form method="post" action="/whoami" class="inline"><label for="actor-select">SIMULATED identity '
                f'(no authentication):</label> <select id="actor-select" name="actor" onchange="this.form.requestSubmit()">{ids}'
                f'</select><input type="hidden" name="csrf" value="{self.csrf}"><noscript><button>Switch</button></noscript></form>')

    def main(self, title, body, msg=None, err=False):
        m = f'<div class="msg{" err" if err else ""}" role="status">{E(msg)}</div>' if msg else ""
        note = f"<br>{E(self.runtime_note)}" if self.runtime_note else ""
        return (f'<div class="banner">Synthetic data only. Fixture evidence is not an observation of a real system. Outputs are '
                f'partial drafts for expert review, not an SSP, assessment or authorization decision.{note}</div>'
                f'{m}<h2>{E(title)}</h2>{body}')

    def page(self, title, body, actor, msg=None, err=False, status=200) -> Response:
        hdr, mn = self.header(actor), self.main(title, body, msg, err)
        full = (f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" '
                f'content="width=device-width,initial-scale=1"><title>DMMC Evidence Workbench</title><style>{CSS}</style>'
                f'</head><body><header>{hdr}</header><main>{mn}</main></body></html>')
        return Response(status=status, body=full, title=title, header_html=hdr, main_html=mn)

    @staticmethod
    def redirect(to, msg=None, err=False) -> Response:
        if msg:
            to += ("&" if "?" in to else "?") + f"msg={quote(msg)}" + ("&err=1" if err else "")
        return Response(status=303, location=to)

    # --- GET ---------------------------------------------------------------------------

    def get(self, path_qs: str, actor: str) -> Response:
        u = urlparse(path_qs)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        msg, err = q.get("msg"), bool(q.get("err"))
        actor = actor if actor in USERS else "bob"
        try:
            if u.path == "/":
                body, title = self.dashboard(), "Dashboard"
            elif u.path.startswith("/package/"):
                pid = u.path.split("/")[2]
                body, title = self.package(pid), f"Package {pid}"
            elif u.path == "/model":
                body, title = self.model(q.get("snap")), "Model explorer"
            elif u.path == "/cite":
                body, title = self.cite(q.get("c", "")), "Citation"
            elif u.path == "/evidence":
                body, title = self.evidence(), "Evidence"
            elif u.path.startswith("/evidence/"):
                eid = u.path.split("/")[2]
                body, title = self.evidence_raw(eid), f"Evidence {eid}"
            elif u.path == "/impact":
                body, title = self.impact(q), "Change impact"
            elif u.path == "/audit":
                body, title = self.audit(), "Audit events"
            elif u.path == "/eval":
                body, title = self.eval_page(), "Acceptance suite"
            elif u.path == "/about":
                body, title = self.about(), "About this runtime"
            elif u.path.startswith("/files/"):
                return self.file(u.path[len("/files/"):])
            else:
                return self.page("Not found", "<p>No such page.</p>", actor, status=404)
            return self.page(title, body, actor, msg, err)
        except LookupError as e:
            return self.page("Not found", f"<p>{E(str(e))}</p>", actor, status=404)
        except Exception as e:
            return self.page("Error", f"<pre>{E(traceback.format_exc())}</pre>", actor, str(e), True, status=500)

    def dashboard(self):
        c = self.conn
        snap = M.current_snapshot(c, demo.PROJECT)
        dep = packages.dependency_manifest(c, demo.PROJECT) if snap else None
        rows = []
        for p in packages.list_packages(c, demo.PROJECT):
            st = packages.status(c, p["id"])
            cov = json.loads(p["rows_json"])
            n = sum(1 for r in cov if r["evidence_state"] == "CURRENT")
            rows.append(f"<tr><td><a href='/package/{E(p['id'])}'>{E(p['id'])}</a></td><td>{E(p['snapshot_id'])}</td>"
                        f"<td>{E(p['drafter_mode'])}</td><td>{n} of {len(cov)}</td>"
                        f"<td class='{st['freshness']}'>{st['freshness']}</td><td class='{st['review_state']}'>{st['review_state']}</td>"
                        f"<td class='{st['effective_state']}'>{st['effective_state']}</td></tr>")
        b = self.btn
        steps = (f"<div class='card'><b>Demo controls</b><p>"
                 f"{b('reset', 'Reset demo state')} {b('import_model', 'Import model A', which='A')} "
                 f"{b('import_evidence', 'Import evidence set A', which='A')} "
                 f"{b('import_model', 'Import model B', which='B')} {b('import_evidence', 'Import evidence set B', which='B')}</p>"
                 f"<p>{b('build', 'Build package (fixture drafter)', mode='fixture')} "
                 f"{b('build', 'Build package (seeded drafter errors)', mode='fixture-seeded')} "
                 f"{b('build', 'Build package (live model)', mode='live')}</p>"
                 f"<p class='small'>Quarantined candidate policy: {b('candidate', 'Evaluate generated candidate', which='missing_project_check')} "
                 f"{b('candidate', 'Evaluate candidate using http.send', which='uses_http_send')}</p>"
                 f"<p class='small'>Or paste your own model revision on the <a href='/model'>Model</a> page.</p></div>")
        cur = (f"<div class='card'>Current model: <b>{E(snap['id'])}</b> revision <b>{E(snap['revision'])}</b> "
               f"digest <code>{short(snap['digest'])}</code> · imported by {E(snap['imported_by'])}<br>"
               f"Dependency manifest digest: <code>{short(digest_obj(dep))}</code></div>"
               if snap else "<div class='card'>No model imported. Start with <b>Import model A</b>, then <b>Import evidence set A</b> "
                            "and <b>Build package</b>.</div>")
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
                design = f"<span class='{'ok' if ds['state'] == 'PRESENT' else 'UNKNOWN'}'>{ds['state']}</span> {E(str(ds['value']))}"
            evs = "".join(f"<div class='small'>{'✔' if e['applicable'] else '✘'} <a href='/evidence/{E(e['evidence_id'])}'>"
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
                      f"<div class='small'>{self.cite_link('check:' + r['check_run_id'])}</div></td>"
                      f"<td class='small'>{'<br>'.join(E(g) for g in r['gaps'])}</td></tr>")
        mt.append("</table></div>")
        dr = ["<div class='card'><h3>Draft (proposed text; validated claims)</h3>"]
        for s in draft["sections"]:
            dr.append(f"<h4>{E(s['title'])}</h4><ul>")
            for cl in s["claims"]:
                v = cl.get("validation", {})
                bad = v.get("status") not in ("CITATIONS_RESOLVE", "NO_CITATION_REQUIRED")
                dr.append(f"<li><span class='kind'>{E(cl['kind'])}</span>{E(cl['text'])} "
                          + " ".join(self.cite_link(x) for x in cl.get("cites", []))
                          + (f" <span class='flag'>⚠ {E('; '.join(v['problems']))}</span>" if bad else "")
                          + "</li>")
            dr.append("</ul>")
        if draft.get("risks"):
            dr.append("<h4>Proposed risks (hypotheses)</h4><ul>")
            for rk in draft["risks"]:
                dr.append(f"<li><span class='kind'>hypothesis</span>{E(rk['hypothesis'])} — <i>mitigation proposal:</i> "
                          f"{E(rk['proposed_mitigation'])} " + " ".join(self.cite_link(x) for x in rk.get("triggering", [])) + "</li>")
            dr.append("</ul>")
        if draft.get("questions"):
            dr.append("<h4>Questions for reviewer</h4><ul>" + "".join(f"<li>{E(q['text'])}</li>" for q in draft["questions"]) + "</ul>")
        dr.append("</div>")
        decs = packages.decisions(c, pid)
        rv = ["<div class='card'><h3>Review (document review for the demo; not a control or authorization decision)</h3><ul>"]
        for d in decs:
            rv.append(f"<li><b>{E(d['id'])}</b> {E(d['decision'])} by {E(d['actor'])} — {E(d['reason'])} "
                      f"<span class='small'>bound to <code>{short(d['package_digest'])}</code>; gap rows acknowledged: "
                      f"{len(d['limitations'])}</span>"
                      + (f" <span class='bad'>REVOKED ({E(d['revoked']['reason'])})</span>" if d["revoked"]
                         else " " + self.btn("revoke_decision", "Revoke", decision_id=d["id"], back=pid)) + "</li>")
        rv.append("</ul>")
        rv.append(f"""<form method="post" action="/act"><input type="hidden" name="action" value="review">
<input type="hidden" name="csrf" value="{self.csrf}"><input type="hidden" name="package_id" value="{E(pid)}">
<input type="hidden" name="seen_digest" value="{E(p['package_digest'])}"><input type="hidden" name="seen_head" value="{E(st['head_decision'] or '')}">
<label for="decision-select">Decision</label> <select id="decision-select" name="decision"><option>ACCEPT</option><option>REQUEST_CHANGES</option><option>REJECT</option></select>
<label for="reason-input">Reason</label> <input id="reason-input" name="reason" size="60" placeholder="required"> <button>Record decision as current identity</button></form>""")
        rv.append(f"<p>{self.btn('export', 'Export as currently reviewed', package_id=pid, mode='current')} "
                  f"{self.btn('export', 'Export historical copy', package_id=pid, mode='historical')}</p>")
        exps = c.execute("SELECT * FROM exports WHERE package_id=? ORDER BY created_at", (pid,)).fetchall()
        for x in exps:
            rel = Path(x["path"]).relative_to(config.exports_dir())
            links = " · ".join(f"<a href='/files/{quote(str(rel))}/{quote(f)}'>{E(f)}</a>" for f in json.loads(x["files_json"]))
            rv.append(f"<div class='small'>{E(x['id'])} ({E(x['mode'])}, status at export {E(x['status_at_export'])}): {links}</div>")
        rv.append("</div>")
        return head + "".join(mt) + "".join(rv) + "".join(dr)

    def model(self, sid):
        c = self.conn
        snaps = c.execute("SELECT * FROM snapshots ORDER BY seq").fetchall()
        paste = self.paste_form()
        if not snaps:
            return "<p>No model imported.</p>" + paste
        cur = M.current_snapshot(c, demo.PROJECT)
        sid = sid or cur["id"]
        sn = M.snapshot(c, sid)
        if sn is None:
            raise LookupError(f"unknown snapshot {sid}")
        pick = " ".join(f"<a href='/model?snap={quote(s['id'])}'>{E(s['id'])}</a>" for s in snaps)
        els, fls, bnds = M.elements(c, sid), M.flows(c, sid), M.boundaries(c, sid)
        cite = lambda ptr: self.cite_link(f"model:{sn['digest']}#{ptr}")
        out = [f"<p>Snapshots: {pick}</p><div class='card'>Snapshot <b>{E(sid)}</b> · source {E(sn['source_id'])} rev "
               f"{E(sn['revision'])} · digest <code>{short(sn['digest'], 20)}</code> · adapter {E(sn['adapter_version'])}"
               f" · synthetic={bool(sn['synthetic'])}</div>"]
        out.append("<div class='card'><h3>Boundaries</h3><ul>" + "".join(
            f"<li>{E(b['id'])} — {E(b['name'] or '')} ({E(b['kind'] or '')}) {cite(b['pointer'])}</li>" for b in bnds.values()) + "</ul>")
        out.append("<h3>Components</h3><table><tr><th>Id</th><th>Rev</th><th>Boundary</th><th>Attributes (null = UNKNOWN)</th><th>Source</th></tr>")
        for e in els.values():
            attrs = e["data"].get("attributes") or {}
            a = "<br>".join(f"{E(k)}: " + ("<span class='UNKNOWN'>UNKNOWN</span>" if v is None else f"<code>{E(json.dumps(v)[:160])}</code>")
                            for k, v in attrs.items())
            out.append(f"<tr><td>{E(e['id'])}</td><td>{E(e['revision'])}</td><td>{E(e['boundary'] or '')}</td><td>{a}</td><td>{cite(e['pointer'])}</td></tr>")
        out.append("</table><h3>Flows</h3><table><tr><th>Id</th><th>From → To</th><th>Crosses boundary</th><th>Transport (design)</th><th>Source</th></tr>")
        for f in fls.values():
            t = (f["data"].get("attributes") or {}).get("transport") or {}
            prot = t.get("protection")
            out.append(f"<tr><td>{E(f['id'])}</td><td>{E(f['source'])} → {E(f['target'])}</td>"
                       f"<td class='{'UNKNOWN' if f['crosses'] else ''}'>{'yes' if f['crosses'] else 'no'}</td>"
                       f"<td>{'<span class=UNKNOWN>UNKNOWN</span>' if prot is None else E(str(prot))}</td><td>{cite(f['pointer'])}</td></tr>")
        out.append("</table></div>")
        return "".join(out) + paste

    def paste_form(self):
        sample = demo.MODEL_B.read_text()
        return (f"<div class='card'><h3>Import your own model revision</h3><p class='small'>Paste a model export that follows the "
                f"synthetic contract (edit the sample: change a permission, add a flow, set a value to null). It is validated, "
                f"hashed and imported as the current revision for <code>proj-mtel</code>; then build a package to see the checks. "
                f"Requires an engineer identity.</p><form method='post' action='/act'><input type='hidden' name='action' "
                f"value='import_model_json'><input type='hidden' name='csrf' value='{self.csrf}'>"
                f"<label for='model-json'>Model export JSON</label><textarea id='model-json' name='model_json' rows='14' "
                f"spellcheck='false'>{E(sample)}</textarea><p><button>Validate and import</button></p></form></div>")

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
            act = (self.btn("evidence_status", "Withdraw", evidence_id=ev["id"], status="withdrawn") if ev["status"] == "active"
                   else self.btn("evidence_status", "Restore", evidence_id=ev["id"], status="active"))
            rows.append(f"<tr><td><a href='/evidence/{E(ev['id'])}'>{E(ev['id'])}</a></td><td>{E(ev['kind'])} / {E(ev['type'])}"
                        f"{' (synthetic)' if ev['synthetic'] else ''}</td><td class='small'>{E(json.dumps(ev['meta']['target']))}</td>"
                        f"<td>{E(ev['status'])}</td><td class='{'ok' if ok else 'UNKNOWN'}'>{'yes' if ok else 'no'}"
                        f"<div class='small'>{E('; '.join(why))}</div></td><td><code>{short(ev['digest'])}</code></td><td>{act}</td></tr>")
        rows.append("</table>")
        return "<div class='card'>" + "".join(rows) + "<p class='small'>Withdrawal never deletes bytes or history.</p></div>"

    def evidence_raw(self, eid):
        r = self.conn.execute("SELECT raw, meta_json, digest FROM evidence WHERE id=?", (eid,)).fetchone()
        if not r:
            raise LookupError(f"unknown evidence {eid}")
        return (f"<div class='card'><b>{E(eid)}</b> digest <code>{E(r['digest'])}</code><h4>Envelope</h4>"
                f"<pre>{E(json.dumps(json.loads(r['meta_json']), indent=2))}</pre><h4>Original bytes</h4>"
                f"<pre>{E(r['raw'].decode('utf-8', errors='replace'))}</pre></div>")

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

    def _eval_report_path(self) -> Path:
        return config.data_dir() / "reports" / "evaluation_report.json"

    def eval_page(self):
        intro = ("<div class='card'><p>Runs the 22 acceptance scenarios from <code>eval/run_eval.py</code> in this runtime. Each "
                 "scenario uses its own temporary database; your demo state is not touched. It takes a few seconds.</p>" + self.btn("run_eval", "Run the acceptance suite now") + "</div>")
        p = self._eval_report_path()
        if not p.exists():
            return intro + "<p>No run yet in this runtime.</p>"
        rep = json.loads(p.read_text())
        env, s = rep["environment"], rep["summary"]
        rows = "".join(f"<tr><td>{E(r['id'])}</td><td class='{'PASS' if r['passed'] else 'FAIL'}'>{'PASS' if r['passed'] else 'FAIL'}</td>"
                       f"<td>{r['ms']}</td><td>{E(r['title'])}{('<div class=small>' + E('; '.join(r['failures'])) + '</div>') if r['failures'] else ''}"
                       f"{('<div class=small>' + E(str(r['detail'].get('note'))) + '</div>') if isinstance(r['detail'], dict) and r['detail'].get('note') else ''}</td></tr>"
                       for r in rep["cases"])
        base = "".join(f"<tr><td>{E(c['scenario'])}</td><td>{c['rows']}</td><td>{c['workbench_gap_rows_found']} / {c['baseline_gap_rows_found']}"
                       f" of {c['expected_gap_rows']}</td><td>{c['workbench_overclaims']} / {c['baseline_overclaims']}</td>"
                       f"<td>{c['workbench_citations_resolved']} / {c['workbench_citations']}</td></tr>"
                       for c in rep["baseline_comparison"])
        return (intro + f"<div class='card'><p><b class='{'PASS' if s['passed'] == s['cases'] else 'FAIL'}'>{s['passed']} of "
                f"{s['cases']} cases passed</b> · run at {E(str(rep.get('ran_at', '')))} · Python {E(env['python'])} · OPA "
                f"{E(env['opa'])} · code <code>{E(env['code_digest'][:12])}</code> · git <code>{E(env['git'])}</code></p>"
                f"<table><tr><th>Case</th><th>Result</th><th>ms</th><th>Scenario</th></tr>{rows}</table></div>"
                f"<div class='card'><h3>Template baseline vs. workbench</h3><table><tr><th>Scenario</th><th>Rows</th>"
                f"<th>Gap rows found (workbench / template)</th><th>Unsupported implementation claims (workbench / template)</th>"
                f"<th>Citations resolved</th></tr>{base}</table><p class='small'>Synthetic, self-authored cases: engineering checks, "
                f"not independent measurements. The advantage comes from deterministic checks, not AI.</p></div>")

    def about(self):
        info = {
            "Python": f"{platform.python_implementation()} {platform.python_version()} ({sys.platform})",
            "OPA backend": f"{opa.backend()} — {opa.version()}",
            "Workbench code digest": config.code_digest(),
            "Git revision": config.git_revision(),
            "Data directory": str(config.data_dir()),
            "Clock": os.environ.get("DMMC_NOW", "system clock"),
        }
        rows = "".join(f"<tr><th>{E(k)}</th><td><code>{E(v)}</code></td></tr>" for k, v in info.items())
        return (f"<div class='card'><table>{rows}</table></div><div class='card small'><p>The code digest covers the Python "
                f"files in <code>workbench/</code>, so it can be compared with a checkout of the same revision.</p>"
                f"<p>With the Wasm OPA backend, policy decisions and the independent Rego tests execute live, but Rego is "
                f"compiled only when the site is built: a policy whose content was not compiled then is reported as unavailable "
                f"and its check becomes ERROR.</p></div>")

    def file(self, rel):
        base = config.exports_dir().resolve()
        p = (base / rel).resolve()
        if base not in p.parents or not p.is_file():
            return Response(status=404, body="not found", ctype="text/plain")
        ctype = "application/json" if p.suffix == ".json" else "text/plain; charset=utf-8"
        return Response(body=p.read_bytes(), ctype=ctype)

    # --- POST --------------------------------------------------------------------------

    def post(self, path: str, form: dict, actor: str, referer: str = "/") -> Response:
        if form.get("csrf") != self.csrf:
            return Response(status=403, body="bad csrf token", ctype="text/plain")
        if path == "/whoami":
            new = form.get("actor", "bob")
            return Response(status=303, location=referer or "/", set_actor=new if new in USERS else "bob")
        if path != "/act":
            return Response(status=404, body="not found", ctype="text/plain")
        a, c = form.get("action"), self.conn
        actor = actor if actor in USERS else "bob"
        back = "/"
        try:
            if a == "reset":
                self.conn.close()
                self.conn, _ = demo.reset()
                return self.redirect("/", "State reset. Users and pinned reference data loaded; no model imported.")
            if a == "import_model":
                r = importer.import_model(c, actor, (demo.MODEL_A if form.get("which") == "A" else demo.MODEL_B).read_bytes())
                msg = f"Imported {r['snapshot_id']} (created={r['created']}). Existing reviews are now checked against it."
            elif a == "import_model_json":
                r = importer.import_model(c, actor, form.get("model_json", "").encode("utf-8"))
                msg, back = (f"Imported {r['snapshot_id']} (created={r['created']}). Build a package to run the checks.",
                             "/model")
            elif a == "import_evidence":
                r = importer.import_evidence_dir(c, actor, demo.EVIDENCE_A if form.get("which") == "A" else demo.EVIDENCE_B)
                msg = f"Imported evidence: {', '.join(x['evidence_id'] for x in r)}"
                back = "/evidence"
            elif a == "evidence_status":
                importer.set_evidence_status(c, actor, form["evidence_id"], form["status"], "via UI")
                msg, back = f"{form['evidence_id']} is now {form['status']}", "/evidence"
            elif a == "build":
                r = packages.build_package(c, actor, demo.PROJECT, mode=form.get("mode", "fixture"))
                msg, back = f"Built {r['package_id']}: {r['coverage']['statement']}", f"/package/{r['package_id']}"
            elif a == "review":
                r = review.decide(c, actor, form["package_id"], form["decision"], form.get("reason", ""),
                                  seen_package_digest=form["seen_digest"], seen_head_decision_id=form.get("seen_head") or None)
                msg, back = f"Recorded {r['decision_id']} {r['decision']}", f"/package/{form['package_id']}"
            elif a == "revoke_decision":
                review.revoke(c, actor, form["decision_id"], "revoked via UI")
                msg, back = f"Revoked {form['decision_id']}", f"/package/{form['back']}"
            elif a == "export":
                r = export.export_package(c, actor, form["package_id"], mode=form["mode"])
                msg, back = f"Exported {r['export_id']} (status at export {r['status_at_export']})", f"/package/{form['package_id']}"
            elif a == "candidate":
                which = form.get("which")
                if which not in ("missing_project_check", "uses_http_send"):
                    raise ValueError("unknown candidate")
                path_ = config.FIXTURES / "candidates" / f"candidate_{which}.rego"
                r = opa.evaluate_candidate(path_.read_text())
                t = r.get("tests", {})
                msg = (f"Candidate {which}: {r['verdict']}"
                       + (f" ({t.get('passed')} pass / {t.get('failed')} fail: {t.get('failed_names')})" if t else
                          f" ({r.get('compile', {}).get('stderr', '')[:200]})")
                       + f". Enforcement policy unchanged: {r['enforcement_policy_unchanged']}.")
            elif a == "revoke_user":
                revoke_user(c, actor, form["user_id"], "via UI")
                msg = f"Revoked {form['user_id']}"
            elif a == "run_eval":
                rep = run_acceptance_suite()
                rep["ran_at"] = now()
                p = self._eval_report_path()
                p.parent.mkdir(parents=True, exist_ok=True)
                p.write_text(json.dumps(rep, default=str))
                s = rep["summary"]
                msg, back = f"Acceptance suite: {s['passed']} of {s['cases']} cases passed.", "/eval"
            else:
                return self.redirect("/", f"unknown action {a}", True)
            return self.redirect(back, msg)
        except ERRORS as e:
            return self.redirect(_local_path(referer), f"{type(e).__name__}: {e}", True)
        except KeyError as e:
            return self.redirect(_local_path(referer), f"Missing form field {e}", True)


def _local_path(referer: str | None) -> str:
    """Only ever redirect within the app."""
    if not referer:
        return "/"
    u = urlparse(referer)
    path = u.path or "/"
    return path if path.startswith("/") and not path.startswith("//") else "/"


def run_acceptance_suite() -> dict:
    """Run eval/run_eval.py in-process without touching the app's own state."""
    root = str(config.ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    from eval import run_eval
    return run_eval.run_all()
