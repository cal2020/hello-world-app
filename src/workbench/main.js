import './style.css'
import { api, newOpId, getToken, setToken, ApiError } from './api.js'

// ---------- tiny rendering helpers (all dynamic text is escaped)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const short = (h) => (h ? esc(h.replace('sha256:', '').slice(0, 10)) : '')
const $ = (sel, root = document) => root.querySelector(sel)
const chip = (text, cls = '') => `<span class="chip ${cls}">${esc(text)}</span>`
const stateChip = (s) => chip(s, `state-${String(s).toLowerCase()}`)
const when = (iso) => (iso ? esc(new Date(iso).toLocaleString()) : '')

const LINK_LABEL = {
  RESOLVED: ['citation resolves', 'ok'],
  QUOTE_MISMATCH: ['quote not in passage', 'bad'],
  MISSING_PASSAGE: ['passage does not exist', 'bad'],
  OUTSIDE_MANIFEST: ['source not in manifest', 'bad'],
  RESTRICTED_SOURCE: ['restricted source', 'bad']
}
const SUPPORT_LABEL = { SUPPORTS: ['reviewer: supports', 'ok'], DOES_NOT_SUPPORT: ['reviewer: does not support', 'bad'], CONTRADICTS: ['reviewer: contradicts', 'bad'], INSUFFICIENT: ['reviewer: insufficient', 'warn'] }

const S = {
  tab: 'sources', me: null, users: [], overview: null, sources: [], inbox: [],
  candidateId: null, candidate: null, versionId: null, version: null,
  evidence: null, pending: { remove: new Set(), text: {} },
  impact: null, diffFrom: null, diffTo: null, diff: null,
  runs: [], run: null, evaluation: null, events: [], exportDoc: null,
  notice: null, busy: false, sourceView: null, editing: null, revoking: null
}

function notify(kind, title, body = '') {
  S.notice = { kind, title, body }
  renderNotice()
}
function renderNotice() {
  const el = $('#notice')
  if (!S.notice) { el.innerHTML = ''; return }
  el.innerHTML = `<div class="notice ${S.notice.kind}"><div><strong>${esc(S.notice.title)}</strong>${S.notice.body}</div><button class="link" data-act="dismiss">dismiss</button></div>`
}
function errorBody(e) {
  if (!(e instanceof ApiError)) return `<div>${esc(e.message)}</div>`
  const d = e.details || {}
  const items = []
  for (const r of d.reasons || []) items.push(`<li><code>${esc(r.code)}</code> ${esc(r.message)}</li>`)
  for (const x of d.decisions || []) for (const r of x.reasons) items.push(`<li>Decision ${esc(x.decisionId)} (${esc(x.reviewer)}): ${esc(r)}</li>`)
  for (const b of d.blockingChecks || []) items.push(`<li>${esc(b)}</li>`)
  if (d.delta) for (const c of [...(d.delta.changed || []), ...(d.delta.added || [])]) items.push(`<li>Source change: ${esc(c.from ? `${c.from} -> ${c.to}` : `added ${c.to}`)}</li>`)
  if (d.problems) for (const p of d.problems) items.push(`<li>${esc(p)}</li>`)
  return `<div><code>${esc(e.status)} ${esc(e.code)}</code> ${esc(e.message)}</div>${items.length ? `<ul>${items.join('')}</ul>` : ''}`
}
async function act(label, fn, { success } = {}) {
  if (S.busy) return
  S.busy = true
  document.body.classList.add('busy')
  try {
    const r = await fn()
    if (success) notify('ok', success(r))
    return r
  } catch (e) {
    notify('bad', `${label} was not completed`, errorBody(e))
  } finally {
    S.busy = false
    document.body.classList.remove('busy')
  }
}

// ---------- data loading
async function loadCore() {
  const [overview, sources, inbox, users] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/sources'), api('GET', '/api/inbox'), api('GET', '/api/users')])
  Object.assign(S, { overview, sources, inbox, users })
  S.me = users.find((u) => u.demoToken === getToken()) || users[0]
  if (!S.candidateId && overview.candidates.length) S.candidateId = overview.candidates[overview.candidates.length - 1].candidateId
  if (S.candidateId) {
    S.candidate = await api('GET', `/api/candidates/${S.candidateId}`)
    if (!S.versionId || !S.candidate.versions.some((v) => v.versionId === S.versionId)) S.versionId = S.candidate.latestVersionId
  }
  if (S.versionId) S.version = await api('GET', `/api/versions/${S.versionId}`)
}
async function refresh() {
  await loadCore()
  if (S.tab === 'impact' && S.versionId) S.impact = await api('GET', `/api/versions/${S.impactVersion || S.versionId}/impact`)
  if (S.tab === 'runs') { S.runs = await api('GET', '/api/runs'); S.evaluation = await api('GET', '/api/evaluations/latest') }
  if (S.tab === 'history') S.events = await api('GET', '/api/events')
  render()
}
async function selectVersion(id) {
  S.versionId = id
  S.pending = { remove: new Set(), text: {} }
  S.editing = null
  S.revoking = null
  S.evidence = null
  S.exportDoc = null
  S.version = await api('GET', `/api/versions/${id}`)
  render()
}

// ---------- shell
function render() {
  const o = S.overview
  const live = o?.providers?.anthropic
  $('#app').innerHTML = `
  <header class="top">
    <div class="brand">
      <h1>Procedure Evidence Workbench <span class="muted">prototype</span></h1>
      <div class="badges">${window.__WB_STATIC__ ? `${chip('Runs entirely in your browser; resets on reload', 'info')} <button class="tiny" data-act="reset-demo">Reset demo</button> ` : ''}${chip('SYNTHETIC DATA', 'warn')} ${chip('Simulated system-model export (no Cameo connection)', 'warn')} ${chip(live ? 'Live model available' : 'No live model configured', live ? 'ok' : '')}</div>
    </div>
    <div class="who">
      <label>Acting as <select id="who">${S.users.map((u) => `<option value="${esc(u.demoToken)}" ${u.userId === S.me?.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <div class="muted small">Demo identities: an authorization boundary, not authentication</div>
      <div class="muted small">As-of ${esc(o?.asOf)} · manifest <code>${short(o?.manifest.hash)}</code> · audit chain ${o?.audit.ok ? 'verified' : 'BROKEN'} (${esc(o?.audit.count)})</div>
    </div>
  </header>
  <nav class="tabs">${[['sources', '1 Sources'], ['candidate', '2 Candidate & review'], ['impact', '3 Change impact'], ['runs', '4 Runs & evaluation'], ['history', '5 History']].map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${l}</button>`).join('')}</nav>
  <div id="notice"></div>
  <main>${({ sources: viewSources, candidate: viewCandidate, impact: viewImpact, runs: viewRuns, history: viewHistory })[S.tab]()}</main>`
  renderNotice()
}

// ---------- 1. sources
function viewSources() {
  const active = new Set(S.overview.manifest.entries.map((e) => e.snapshotId))
  const bySource = {}
  for (const s of S.sources) (bySource[s.sourceId] ||= []).push(s)
  const rows = Object.values(bySource).map((revs) => {
    const cur = revs.find((r) => active.has(r.snapshotId))
    const older = revs.filter((r) => r !== cur)
    return `<tr data-source="${esc(cur.snapshotId)}" class="clickable ${S.sourceView === cur.snapshotId ? 'sel' : ''}">
      <td><strong>${esc(cur.sourceId)}</strong><div class="muted small">${esc(cur.title)}</div></td>
      <td>${esc(cur.revision)}${older.length ? `<div class="muted small">supersedes ${older.map((r) => esc(r.revision)).join(', ')}</div>` : ''}</td>
      <td>${esc(cur.kind)}</td><td>${chip(cur.accessLabel, cur.accessLabel === 'PERMITTED' ? '' : 'bad')}</td>
      <td><code>${short(cur.contentHash)}</code></td><td class="small">${esc(cur.effectiveFrom)}</td></tr>`
  }).join('')
  const view = S.sourceView ? S.sources.find((s) => s.snapshotId === S.sourceView) : null
  const canGen = S.me.role !== 'viewer'
  return `
  <section class="grid2">
    <div class="card">
      <h2>Source manifest <span class="muted small">(${S.overview.manifest.entries.length} active snapshots, hash <code>${short(S.overview.manifest.hash)}</code>)</span></h2>
      <p class="muted small">Every revision is kept with its content hash. The highest revision of each source is authoritative by explicit rule; ingesting a source does not make it true.</p>
      <table><thead><tr><th>Source</th><th>Rev</th><th>Kind</th><th>Access</th><th>Hash</th><th>Effective</th></tr></thead><tbody>${rows || '<tr><td colspan="6">No sources. Run <code>npm run demo:reset</code>.</td></tr>'}</tbody></table>
      ${view ? `<div class="passages"><h3>${esc(view.snapshotId)} <span class="muted small">${esc(view.origin)}</span></h3>${view.passages.map((p) => `<p><code>${esc(p.id)}</code> ${esc(p.text)}</p>`).join('')}
        <details><summary>Structured fields</summary><pre>${esc(JSON.stringify(view.structured, null, 2))}</pre></details></div>` : ''}
    </div>
    <div>
      <div class="card">
        <h2>Draft a candidate procedure</h2>
        <label>Objective<textarea id="objective" rows="3">${esc(S.candidate?.objective || 'Draft a candidate inspection procedure for PSK-7 portable sensor kit device DEV-0193.')}</textarea></label>
        <label>Generator <select id="provider">
          <option value="fixture">Simulated model: deterministic fixture with one seeded error (offline)</option>
          <option value="baseline">Template baseline (no synthesis)</option>
          <option value="anthropic">Live model (Claude)${S.overview.providers.anthropic ? '' : ': not configured, run will fail explicitly'}</option>
        </select></label>
        <div class="row"><button class="primary" data-act="generate" ${canGen ? '' : 'disabled'}>${S.candidateId ? 'Regenerate against current sources' : 'Generate candidate'}</button>
        ${S.candidateId ? '<button data-act="new-candidate">Start a new candidate</button>' : ''}</div>
        <p class="muted small">The generator proposes steps, claims and citations. Code checks them; reviewers decide.</p>
      </div>
      <div class="card">
        <h2>Source inbox <span class="muted small">(synthetic changes to import)</span></h2>
        ${S.inbox.map((i) => `<div class="inbox"><div><strong>${esc(i.snapshotId)}</strong> ${i.accessLabel !== 'PERMITTED' ? chip(i.accessLabel, 'bad') : ''}<div class="small">${esc(i.label)}</div></div>
          <button data-import="${esc(i.name)}" ${i.imported || !canGen ? 'disabled' : ''}>${i.imported ? 'Imported' : 'Import'}</button></div>`).join('')}
      </div>
    </div>
  </section>`
}

// ---------- 2. candidate & review
function viewCandidate() {
  if (!S.version) return `<div class="card"><p>No candidate yet. Go to <button class="link" data-tab="sources">Sources</button> and generate one.</p></div>`
  const v = S.version
  const reviewer = S.me.role === 'reviewer'
  const canEdit = S.me.role !== 'viewer' && v.isLatest && v.manifestHash === v.currentManifestHash
  const claims = new Map(v.content.claims.map((c) => [c.id, c]))
  const blockingByTarget = {}
  for (const f of v.checks.findings.filter((x) => x.severity === 'BLOCKING')) (blockingByTarget[f.target] ||= []).push(f)
  const pendingCount = S.pending.remove.size + Object.keys(S.pending.text).length

  const claimRow = (c) => {
    const links = v.checks.links[c.id] || []
    const j = v.judgments[c.id]?.current
    const comp = v.checks.computed[c.id]
    const removed = S.pending.remove.has(c.id)
    const text = S.pending.text[c.id] ?? c.text
    const kindChip = c.kind === 'hypothesis' ? chip('HYPOTHESIS', 'warn') : c.kind === 'computed' ? chip('COMPUTED BY CODE', 'info') : chip('fact', '')
    return `<div class="claim ${removed ? 'removed' : ''}">
      <div class="claim-head"><code>${esc(c.id)}</code> ${kindChip}
        <span class="claim-text">${comp ? `<strong>${esc(comp.result === 'PASS' ? 'CURRENT' : comp.result === 'FAIL' ? 'NOT CURRENT' : 'UNKNOWN')}</strong>: ${esc(comp.text)}` : esc(text)}${S.pending.text[c.id] ? ' ' + chip('edited, unsaved', 'warn') : ''}</span></div>
      ${S.editing === c.id ? `<div class="inline-edit"><label for="edit-text">New wording for ${esc(c.id)}</label><textarea id="edit-text" rows="2">${esc(text)}</textarea><div class="row"><button class="tiny primary" data-act="apply-edit">Apply</button><button class="tiny" data-act="cancel-edit">Cancel</button></div></div>` : ''}
      <div class="claim-meta">
        ${links.map((l, i) => { const [lab, cls] = LINK_LABEL[l.status] || [l.status, 'bad']; return `<button class="cite ${cls} ${S.evidence?.claimId === c.id && S.evidence.i === i ? 'sel' : ''}" data-cite="${esc(c.id)}|${i}">${esc(l.snapshotId)} ${esc(l.passageId)} · ${lab}</button>` }).join('')}
        ${c.kind === 'fact' ? (j ? chip(`${SUPPORT_LABEL[j.support][0]} (${j.reviewer.split(' (')[0]})`, SUPPORT_LABEL[j.support][1]) : chip('not yet judged', 'muted')) : ''}
        ${(blockingByTarget[c.id] || []).map((f) => chip(f.code, 'bad')).join('')}
      </div>
      <div class="claim-actions">
        ${reviewer && c.kind === 'fact' && v.state !== 'STALE' ? ['SUPPORTS', 'DOES_NOT_SUPPORT', 'CONTRADICTS', 'INSUFFICIENT'].map((s) => `<button class="tiny" data-judge="${esc(c.id)}|${s}">${s.replace(/_/g, ' ').toLowerCase()}</button>`).join('') : ''}
        ${canEdit && c.kind !== 'computed' ? `<button class="tiny" data-edit="${esc(c.id)}">edit text</button><button class="tiny" data-remove="${esc(c.id)}">${removed ? 'undo remove' : 'remove'}</button>` : ''}
      </div></div>`
  }
  const steps = v.content.steps.map((s) => `<div class="step"><div class="step-head"><strong>${esc(s.id)}</strong> ${esc(s.text)}</div>
    ${s.decisionPoint ? `<div class="decision-point">Decision point: ${esc(s.decisionPoint.condition)}? If not: ${esc(s.decisionPoint.ifFalse)}</div>` : ''}
    ${s.claimIds.map((id) => (claims.get(id) ? claimRow(claims.get(id)) : `<div class="claim bad">Missing claim ${esc(id)}</div>`)).join('')}</div>`).join('')
  const unattached = v.content.claims.filter((c) => !v.content.steps.some((s) => s.claimIds.includes(c.id)))
  const list = (title, arr, fmt, cls = '') => (arr.length ? `<div class="card ${cls}"><h3>${title}</h3><ul>${arr.map(fmt).join('')}</ul></div>` : '')

  return `
  <section class="version-bar card">
    <div><label>Version <select id="version">${S.candidate.versions.map((x) => `<option value="${esc(x.versionId)}" ${x.versionId === v.versionId ? 'selected' : ''}>v${x.versionNo} · ${esc(x.state)}${x.isLatest ? ' · latest' : ''}${x.editNote ? ` · edit: ${esc(x.editNote)}` : ''}</option>`).join('')}</select></label></div>
    <div>${stateChip(v.state)} ${v.isLatest ? '' : chip('not the latest version', 'warn')} ${chip(v.generation ? `${v.generation.mode}${v.generation.via !== 'run' ? ' + reviewer edit' : ''}` : 'unknown origin', v.generation?.mode === 'LIVE_MODEL' ? 'info' : 'warn')}</div>
    <div class="small muted">digest <code>${short(v.digest)}</code> ${v.integrity.digestMatches ? '' : chip('DIGEST MISMATCH', 'bad')} · sources <code>${short(v.manifestHash)}</code> ${v.manifestHash === v.currentManifestHash ? chip('current', 'ok') : chip('sources changed', 'bad')} · by ${esc(v.createdByName)}</div>
  </section>
  ${v.state === 'STALE' ? `<div class="notice bad"><div><strong>This version is STALE.</strong> Its source manifest is no longer current, so earlier review decisions no longer apply. <button class="link" data-tab="impact">See what needs reassessment</button>, then regenerate from Sources.</div></div>` : ''}
  <section class="grid-main">
    <div>
      <div class="card"><h2>${esc(v.content.title)}</h2><p class="muted small">${esc(v.content.objective)}</p>
        ${pendingCount ? `<div class="pending">${pendingCount} pending edit(s). <input id="edit-note" placeholder="Describe the edit (required)" /> <button class="primary" data-act="save-edit">Save as new version</button> <button data-act="discard-edit">Discard</button></div>` : ''}
        ${steps}
        ${unattached.length ? `<h3>Claims not attached to a step</h3>${unattached.map(claimRow).join('')}` : ''}
      </div>
      ${list('Missing evidence (declared in draft)', v.content.missingEvidence, (m) => `<li><code>${esc(m.id)}</code> ${esc(m.text)}</li>`, 'warn-card')}
      ${list('Conflicts (declared in draft)', v.content.conflicts, (x) => `<li><code>${esc(x.id)}</code> ${esc(x.text)} ${(v.checks.links[x.id] || []).map((l, i) => `<button class="cite ${LINK_LABEL[l.status]?.[1] || 'bad'}" data-cite="${esc(x.id)}|${i}">${esc(l.snapshotId)} ${esc(l.passageId)}</button>`).join('')}</li>`, 'warn-card')}
      ${list('Open questions', v.content.openQuestions, (q) => `<li><code>${esc(q.id)}</code> ${esc(q.text)}</li>`)}
      ${list('Assumptions', v.content.assumptions, (a) => `<li><code>${esc(a.id)}</code> ${esc(a.text)}</li>`)}
    </div>
    <div>
      ${viewEvidencePanel(v)}
      ${viewChecks(v)}
      ${viewReviewPanel(v)}
    </div>
  </section>`
}

function viewEvidencePanel(v) {
  if (!S.evidence) return `<div class="card evidence"><h3>Evidence</h3><p class="muted small">Select a citation to see the exact retained passage. A green citation only means the quoted text exists in that passage revision. Whether it supports the claim is the reviewer's judgment, shown separately.</p></div>`
  const { claimId, i, snapshot } = S.evidence
  const l = (v.checks.links[claimId] || [])[i]
  const claim = v.content.claims.find((c) => c.id === claimId)
  const passages = snapshot ? snapshot.passages.map((p) => {
    if (p.id !== l.passageId) return `<p class="muted"><code>${esc(p.id)}</code> ${esc(p.text)}</p>`
    if (l.status === 'RESOLVED') return `<p class="cited"><code>${esc(p.id)}</code> ${esc(p.text.slice(0, l.span[0]))}<mark>${esc(p.text.slice(l.span[0], l.span[1]))}</mark>${esc(p.text.slice(l.span[1]))}</p>`
    return `<p class="cited"><code>${esc(p.id)}</code> ${esc(p.text)}</p>`
  }).join('') : '<p class="bad-text">Snapshot not found.</p>'
  return `<div class="card evidence"><h3>Evidence for ${esc(claimId)}</h3>
    ${claim ? `<p class="small"><em>${esc(claim.text)}</em></p>` : ''}
    <div class="small">${chip(LINK_LABEL[l.status]?.[0] || l.status, LINK_LABEL[l.status]?.[1] || 'bad')} ${esc(l.detail)}</div>
    ${l.status !== 'RESOLVED' ? `<p class="small">Quoted by generator: <q class="bad-text">${esc(l.quote)}</q></p>` : ''}
    ${snapshot ? `<div class="small muted">${esc(snapshot.snapshotId)} · ${esc(snapshot.title)} · hash <code>${short(snapshot.contentHash)}</code><br/>${esc(snapshot.origin)}</div>` : ''}
    <div class="passages">${passages}</div></div>`
}

function viewChecks(v) {
  const sev = ['BLOCKING', 'WARNING', 'INFO']
  const rows = sev.flatMap((s) => v.checks.findings.filter((f) => f.severity === s)).map((f) => `<li class="sev-${f.severity.toLowerCase()}">${chip(f.severity, f.severity === 'BLOCKING' ? 'bad' : f.severity === 'WARNING' ? 'warn' : 'info')} <code>${esc(f.code)}</code> <span class="small">${esc(f.target)}: ${esc(f.message)}</span></li>`).join('')
  const cov = v.checks.coverage.map((c) => chip(`${c.reqId} ${c.covered ? 'covered' : 'NOT covered'}`, c.covered ? 'ok' : 'bad')).join(' ')
  return `<div class="card"><h3>Deterministic checks <span class="muted small">${esc(v.checks.version)} · ${v.checks.summary.blocking} blocking · ${v.checks.summary.warning} warnings</span></h3>
    <div>${cov}</div><ul class="findings">${rows}</ul></div>`
}

function viewReviewPanel(v) {
  const reviewer = S.me.role === 'reviewer'
  const reasons = v.readiness.reasons
  const decisions = v.decisions.map((d) => `<li>
      ${chip(d.decision, d.decision === 'ACCEPT_FOR_DEMO' ? 'ok' : d.decision === 'REJECT' ? 'bad' : 'warn')} by ${esc(d.reviewer)} · ${when(d.createdAt)}
      <div class="small">"${esc(d.rationale)}"</div>
      <div class="small muted">bound to digest <code>${short(d.candidateDigest)}</code> + sources <code>${short(d.manifestHash)}</code></div>
      ${d.decision === 'ACCEPT_FOR_DEMO' ? (d.status.valid ? chip('applies now', 'ok') : `${chip('no longer applies', 'bad')}<ul class="small">${d.status.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>`) : ''}
      ${reviewer && d.decision === 'ACCEPT_FOR_DEMO' && !d.revokedAt ? (S.revoking === d.decisionId ? `<div class="inline-edit"><label for="revoke-reason">Reason for revoking</label><input id="revoke-reason" placeholder="What changed or what is in doubt" /><div class="row"><button class="tiny primary" data-act="confirm-revoke">Revoke acceptance</button><button class="tiny" data-act="cancel-revoke">Cancel</button></div></div>` : `<button class="tiny" data-revoke="${esc(d.decisionId)}">revoke</button>`) : ''}
    </li>`).join('')
  const unjudged = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current && (v.checks.links[c.id] || []).every((l) => l.status === 'RESOLVED'))
  return `<div class="card review">
    <h3>Review decision</h3>
    ${v.state === 'REVIEWED_FOR_DEMO' ? `<div>${chip('Accepted for demo; see the decision below', 'ok')}</div>` : reasons.length ? `<div class="small"><strong>Acceptance currently blocked (${reasons.length}):</strong><ul class="reasons">${summarizeReasons(reasons)}</ul></div>` : `<div>${chip('Ready for reviewer decision', 'ok')}</div>`}
    ${reviewer && unjudged.length && v.state !== 'STALE' ? `<p class="small"><button class="tiny" data-act="judge-all">Mark ${unjudged.length} unjudged, mechanically resolved claims as SUPPORTS</button><br/><span class="muted">Bulk judgment is recorded per claim under your name. Use it only after reading each passage.</span></p>` : ''}
    ${reviewer ? `<label>Rationale<textarea id="rationale" rows="2" placeholder="Why, citing what you checked"></textarea></label>
      <div class="row"><button class="primary" data-decide="ACCEPT_FOR_DEMO">Accept for demo</button><button data-decide="REQUEST_CHANGES">Request changes</button><button data-decide="REJECT">Reject</button></div>
      <p class="muted small">The server re-checks the exact version digest, current source manifest, blocking findings and judgments in one transaction. A client cannot send "approved".</p>` : `<p class="muted small">Only reviewers can record decisions. Current identity: ${esc(S.me.name)}.</p>`}
    <h3>Decision history</h3>${decisions ? `<ul class="decisions">${decisions}</ul>` : '<p class="muted small">No decisions on this version.</p>'}
    <h3>Export</h3>
    <div class="row"><button data-export="draft">Export as draft</button><button data-export="reviewed">Export as reviewed</button></div>
    ${S.exportDoc ? `<div class="export"><div class="${S.exportDoc.mode === 'reviewed' ? 'ok-text' : 'bad-text'}"><strong>${esc(S.exportDoc.banner)}</strong></div><pre>${esc(S.exportDoc.markdown)}</pre><div class="small muted">export ${esc(S.exportDoc.exportId)} · content hash <code>${short(S.exportDoc.contentHash)}</code></div></div>` : ''}
  </div>`
}

function summarizeReasons(reasons) {
  const groups = {}
  for (const r of reasons) (groups[r.code] ||= []).push(r)
  return Object.entries(groups).map(([code, rs]) => `<li><code>${esc(code)}</code> ${rs.length > 1 ? `×${rs.length}: ` : ''}${esc(rs[0].message)}${rs.length > 1 ? ' …' : ''}</li>`).join('')
}

// ---------- 3. change impact
function viewImpact() {
  if (!S.candidate) return '<div class="card"><p>No candidate yet.</p></div>'
  const im = S.impact
  const verOpts = S.candidate.versions.map((x) => `<option value="${esc(x.versionId)}" ${x.versionId === (S.impactVersion || S.versionId) ? 'selected' : ''}>v${x.versionNo} · ${esc(x.state)}</option>`).join('')
  let body = '<p class="muted">Loading…</p>'
  if (im) {
    const src = [...im.sources.changed.map((c) => `<div class="change"><strong>${esc(c.from)} → ${esc(c.to)}</strong>
        ${c.structured.map((s) => `<div>Structured field <code>${esc(s.field)}</code>: <del>${esc(JSON.stringify(s.before))}</del> → <ins>${esc(JSON.stringify(s.after))}</ins></div>`).join('')}
        ${c.passages.map((p) => `<div class="small"><code>${esc(p.passageId)}</code> ${esc(p.change)}${p.before ? `<div><del>${esc(p.before)}</del></div>` : ''}${p.after ? `<div><ins>${esc(p.after)}</ins></div>` : ''}</div>`).join('')}</div>`),
      ...im.sources.added.map((a) => `<div class="change"><strong>Added ${esc(a.to)}</strong></div>`),
      ...im.sources.removed.map((r) => `<div class="change"><strong>Removed ${esc(r.from)}</strong></div>`)].join('')
    const claims = im.affectedClaims.map((c) => `<tr><td><code>${esc(c.claimId)}</code></td><td>${chip(c.severity, c.severity === 'REASSESS' ? 'bad' : 'warn')}</td><td class="small">${esc(c.text)}</td><td class="small">${c.reasons.map(esc).join('<br/>')}</td><td class="small">${c.judgment ? esc(`${c.judgment.support} by ${c.judgment.reviewer}`) : '<span class="muted">none</span>'}</td></tr>`).join('')
    body = `
      <div class="card"><h2>${im.upToDate ? 'This version is current with the sources' : 'Sources changed since this version was generated'}</h2>
        <div class="small muted">version sources <code>${short(im.versionManifestHash)}</code> · current <code>${short(im.currentManifestHash)}</code> · version state ${stateChip(im.versionState)}</div>
        ${src || '<p class="muted small">No source changes.</p>'}</div>
      ${im.upToDate ? '' : `
      <div class="card"><h2>Conclusions that need reassessment</h2>
        <p class="small muted">REASSESS: cited passage changed, or a computed result changed. RECONFIRM: the source was revised but the cited passage text is unchanged. ${im.unaffectedClaims.length} other claims cite only unchanged sources.</p>
        <table><thead><tr><th>Claim</th><th>Need</th><th>Claim text</th><th>Why</th><th>Prior judgment</th></tr></thead><tbody>${claims || '<tr><td colspan="5">None</td></tr>'}</tbody></table>
        <h3>Affected steps</h3><ul>${im.affectedSteps.map((s) => `<li><strong>${esc(s.stepId)}</strong> ${esc(s.text)} <span class="muted small">(${s.claimIds.map(esc).join(', ')})</span></li>`).join('') || '<li class="muted">None</li>'}</ul>
        ${im.computedChanges.length ? `<h3>Computed results that change</h3><ul>${im.computedChanges.map((c) => `<li>${chip(`${c.before?.result} → ${c.after?.result}`, 'bad')} <div class="small"><del>${esc(c.before?.text)}</del></div><div class="small"><ins>${esc(c.after?.text)}</ins></div></li>`).join('')}</ul>` : ''}
        <h3>Check results against current sources</h3><ul class="findings">${im.checkChanges.map((f) => `<li>${chip(f.change, f.change === 'new' ? 'bad' : 'ok')} ${chip(f.severity, f.severity === 'BLOCKING' ? 'bad' : 'warn')} <code>${esc(f.code)}</code> <span class="small">${esc(f.message)}</span></li>`).join('') || '<li class="muted">No changes</li>'}</ul>
      </div>`}
      <div class="card"><h2>Review decisions on this version</h2>${im.decisions.length ? `<ul>${im.decisions.map((d) => `<li>${chip(d.decision, 'info')} by ${esc(d.reviewer)} ${d.decision === 'ACCEPT_FOR_DEMO' ? (d.status.valid ? chip('applies', 'ok') : chip('no longer applies', 'bad')) : ''}<ul class="small">${d.status.reasons.filter((r) => r.code !== 'NOT_AN_ACCEPTANCE').map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul></li>`).join('')}</ul>` : '<p class="muted small">None. Earlier decisions are retained on the versions they were made on.</p>'}</div>`
  }
  const vs = S.candidate.versions
  const diffOpts = (sel) => vs.map((x) => `<option value="${esc(x.versionId)}" ${x.versionId === sel ? 'selected' : ''}>v${x.versionNo}</option>`).join('')
  const d = S.diff
  const diffBody = d ? `<div class="small">${['steps', 'claims', 'missingEvidence', 'conflicts'].map((k) => `<h4>${k} (${d[k].length} changes)</h4><ul>${d[k].map((x) => `<li>${chip(x.change, x.change === 'added' ? 'ok' : x.change === 'removed' ? 'bad' : 'warn')} <code>${esc(x.id)}</code> ${x.before ? `<del>${esc(x.before.text)}</del>` : ''} ${x.after ? `<ins>${esc(x.after.text)}</ins>` : ''}</li>`).join('')}</ul>`).join('')}
    <h4>sources</h4><ul>${[...d.sources.changed.map((c) => `${c.from} → ${c.to}`), ...d.sources.added.map((a) => `added ${a.to}`)].map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">same sources</li>'}</ul></div>` : ''
  return `<section class="card row"><label>Assess version <select id="impact-version">${verOpts}</select></label><span class="muted small">against the current source manifest</span></section>
    ${body}
    <section class="card"><h2>Compare two versions</h2><div class="row"><select id="diff-from">${diffOpts(S.diffFrom || vs[0]?.versionId)}</select> → <select id="diff-to">${diffOpts(S.diffTo || vs[vs.length - 1]?.versionId)}</select><button data-act="diff">Compare</button></div>${diffBody}</section>`
}

// ---------- 4. runs & evaluation
function viewRuns() {
  const runs = S.runs.map((r) => `<tr class="clickable ${S.run?.runId === r.runId ? 'sel' : ''}" data-run="${esc(r.runId)}"><td><code>${esc(r.runId)}</code></td><td>${chip(r.mode, r.mode === 'LIVE_MODEL' ? 'info' : 'warn')}</td><td>${chip(r.status, r.status === 'SUCCEEDED' ? 'ok' : 'bad')}</td><td><code>${short(r.configHash)}</code></td><td><code>${short(r.manifestHash)}</code></td><td>${esc(r.latencyMs)} ms</td><td class="small">${esc(r.startedBy)}<br/>${when(r.startedAt)}</td><td class="small bad-text">${esc(r.error?.message || '')}</td></tr>`).join('')
  const run = S.run ? `<div class="card"><h3>Run ${esc(S.run.runId)}</h3>
      <div class="grid2"><div><h4>Run manifest (configuration)</h4><pre>${esc(JSON.stringify(S.run.config, null, 2))}</pre></div>
      <div><h4>Model-visible context</h4><p class="small">Included snapshots: ${S.run.context?.retrieval.included.map(esc).join(', ')}</p>
        <p class="small">Excluded: ${S.run.context?.retrieval.excluded.map((x) => esc(`${x.snapshotId} (${x.reason})`)).join(', ') || 'none'}</p>
        <p class="small">${S.run.context?.passages.length} passages sent. Stripped output fields: ${S.run.strippedFields.map(esc).join(', ') || 'none'}</p>
        ${S.run.error ? `<p class="bad-text">${esc(S.run.error.code)}: ${esc(S.run.error.message)}</p>` : ''}
        <details><summary>Raw generator output</summary><pre>${esc(JSON.stringify(S.run.rawOutput, null, 2))}</pre></details></div></div></div>` : ''
  const ev = S.evaluation
  let evBody = '<p class="muted">No evaluation run yet.</p>'
  if (ev) {
    const per = ev.summary.perConfig
    const frac = (x) => (x.total ? `${x[Object.keys(x)[0]]}/${x.total}` : '0/0')
    const cols = Object.keys(per)
    const row = (label, fn) => `<tr><th>${label}</th>${cols.map((c) => `<td>${fn(per[c])}</td>`).join('')}</tr>`
    const byCase = {}
    for (const r of ev.results.filter((x) => x.repeat === 0)) (byCase[r.caseId] ||= {})[r.configId] = r
    evBody = `<p class="small">Suite ${esc(ev.suiteVersion)} · criteria hash <code>${short(ev.criteriaHash)}</code> · code ${esc(ev.codeRevision)} · ${when(ev.finishedAt)}</p>
      <p>${chip(ev.summary.readinessGate.demoReady ? 'Prototype demo gate: PASS' : 'Prototype demo gate: BLOCKED', ev.summary.readinessGate.demoReady ? 'ok' : 'bad')} <span class="small muted">${esc(ev.summary.readinessGate.label)}</span></p>
      <table class="eval"><thead><tr><th></th>${cols.map((c) => `<th>${esc(c)}<div class="small muted">${esc(per[c].label)}</div></th>`).join('')}</tr></thead><tbody>
        ${row('Dev cases passed', (p) => `${p.dev.passed}/${p.dev.cases}`)}
        ${row('Held-out cases passed', (p) => `${p.heldout.passed}/${p.heldout.cases}${p.heldout.failedKnownLimitation ? ` (+${p.heldout.failedKnownLimitation} declared limitation)` : ''}`)}
        ${row('Control expectations', (p) => frac(p.controlExpectations))}
        ${row('Draft-quality expectations', (p) => frac(p.draftQualityExpectations))}
        ${row('Unsafe outcomes (must be 0)', (p) => `${p.unsafeOutcomes} of ${p.mustBlockAttempts} must-block attempts`)}
        ${row('Invalid citations (first draft)', (p) => `${p.invalidCitations.invalid}/${p.invalidCitations.total}`)}
        ${row('Record gaps disclosed in draft', (p) => frac(p.recordGapsDisclosedInDraft))}
        ${row('Record conflicts disclosed in draft', (p) => frac(p.recordConflictsDisclosedInDraft))}
        ${row('Generation latency (median)', (p) => `${p.generationLatencyMs.median} ms, local`)}
        ${row('Cost', (p) => esc(p.costUsd))}
        ${row('Reviewer-adjudicated unsupported claims', (p) => esc(p.reviewerAdjudicatedUnsupportedClaims))}
      </tbody></table>
      <h3>Cases</h3><table class="eval"><thead><tr><th>Case</th><th>Split</th>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>
      ${Object.entries(byCase).map(([id, m]) => `<tr><td><code>${esc(id)}</code> <span class="small">${esc(Object.values(m)[0].title)}</span></td><td>${esc(Object.values(m)[0].split)}</td>${cols.map((c) => {
        const r = m[c]
        if (!r) return '<td class="muted small">n/a</td>'
        const fails = r.expectations.filter((e) => !e.pass)
        return `<td>${chip(r.outcome, r.outcome === 'PASS' ? 'ok' : r.outcome === 'FAIL_CONTROL' ? 'bad' : 'warn')}${fails.map((e) => `<div class="small">${esc(e.type)}: ${esc(JSON.stringify(e.observed))}</div>`).join('')}</td>`
      }).join('')}</tr>`).join('')}</tbody></table>
      <details><summary>Declared criteria and unmeasured items</summary><pre>${esc(JSON.stringify(ev.criteria, null, 2))}</pre></details>`
  }
  return `<section class="card"><h2>Generation runs</h2><table><thead><tr><th>Run</th><th>Mode</th><th>Status</th><th>Config</th><th>Sources</th><th>Latency</th><th>By</th><th>Error</th></tr></thead><tbody>${runs || '<tr><td colspan="8">No runs.</td></tr>'}</tbody></table></section>
    ${run}
    <section class="card"><h2>Evaluation <button data-act="evaluate" ${S.me.role === 'viewer' ? 'disabled' : ''}>Run evaluation suite</button></h2>
      <p class="small muted">Fixed synthetic cases (dev and held-out) run through the same service code in isolated workbenches. They test workflow controls. The simulated model is deterministic code by the same author as the cases, so its "quality" numbers are not evidence about any real model.</p>
      ${evBody}</section>`
}

// ---------- 5. history
function viewHistory() {
  return `<section class="card"><h2>Audit history <span class="muted small">append-only through the application; hash-chained (${S.overview.audit.ok ? 'chain verified' : 'CHAIN BROKEN'})</span></h2>
    <table><thead><tr><th>#</th><th>When</th><th>Actor</th><th>Operation</th><th>Result</th><th>Refs</th><th>Details</th></tr></thead><tbody>
    ${S.events.map((e) => `<tr class="${e.result.startsWith('REJECTED') ? 'rejected' : ''}"><td>${e.seq}</td><td class="small">${when(e.at)}</td><td>${esc(e.actor)}</td><td><code>${esc(e.operation)}</code></td><td>${chip(e.result, e.result.startsWith('REJECTED') || e.result === 'STALE' || e.result === 'FAILED' ? 'bad' : '')}</td>
      <td class="small">${esc(e.subject || '')}${e.priorRef ? `<br/>from ${esc(e.priorRef)}` : ''}${e.newRef ? `<br/>to ${esc(e.newRef)}` : ''}</td><td class="small"><details><summary>show</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details></td></tr>`).join('')}
    </tbody></table></section>`
}

// ---------- events
document.addEventListener('change', async (ev) => {
  const t = ev.target
  if (t.id === 'who') { setToken(t.value); S.pending = { remove: new Set(), text: {} }; await refresh(); notify('info', `Now acting as ${S.me.name}`) }
  if (t.id === 'version') await selectVersion(t.value)
  if (t.id === 'impact-version') { S.impactVersion = t.value; S.impact = await api('GET', `/api/versions/${t.value}/impact`); render() }
  if (t.id === 'diff-from') S.diffFrom = t.value
  if (t.id === 'diff-to') S.diffTo = t.value
})

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, tr.clickable')
  if (!t) return
  const d = t.dataset
  if (d.tab) {
    S.tab = d.tab
    if (d.tab === 'impact') S.impact = null
    render()
    await refresh()
    return
  }
  if (d.act === 'reset-demo') { location.reload(); return }
  if (d.act === 'dismiss') { S.notice = null; renderNotice(); return }
  if (d.source) { S.sourceView = d.source; render(); return }
  if (d.import) {
    await act('Import', () => api('POST', `/api/inbox/${d.import}/import`, { opId: newOpId() }), {
      success: (r) => `Imported ${r.snapshotId}${r.supersedes ? ` (supersedes ${r.supersedes})` : ''}. ${r.markedStale.length ? `${r.markedStale.length} candidate version(s) marked STALE.` : 'No candidate versions affected.'}`
    })
    await refresh()
    return
  }
  if (d.act === 'new-candidate') { S.candidateId = null; S.candidate = null; S.versionId = null; S.version = null; render(); return }
  if (d.act === 'generate') {
    const r = await act('Generation run', () => api('POST', '/api/runs', { opId: newOpId(), candidateId: S.candidateId, objective: $('#objective').value, provider: $('#provider').value, expectedManifestHash: S.overview.manifest.hash }), {
      success: (x) => `Run ${x.runId} (${x.mode}) produced v${x.versionNo}: ${x.state}, ${x.blocking} blocking finding(s).`
    })
    if (r) { S.candidateId = r.candidateId; S.versionId = r.versionId; S.tab = 'candidate'; S.evidence = null; S.exportDoc = null }
    await refresh()
    return
  }
  if (d.cite) {
    const [claimId, i] = d.cite.split('|')
    const l = S.version.checks.links[claimId][Number(i)]
    let snapshot = null
    try { snapshot = await api('GET', `/api/sources/${encodeURIComponent(l.snapshotId)}`) } catch { snapshot = null }
    S.evidence = { claimId, i: Number(i), snapshot }
    render()
    return
  }
  if (d.judge) {
    const [claimId, support] = d.judge.split('|')
    await act('Judgment', () => api('POST', `/api/versions/${S.versionId}/judgments`, { opId: newOpId(), judgments: [{ claimId, support }] }))
    await refresh()
    return
  }
  if (d.act === 'judge-all') {
    const v = S.version
    const ids = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current && v.checks.links[c.id].every((l) => l.status === 'RESOLVED')).map((c) => c.id)
    await act('Judgments', () => api('POST', `/api/versions/${S.versionId}/judgments`, { opId: newOpId(), judgments: ids.map((claimId) => ({ claimId, support: 'SUPPORTS', note: 'bulk judgment after reading passages' })) }), { success: () => `${ids.length} claims judged SUPPORTS.` })
    await refresh()
    return
  }
  if (d.remove) { S.pending.remove.has(d.remove) ? S.pending.remove.delete(d.remove) : S.pending.remove.add(d.remove); render(); return }
  if (d.edit) { S.editing = d.edit; render(); $('#edit-text')?.focus(); return }
  if (d.act === 'cancel-edit') { S.editing = null; render(); return }
  if (d.act === 'apply-edit') {
    const c = S.version.content.claims.find((x) => x.id === S.editing)
    const next = $('#edit-text').value.trim()
    if (next && next !== c.text) S.pending.text[c.id] = next
    else delete S.pending.text[c.id]
    S.editing = null
    render()
    return
  }
  if (d.act === 'discard-edit') { S.pending = { remove: new Set(), text: {} }; render(); return }
  if (d.act === 'save-edit') {
    const v = S.version
    const content = structuredClone(v.content)
    content.claims = content.claims.filter((c) => !S.pending.remove.has(c.id)).map((c) => (S.pending.text[c.id] ? { ...c, text: S.pending.text[c.id] } : c))
    content.steps = content.steps.map((s) => ({ ...s, claimIds: s.claimIds.filter((id) => !S.pending.remove.has(id)) })).filter((s) => s.claimIds.length)
    const note = $('#edit-note').value
    const r = await act('Edit', () => api('POST', `/api/versions/${v.versionId}/edit`, { opId: newOpId(), content, note, expectedDigest: v.digest }), { success: (x) => `Saved v${x.versionNo} (${x.state}). Earlier decisions stay on v${v.versionNo}.` })
    if (r) { S.pending = { remove: new Set(), text: {} }; S.versionId = r.versionId }
    await refresh()
    return
  }
  if (d.decide) {
    const v = S.version
    await act('Decision', () => api('POST', `/api/versions/${v.versionId}/decisions`, { opId: newOpId(), decision: d.decide, rationale: $('#rationale').value, expectedDigest: v.digest, expectedManifestHash: v.manifestHash }), { success: (x) => `Recorded ${x.decision}; version is now ${x.state}.` })
    await refresh()
    return
  }
  if (d.revoke) { S.revoking = d.revoke; render(); $('#revoke-reason')?.focus(); return }
  if (d.act === 'cancel-revoke') { S.revoking = null; render(); return }
  if (d.act === 'confirm-revoke') {
    const reason = $('#revoke-reason').value
    const id = S.revoking
    const r = await act('Revocation', () => api('POST', `/api/decisions/${id}/revoke`, { opId: newOpId(), reason }), { success: () => 'Acceptance revoked; it stays in history.' })
    if (r) S.revoking = null
    await refresh()
    return
  }
  if (d.export) {
    const r = await act('Export', () => api('POST', `/api/versions/${S.versionId}/export`, { opId: newOpId(), mode: d.export }))
    if (r) S.exportDoc = r
    render()
    return
  }
  if (d.act === 'diff') {
    const from = $('#diff-from').value
    const to = $('#diff-to').value
    S.diffFrom = from
    S.diffTo = to
    S.diff = await api('GET', `/api/versions/${from}/diff/${to}`)
    render()
    return
  }
  if (d.run) { S.run = await api('GET', `/api/runs/${d.run}`); render(); return }
  if (d.act === 'evaluate') {
    await act('Evaluation', () => api('POST', '/api/evaluations', { opId: newOpId() }), { success: (r) => `Evaluation ${r.evalRunId} finished.` })
    await refresh()
  }
})

// Started explicitly by boot.js (server build) or src/static/entry.js
// (browser-only build, after its in-page API is ready).
export function start() {
  return refresh().catch((e) => {
  document.querySelector('#app').innerHTML = `<div class="card"><h2>Cannot reach the workbench API</h2><p>${esc(e.message)}</p><p>Start it with <code>npm start</code> (built UI) or <code>npm run server</code> + <code>npm run dev</code>.</p></div>`
})
}
