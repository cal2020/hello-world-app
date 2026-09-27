import './style.css'
import { api, newOpId, getToken, setToken, ApiError } from './api.js'

// ---------- tiny rendering helpers (all dynamic text is escaped)
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const short = (h) => (h ? esc(h.replace('sha256:', '').slice(0, 10)) : '')
const $ = (sel, root = document) => root.querySelector(sel)
const chip = (text, cls = '', title = '') => `<span class="chip ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`
const stateChip = (s) => chip(s, `state-${String(s).toLowerCase()}`)
const modeLabel = (m) => (m === 'SIMULATED' ? 'SIMULATED · not AI' : m)
const when = (iso) => (iso ? esc(new Date(iso).toLocaleString()) : '')

const LINK_LABEL = {
  RESOLVED: ['citation resolves', 'ok'],
  QUOTE_MISMATCH: ['quote not in passage', 'bad'],
  MISSING_PASSAGE: ['passage does not exist', 'bad'],
  OUTSIDE_MANIFEST: ['source not in manifest', 'bad'],
  RESTRICTED_SOURCE: ['restricted source', 'bad']
}
const SUPPORT_LABEL = { SUPPORTS: ['reviewer: supports', 'ok'], DOES_NOT_SUPPORT: ['reviewer: does not support', 'bad'], CONTRADICTS: ['reviewer: contradicts', 'bad'], INSUFFICIENT: ['reviewer: insufficient', 'warn'] }

// URL fragment flags, e.g. #reviewed,guide. Shared with src/static/entry.js.
export function parseHashFlags() {
  return location.hash.slice(1).split(/[,&+]/).map((f) => f.trim().toLowerCase()).filter(Boolean)
}

const S = {
  tab: 'sources', me: null, users: [], overview: null, sources: [], inbox: [],
  candidateId: null, candidate: null, versionId: null, version: null,
  evidence: null, pending: { remove: new Set(), text: {} },
  impact: null, impactVersion: null, impactExportResult: null, diffFrom: null, diffTo: null, diff: null,
  runs: [], run: null, evaluation: null, events: [], exportDoc: null, exportFor: null,
  notice: null, busy: false, sourceView: null, editing: null, revoking: null,
  drafts: {}, lastErrorCode: null, seenErrors: new Set(), visited: new Set(), visitedLate: false, resetArm: null, refusedAfterChange: false
}

// Typed text survives re-renders (keyed by version and field id).
const draftKey = (id) => `${S.versionId}:${id}`
const draft = (id) => S.drafts[draftKey(id)] ?? ''
const clearDraft = (id) => { delete S.drafts[draftKey(id)] }

// ---------- presenter guide (#guide): progress is derived from real state;
// the guide never performs a judgment, decision or import itself.
const hasAcceptance = () => S.candidate?.versions.some((x) => x.state === 'REVIEWED_FOR_DEMO') ||
  Boolean(S.version?.decisions?.some((d) => d.decision === 'ACCEPT_FOR_DEMO')) || Boolean(S.impact?.decisions?.some((d) => d.decision === 'ACCEPT_FOR_DEMO'))
const reqChanged = () => Boolean(S.overview?.manifest.entries.some((e) => e.sourceId === 'REQ-002' && e.revision === 'B'))
// Only an export refusal seen after REQ-002 rev B is imported counts; an
// accidental earlier 'Export as reviewed' must not tick this step off. The
// flag survives later errors and tab switches.
const refused = () => S.refusedAfterChange
const noteExportRefusal = (code) => { if (code === 'EXPORT_BLOCKED' && reqChanged()) S.refusedAfterChange = true }
const logImported = () => Boolean(S.inbox.find((i) => i.name === 'insp-log-rev2')?.imported)
// After the corrected log is imported the loaded version is STALE until a
// new one is generated from the current manifest; point at Regenerate then.
const needsRegenerate = () => logImported() && (!S.version || S.version.state === 'STALE' || S.version.manifestHash !== S.overview?.manifest.hash)
// Each step also counts as done once a later milestone is reached, so a
// stage start (#reviewed,guide) lands on the right step.
export const GUIDE = [
  { id: 'sources', label: 'Sources', tab: 'sources', doLine: 'Click REQ-002@A in the manifest.', lookFor: 'Revision, content hash, and structured field maxCalibrationAgeDays: 180.', target: '[data-source^="REQ-002@"]', done: () => (S.visited.has('sources') && Boolean(S.sourceView)) || Boolean(S.candidateId) },
  { id: 'generate', label: 'Generate a candidate', tab: 'sources', doLine: 'Click Generate candidate, then the red citation.', lookFor: 'v1 DRAFT with blocking findings; "quote not in passage".', target: '[data-act="generate"]', done: () => Boolean(S.candidate) },
  { id: 'gate', label: 'Try to accept', tab: 'candidate', doLine: 'Click Accept for demo on v1.', lookFor: '409 REVIEW_BLOCKED with the list of reasons.', target: '[data-decide="ACCEPT_FOR_DEMO"]', done: () => S.lastErrorCode === 'REVIEW_BLOCKED' || S.seenErrors.has('REVIEW_BLOCKED') || logImported() || hasAcceptance() },
  { id: 'reviewed', label: 'Correct, review, accept', tab: () => (logImported() && !needsRegenerate() ? 'candidate' : 'sources'), doLine: 'Import the corrected log, regenerate, remove C14, save, judge, type a rationale, Accept for demo.', lookFor: 'v3 REVIEWED_FOR_DEMO, bound to digest + sources.', target: () => (!logImported() ? '[data-import="insp-log-rev2"]' : needsRegenerate() ? '[data-act="generate"]' : '[data-decide="ACCEPT_FOR_DEMO"]'), done: () => hasAcceptance() },
  { id: 'change', label: 'Change the requirement', tab: 'impact', doLine: 'Import REQ-002 revision B (180 → 90 days).', lookFor: 'Verdict banner: REASSESS / RECONFIRM, C6 PASS → FAIL, acceptance no longer applies.', target: '[data-import="req-002-revB"]', done: () => reqChanged() },
  { id: 'refused', label: 'Old acceptance refused', tab: 'impact', doLine: 'Click "Try to reuse this acceptance".', lookFor: '409 EXPORT_BLOCKED and REQ-002@A -> REQ-002@B, under the button.', target: '[data-act="impact-export"]', done: () => refused() },
  { id: 'evidence', label: 'Runs, evaluation, history', tab: 'runs', doLine: 'Open 4 Runs & evaluation, then 5 History.', lookFor: 'SIMULATED · not AI run mode, H08 declared limitation, verified audit chain.', target: '[data-act="evaluate"]', done: () => refused() && S.visitedLate }
]
const guideOn = () => parseHashFlags().includes('guide')
const guideIndex = () => { const i = GUIDE.findIndex((g) => !g.done()); return i === -1 ? GUIDE.length : i }
const pick = (x) => (typeof x === 'function' ? x() : x)
const RESET_STAGES = [['', 'Start'], ['draft', 'Draft'], ['reviewed', 'Reviewed'], ['changed', 'After change']]
function viewGuide() {
  if (!guideOn()) return ''
  const cur = guideIndex()
  const step = GUIDE[cur]
  const dots = GUIDE.map((g, i) => { const st = i < cur ? 'done' : i === cur ? 'current' : 'todo'; return `<li class="dot ${st}" title="${esc(g.label)}"><span class="sr">Step ${i + 1} ${esc(g.label)}: ${st}</span></li>` }).join('')
  const resets = window.__WB_STATIC__ ? `<div class="guide-reset"><span class="muted small">Reset to:</span> ${RESET_STAGES.map(([k, l]) => `<button class="tiny" data-reset-stage="${esc(k || 'start')}">${S.resetArm === `stage:${k || 'start'}` ? 'Click again to reset' : esc(l)}</button>`).join('')}</div>` : ''
  return `<div class="guide" role="region" aria-label="Presenter guide">
    <ol class="dots">${dots}</ol>
    <div class="guide-body">${step ? `<strong>Step ${cur + 1} of ${GUIDE.length}: ${esc(step.label)}</strong> <span class="guide-do">Do: ${esc(step.doLine)}</span> <span class="guide-look muted">Look for: ${esc(step.lookFor)}</span>` : `<strong>All ${GUIDE.length} steps done.</strong>`}</div>
    ${step ? '<button class="tiny primary" data-act="guide-go">Go</button>' : ''}
    ${resets}
  </div>`
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
    S.lastErrorCode = e instanceof ApiError ? e.code : null
    if (S.lastErrorCode) { S.seenErrors.add(S.lastErrorCode); noteExportRefusal(S.lastErrorCode) }
    notify('bad', `${label} was not completed`, errorBody(e))
  } finally {
    S.busy = false
    document.body.classList.remove('busy')
  }
}

// ---------- data loading
async function loadCore() {
  const prevVersionId = S.versionId
  const [overview, sources, inbox, users] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/sources'), api('GET', '/api/inbox'), api('GET', '/api/users')])
  Object.assign(S, { overview, sources, inbox, users })
  S.me = users.find((u) => u.demoToken === getToken()) || users[0]
  if (!S.candidateId && overview.candidates.length) S.candidateId = overview.candidates[overview.candidates.length - 1].candidateId
  if (S.candidateId) {
    S.candidate = await api('GET', `/api/candidates/${S.candidateId}`)
    if (!S.versionId || !S.candidate.versions.some((v) => v.versionId === S.versionId)) S.versionId = S.candidate.latestVersionId
  }
  if (S.versionId) S.version = await api('GET', `/api/versions/${S.versionId}`)
  if (S.versionId !== prevVersionId) {
    S.evidence = null
    S.editing = null
    S.revoking = null
    S.pending = { remove: new Set(), text: {} }
  }
}
async function refresh() {
  await loadCore()
  if (S.tab === 'impact' && S.versionId) S.impact = await api('GET', `/api/versions/${S.impactVersion || S.versionId}/impact`)
  S.visited.add(S.tab)
  if ((S.tab === 'runs' || S.tab === 'history') && refused()) S.visitedLate = true
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
  S.impactVersion = null
  S.impactExportResult = null
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
      <div class="badges">${window.__WB_STATIC__ ? `${chip('Runs entirely in your browser; resets on reload', 'info')} <button class="tiny" data-act="reset-demo">${S.resetArm === 'reload' ? 'Click again to reset' : 'Reset demo'}</button> ` : ''}${chip('SYNTHETIC DATA', 'warn')} ${chip('Simulated system-model export (no Cameo connection)', 'warn')} ${chip(live ? 'Live model available' : 'No live model configured', live ? 'ok' : '')}</div>
    </div>
    <div class="who">
      <label>Acting as <select id="who">${S.users.map((u) => `<option value="${esc(u.demoToken)}" ${u.userId === S.me?.userId ? 'selected' : ''}>${esc(u.name)}</option>`).join('')}</select></label>
      <div class="muted small">Demo identities: an authorization boundary, not authentication</div>
      <div class="muted small">As-of ${esc(o?.asOf)} · <span title="the set of source revisions this version was built from">manifest</span> <code>${short(o?.manifest.hash)}</code> · audit chain ${o?.audit.ok ? 'verified' : 'BROKEN'} (${esc(o?.audit.count)})</div>
    </div>
  </header>
  <nav class="tabs">${[['sources', '1 Sources'], ['candidate', '2 Candidate & review'], ['impact', '3 Change impact'], ['runs', '4 Runs & evaluation'], ['history', '5 History']].map(([k, l]) => `<button data-tab="${k}" class="${S.tab === k ? 'active' : ''}">${l}${tabBadge(k)}</button>`).join('')}</nav>
  ${viewGuide()}
  <div id="notice"></div>
  <main>${({ sources: viewSources, candidate: viewCandidate, impact: viewImpact, runs: viewRuns, history: viewHistory })[S.tab]()}</main>`
  renderNotice()
}

// Tab badges from already loaded data (no extra fetch).
function tabBadge(k) {
  if (k === 'candidate' && S.version?.state === 'STALE') return ' ' + stateChip('STALE')
  if (k === 'impact' && S.version && S.overview && S.version.manifestHash !== S.overview.manifest.hash) return ' ' + chip('sources changed', 'bad')
  return ''
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
  const DEMO_INBOX = { 'insp-log-rev2': 'demo step 4', 'req-002-revB': 'demo step 5: requirement change' }
  const inboxRow = (i) => `<div class="inbox"><div><strong>${esc(i.snapshotId)}</strong> ${DEMO_INBOX[i.name] ? chip(DEMO_INBOX[i.name], 'info') : ''} ${i.accessLabel !== 'PERMITTED' ? chip(i.accessLabel, 'bad') : ''}<div class="small">${esc(i.label)}</div>${DEMO_INBOX[i.name] ? '<div class="small muted">Supersedes an earlier revision; versions citing it become STALE</div>' : ''}</div>
          <button data-import="${esc(i.name)}" ${i.imported || !canGen ? 'disabled' : ''}>${i.imported ? 'Imported' : 'Import'}</button></div>`
  const demoInbox = Object.keys(DEMO_INBOX).map((n) => S.inbox.find((i) => i.name === n)).filter(Boolean)
  const otherInbox = S.inbox.filter((i) => !DEMO_INBOX[i.name])
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
          <option value="fixture" selected>Simulated model: deterministic fixture, not AI (one seeded error, offline)</option>
          <option value="baseline">Template baseline (no synthesis)</option>
          ${window.__WB_STATIC__ || !S.overview.providers.anthropic ? '<option value="anthropic" disabled>Live model (Claude): not used in this demo</option>' : '<option value="anthropic">Live model (Claude)</option>'}
        </select></label>
        <div class="row"><button class="primary" data-act="generate" ${canGen ? '' : 'disabled'}>${S.candidateId ? 'Regenerate against current sources' : 'Generate candidate'}</button>
        ${S.candidateId ? '<button data-act="new-candidate">Start a new candidate</button>' : ''}</div>
        <p class="muted small">The generator proposes steps, claims and citations. Code checks them; reviewers decide.</p>
      </div>
      <div class="card">
        <h2>Source inbox <span class="muted small">(synthetic changes to import)</span></h2>
        ${demoInbox.map(inboxRow).join('')}
        ${otherInbox.length ? `<details class="other-inbox"><summary>Other test imports (new evidence, access control, prompt injection)</summary>${otherInbox.map(inboxRow).join('')}</details>` : ''}
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
    <div>${stateChip(v.state)} ${v.isLatest ? '' : chip('not the latest version', 'warn')} ${chip(v.generation ? `${modeLabel(v.generation.mode)}${v.generation.via !== 'run' ? ' + reviewer edit' : ''}` : 'unknown origin', v.generation?.mode === 'LIVE_MODEL' ? 'info' : 'warn')}</div>
    <div class="small muted"><span title="fingerprint of this exact version's content">digest</span> <code>${short(v.digest)}</code> ${v.integrity.digestMatches ? '' : chip('DIGEST MISMATCH', 'bad')} · <span title="the set of source revisions this version was built from">sources</span> <code>${short(v.manifestHash)}</code> ${v.manifestHash === v.currentManifestHash ? chip('current', 'ok') : chip('sources changed', 'bad')} · by ${esc(v.createdByName)}</div>
  </section>
  ${v.state === 'STALE' ? `<div class="notice bad"><div><strong>This version is STALE.</strong> Its source manifest is no longer current, so earlier review decisions no longer apply. <button class="link" data-tab="impact">See what needs reassessment</button>, then regenerate from Sources.</div></div>` : ''}
  <section class="grid-main">
    <div>
      <div class="card"><h2>${esc(v.content.title)}</h2><p class="muted small">${esc(v.content.objective)}</p>
        ${pendingCount ? `<div class="pending">${pendingCount} pending edit(s). <input id="edit-note" placeholder="Describe the edit (required)" value="${esc(draft('edit-note'))}" /> <button class="primary" data-act="save-edit">Save as new version</button> <button data-act="discard-edit">Discard</button></div>` : ''}
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
  const l = v.checks.links[claimId]?.[i]
  if (!l) { S.evidence = null; return viewEvidencePanel(v) }
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
  const stale = v.state === 'STALE'
  const decisions = v.decisions.map((d) => `<li>
      ${chip(d.decision, d.decision === 'ACCEPT_FOR_DEMO' ? 'ok' : d.decision === 'REJECT' ? 'bad' : 'warn')} ${isScripted(d.rationale) ? chip('SCRIPTED SETUP', 'warn', 'Recorded by the demo setup script, not by a person reading the passages') : ''} by ${esc(d.reviewer)} · ${when(d.createdAt)}
      <div class="small">"${esc(d.rationale)}"</div>
      <div class="small muted">bound to <span title="fingerprint of this exact version's content">digest</span> <code>${short(d.candidateDigest)}</code> + <span title="the set of source revisions this version was built from">sources</span> <code>${short(d.manifestHash)}</code></div>
      ${d.decision === 'ACCEPT_FOR_DEMO' ? (d.status.valid ? chip('applies now', 'ok') : `${chip('no longer applies', 'bad')}<ul class="small">${d.status.reasons.map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul>`) : ''}
      ${reviewer && d.decision === 'ACCEPT_FOR_DEMO' && !d.revokedAt ? (S.revoking === d.decisionId ? `<div class="inline-edit"><label for="revoke-reason">Reason for revoking</label><input id="revoke-reason" placeholder="What changed or what is in doubt" value="${esc(draft('revoke-reason'))}" /><div class="row"><button class="tiny primary" data-act="confirm-revoke">Revoke acceptance</button><button class="tiny" data-act="cancel-revoke">Cancel</button></div></div>` : `<button class="tiny" data-revoke="${esc(d.decisionId)}">revoke</button>`) : ''}
    </li>`).join('')
  const unjudged = v.content.claims.filter((c) => c.kind === 'fact' && !v.judgments[c.id].current && (v.checks.links[c.id] || []).every((l) => l.status === 'RESOLVED'))
  // Only render the export result for the exact version + sources it was made from.
  const showExport = S.exportDoc && S.exportFor && S.exportFor.versionId === v.versionId && S.exportFor.manifestHash === v.currentManifestHash
  const status = stale
    ? `<p class="small">This version is STALE: its sources changed. Generate a new candidate version against the current sources (tab 1 → Generate), or see <button class="link" data-tab="impact">what needs reassessment</button>.</p>`
    : v.state === 'REVIEWED_FOR_DEMO' ? `<div>${chip('Accepted for demo; see the decision below', 'ok')}</div>` : reasons.length ? `<div class="small"><strong>Acceptance currently blocked (${reasons.length}):</strong><ul class="reasons">${summarizeReasons(reasons)}</ul></div>` : `<div>${chip('Ready for reviewer decision', 'ok')}</div>`
  return `<div class="card review">
    <h3>Review decision</h3>
    ${status}
    ${reviewer && unjudged.length && !stale ? `<p class="small"><button class="tiny" data-act="judge-all">Demo shortcut: mark ${unjudged.length} mechanically resolved claims SUPPORTS</button><br/><span class="muted">In real use each passage is read first. This records that it was a shortcut, under your name.</span></p>` : ''}
    ${stale ? '' : reviewer ? `<label>Rationale<textarea id="rationale" rows="2" placeholder="Why, citing what you checked">${esc(draft('rationale'))}</textarea></label>
      <div class="row"><button class="primary" data-decide="ACCEPT_FOR_DEMO">Accept for demo</button><button data-decide="REQUEST_CHANGES">Request changes</button><button data-decide="REJECT">Reject</button></div>
      <p class="muted small">The server re-checks the exact version digest, current source manifest, blocking findings and judgments in one transaction. A client cannot send "approved".</p>` : `<p class="muted small">Only reviewers can record decisions. Current identity: ${esc(S.me.name)}.</p>`}
    <h3>Decision history</h3>${decisions ? `<ul class="decisions">${decisions}</ul>` : '<p class="muted small">No decisions on this version.</p>'}
    <h3>Export</h3>
    <div class="row"><button data-export="draft">Export as draft</button><button data-export="reviewed">Export as reviewed</button></div>
    ${showExport ? `<div class="export"><div class="${S.exportDoc.mode === 'reviewed' ? 'ok-text' : 'bad-text'}"><strong>${esc(S.exportDoc.banner)}</strong></div><pre>${esc(S.exportDoc.markdown)}</pre><div class="small muted">export ${esc(S.exportDoc.exportId)} · content hash <code>${short(S.exportDoc.contentHash)}</code></div></div>` : ''}
  </div>`
}

const isScripted = (text) => typeof text === 'string' && text.startsWith('Scripted demo setup')

function summarizeReasons(reasons) {
  const groups = {}
  for (const r of reasons) (groups[r.code] ||= []).push(r)
  return Object.entries(groups).map(([code, rs]) => `<li><code>${esc(code)}</code> ${rs.length > 1 ? `×${rs.length}: ` : ''}${esc(rs[0].message)}${rs.length > 1 ? ' …' : ''}</li>`).join('')
}

// ---------- 3. change impact
const isScalar = (x) => x === null || ['string', 'number', 'boolean'].includes(typeof x)
const fmtVal = (x) => (typeof x === 'string' ? x : JSON.stringify(x))
const RECONFIRM_TITLE = 'source revised; cited text unchanged; confirm it still applies'
function viewVerdict(im, selector) {
  const cause = [
    ...im.sources.changed.map((c) => `<span class="cause-item">${esc(c.from)} → ${esc(c.to)}${c.structured.length
      ? c.structured.map((f) => (isScalar(f.before) && isScalar(f.after)
        ? ` · ${esc(f.field)} <del>${esc(fmtVal(f.before))}</del> → <ins>${esc(fmtVal(f.after))}</ins>`
        : ` · ${esc(f.field)} changed`)).join('')
      : ` · ${c.passages.length} passage(s) changed`}</span>`),
    ...im.sources.added.map((x) => `<span class="cause-item">added ${esc(x.to)}</span>`),
    ...im.sources.removed.map((x) => `<span class="cause-item">removed ${esc(x.from)}</span>`)
  ].join(' ')
  const reassess = im.affectedClaims.filter((c) => c.severity === 'REASSESS').length
  const reconfirm = im.affectedClaims.filter((c) => c.severity === 'RECONFIRM').length
  const stepTotal = S.version?.versionId === im.versionId ? S.version.content.steps.length : null
  const tile = (n, label, cls = '', title = '') => `<div class="stat ${cls}"${title ? ` title="${esc(title)}"` : ''}><b>${Number(n)}</b><span>${esc(label)}</span></div>`
  const stats = `<div class="stats">
    ${tile(reassess, 'REASSESS', 'bad', 'cited passage changed, or a computed result changed')}
    ${tile(reconfirm, 'RECONFIRM', 'warn', RECONFIRM_TITLE)}
    ${tile(im.affectedSteps.length, `${im.affectedSteps.length === 1 ? 'step' : 'steps'} affected${stepTotal ? ` of ${stepTotal}` : ''}`)}
    ${tile(im.unaffectedClaims.length, 'claims unaffected', 'muted')}
    ${tile(im.computedChanges.length, im.computedChanges.length === 1 ? 'computed flip' : 'computed flips', im.computedChanges.length ? 'bad' : 'muted')}
  </div>`
  const flips = im.computedChanges.map((c) => `<div class="flip">${chip(`${c.claimId}: ${c.before?.result ?? 'UNKNOWN'} → ${c.after?.result ?? 'UNKNOWN'}`, 'bad')} <span>${esc(c.after?.text)}</span></div>`).join('')
  const lapsed = im.decisions.filter((d) => d.decision === 'ACCEPT_FOR_DEMO' && !d.status.valid)
  const r = S.impactExportResult
  const approval = lapsed.length
    ? `${lapsed.map((d) => `<div class="notice bad"><div><strong>${esc(d.reviewer.split(' (')[0])}'s acceptance for demo no longer applies</strong>${d.status.reasons[0] ? `<div class="small">${esc(d.status.reasons[0].message)}</div>` : ''}</div></div>`).join('')}
      <div class="row"><button data-act="impact-export">Try to reuse this acceptance (export as reviewed)</button></div>
      ${r ? `<div class="notice ${r.ok ? 'ok' : 'bad'} inline-result"><div>${r.html}</div></div>` : ''}`
    : '<p class="muted small">No acceptance on this version.</p>'
  return `<section class="card verdict">
    <div class="verdict-head"><h2>Sources changed since this version was generated</h2>${selector}</div>
    <div class="cause">${cause || 'Source manifest changed'}</div>
    ${stats}
    ${flips ? `<div class="flips">${flips}</div>` : ''}
    ${approval}
  </section>`
}

function viewImpact() {
  if (!S.candidate) return '<div class="card"><p>No candidate yet.</p></div>'
  const im = S.impact
  const verOpts = S.candidate.versions.map((x) => `<option value="${esc(x.versionId)}" ${x.versionId === (S.impactVersion || S.versionId) ? 'selected' : ''}>v${x.versionNo} · ${esc(x.state)}</option>`).join('')
  const selector = `<label class="compact">Assess version <select id="impact-version">${verOpts}</select></label>`
  const selectorCard = `<section class="card row">${selector}<span class="muted small">against the current source manifest</span></section>`
  let body = `${selectorCard}<p class="muted">Loading…</p>`
  if (im) {
    const src = [...im.sources.changed.map((c) => `<div class="change"><strong>${esc(c.from)} → ${esc(c.to)}</strong>
        ${c.structured.map((s) => `<div>Structured field <code>${esc(s.field)}</code>: <del>${esc(JSON.stringify(s.before))}</del> → <ins>${esc(JSON.stringify(s.after))}</ins></div>`).join('')}
        ${c.passages.map((p) => `<div class="small"><code>${esc(p.passageId)}</code> ${esc(p.change)}${p.before ? `<div><del>${esc(p.before)}</del></div>` : ''}${p.after ? `<div><ins>${esc(p.after)}</ins></div>` : ''}</div>`).join('')}</div>`),
      ...im.sources.added.map((a) => `<div class="change"><strong>Added ${esc(a.to)}</strong></div>`),
      ...im.sources.removed.map((r) => `<div class="change"><strong>Removed ${esc(r.from)}</strong></div>`)].join('')
    const flipFor = new Map(im.computedChanges.map((c) => [c.claimId, c]))
    const claims = im.affectedClaims.map((c) => `<tr><td><code>${esc(c.claimId)}</code></td><td>${chip(c.severity, c.severity === 'REASSESS' ? 'bad' : 'warn', c.severity === 'RECONFIRM' ? RECONFIRM_TITLE : 'cited passage changed, or a computed result changed')}</td><td class="small">${esc(c.text)}</td><td class="small">${c.reasons.map(esc).join('<br/>')}${flipFor.get(c.claimId)?.after?.text ? esc(': ' + flipFor.get(c.claimId).after.text) : ''}</td><td class="small">${c.judgment ? esc(`${c.judgment.support} by ${c.judgment.reviewer}`) : '<span class="muted">none</span>'}</td></tr>`).join('')
    const fingerprints = `<details class="small muted"><summary>Source fingerprints</summary>version sources <code>${short(im.versionManifestHash)}</code> · current <code>${short(im.currentManifestHash)}</code> · version state ${stateChip(im.versionState)}</details>`
    const decisionsCard = `<div class="card"><h2>Review decisions on this version</h2>${im.decisions.length ? `<ul>${im.decisions.map((d) => `<li>${chip(d.decision, 'info')} ${isScripted(d.rationale) ? chip('SCRIPTED SETUP', 'warn') : ''} by ${esc(d.reviewer)} ${d.decision === 'ACCEPT_FOR_DEMO' ? (d.status.valid ? chip('applies', 'ok') : chip('no longer applies', 'bad')) : ''}<ul class="small">${d.status.reasons.filter((r) => r.code !== 'NOT_AN_ACCEPTANCE').map((r) => `<li>${esc(r.message)}</li>`).join('')}</ul></li>`).join('')}</ul>` : '<p class="muted small">None. Earlier decisions are retained on the versions they were made on.</p>'}</div>`
    const revB = S.inbox.find((i) => i.name === 'req-002-revB')
    const oldLimit = S.sources.find((x) => x.snapshotId === 'REQ-002@A')?.structured?.maxCalibrationAgeDays
    const whatIf = im.upToDate && revB && !revB.imported ? `<div class="card"><h2>What if the requirement changes?</h2>
        <p>${oldLimit != null ? `REQ-002@A currently sets <code>maxCalibrationAgeDays</code> to <strong>${esc(oldLimit)}</strong>. Revision B changes it to 90 days.` : 'REQ-002 revision B changes the calibration limit from 180 to 90 days.'}</p>
        <div class="row"><button class="primary" data-import="req-002-revB" ${S.me.role === 'viewer' ? 'disabled' : ''}>Import REQ-002 revision B (180 → 90 days)</button></div></div>` : ''
    body = im.upToDate
      ? `${selectorCard}${whatIf}
      <div class="card"><h2>This version is current with the sources</h2>${fingerprints}${src || '<p class="muted small">No source changes.</p>'}</div>
      ${decisionsCard}`
      : `${viewVerdict(im, selector)}
      ${decisionsCard}
      <div class="card"><h2>What changed in the sources</h2>${fingerprints}${src || '<p class="muted small">No source changes.</p>'}</div>
      <div class="card"><h2>Conclusions that need reassessment</h2>
        <p class="small muted">REASSESS: cited passage changed, or a computed result changed. RECONFIRM: the source was revised but the cited passage text is unchanged. ${im.unaffectedClaims.length} other claims cite only unchanged sources.</p>
        <table><thead><tr><th>Claim</th><th>Need</th><th>Claim text</th><th>Why</th><th>Prior judgment</th></tr></thead><tbody>${claims || '<tr><td colspan="5">None</td></tr>'}</tbody></table>
        <h3>Affected steps</h3><ul>${im.affectedSteps.map((s) => `<li><strong>${esc(s.stepId)}</strong> ${esc(s.text)} <span class="muted small">(${s.claimIds.map(esc).join(', ')})</span></li>`).join('') || '<li class="muted">None</li>'}</ul>
        ${im.computedChanges.length ? `<h3>Computed results that change</h3>${im.computedChanges.map((c) => `<div class="beforeafter">
          <div><div class="small muted">Before (version sources)</div>${chip(`${c.claimId}: ${c.before?.result ?? 'UNKNOWN'}`, c.before?.result === 'PASS' ? 'ok' : 'bad')}<div class="small">${esc(c.before?.text)}</div></div>
          <div><div class="small muted">After (current sources)</div>${chip(`${c.claimId}: ${c.after?.result ?? 'UNKNOWN'}`, c.after?.result === 'PASS' ? 'ok' : 'bad')}<div class="small">${esc(c.after?.text)}</div></div></div>`).join('')}` : ''}
        <h3>Check results against current sources</h3><ul class="findings">${im.checkChanges.map((f) => `<li>${chip(f.change, f.change === 'new' ? 'bad' : 'ok')} ${chip(f.severity, f.severity === 'BLOCKING' ? 'bad' : 'warn')} <code>${esc(f.code)}</code> <span class="small">${esc(f.message)}</span></li>`).join('') || '<li class="muted">No changes</li>'}</ul>
      </div>`
  }
  const vs = S.candidate.versions
  const diffOpts = (sel) => vs.map((x) => `<option value="${esc(x.versionId)}" ${x.versionId === sel ? 'selected' : ''}>v${x.versionNo}</option>`).join('')
  const d = S.diff
  const diffBody = d ? `<div class="small">${['steps', 'claims', 'missingEvidence', 'conflicts'].map((k) => `<h4>${k} (${d[k].length} changes)</h4><ul>${d[k].map((x) => `<li>${chip(x.change, x.change === 'added' ? 'ok' : x.change === 'removed' ? 'bad' : 'warn')} <code>${esc(x.id)}</code> ${x.before ? `<del>${esc(x.before.text)}</del>` : ''} ${x.after ? `<ins>${esc(x.after.text)}</ins>` : ''}</li>`).join('')}</ul>`).join('')}
    <h4>sources</h4><ul>${[...d.sources.changed.map((c) => `${c.from} → ${c.to}`), ...d.sources.added.map((a) => `added ${a.to}`)].map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">same sources</li>'}</ul></div>` : ''
  return `${body}
    <section class="card"><h2>Compare two versions</h2><div class="row"><select id="diff-from">${diffOpts(S.diffFrom || vs[0]?.versionId)}</select> → <select id="diff-to">${diffOpts(S.diffTo || vs[vs.length - 1]?.versionId)}</select><button data-act="diff">Compare</button></div>${diffBody}</section>`
}

// ---------- 4. runs & evaluation
function viewRuns() {
  const runs = S.runs.map((r) => `<tr class="clickable ${S.run?.runId === r.runId ? 'sel' : ''}" data-run="${esc(r.runId)}"><td><code>${esc(r.runId)}</code></td><td>${chip(modeLabel(r.mode), r.mode === 'LIVE_MODEL' ? 'info' : 'warn')}</td><td>${chip(r.status, r.status === 'SUCCEEDED' ? 'ok' : 'bad')}</td><td><code>${short(r.configHash)}</code></td><td><code>${short(r.manifestHash)}</code></td><td>${esc(r.latencyMs)} ms</td><td class="small">${esc(r.startedBy)}<br/>${when(r.startedAt)}</td><td class="small bad-text">${esc(r.error?.message || '')}</td></tr>`).join('')
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
    ${S.events.map((e) => `<tr class="${e.result.startsWith('REJECTED') ? 'rejected' : ''}"><td>${e.seq}</td><td class="small">${when(e.at)}</td><td>${esc(e.actor)}</td><td><code>${esc(e.operation)}</code>${String(e.opId || '').startsWith('setup-') ? ' ' + chip('SCRIPTED SETUP', 'warn', 'Recorded by the demo setup script, not by a person') : ''}</td><td>${chip(e.result, e.result.startsWith('REJECTED') || e.result === 'STALE' || e.result === 'FAILED' ? 'bad' : '')}</td>
      <td class="small">${esc(e.subject || '')}${e.priorRef ? `<br/>from ${esc(e.priorRef)}` : ''}${e.newRef ? `<br/>to ${esc(e.newRef)}` : ''}</td><td class="small"><details><summary>show</summary><pre>${esc(JSON.stringify(e.details, null, 2))}</pre></details></td></tr>`).join('')}
    </tbody></table></section>`
}

// ---------- events
document.addEventListener('input', (ev) => {
  const id = ev.target.id
  if (id === 'rationale' || id === 'edit-note' || id === 'revoke-reason') S.drafts[draftKey(id)] = ev.target.value
})

document.addEventListener('change', async (ev) => {
  const t = ev.target
  try {
    if (t.id === 'who') { setToken(t.value); S.pending = { remove: new Set(), text: {} }; await refresh(); notify('info', `Now acting as ${S.me.name}`) }
    if (t.id === 'version') await selectVersion(t.value)
    if (t.id === 'impact-version') { S.impactVersion = t.value; S.impactExportResult = null; S.impact = await api('GET', `/api/versions/${t.value}/impact`); render() }
  } catch (e) {
    notify('bad', 'Could not load', errorBody(e))
  }
  if (t.id === 'diff-from') S.diffFrom = t.value
  if (t.id === 'diff-to') S.diffTo = t.value
})

function stageHash(stage) {
  return stage === 'start' ? 'guide' : `${stage},guide`
}

async function goToTab(tab) {
  S.tab = tab
  S.impactExportResult = null
  if (tab === 'impact') S.impact = null
  render()
  await refresh()
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('button, tr.clickable')
  if (!t) return
  const d = t.dataset
  if (d.tab) {
    if (!S.notice?.sticky) S.notice = null
    S.resetArm = null
    await goToTab(d.tab)
    return
  }
  // Two-step resets (no browser dialogs: they are blocked in hosted artifact pages).
  if (d.act === 'reset-demo') {
    if (S.resetArm !== 'reload') { S.resetArm = 'reload'; render(); return }
    location.reload()
    return
  }
  if (d.resetStage) {
    const key = `stage:${d.resetStage}`
    if (S.resetArm !== key) { S.resetArm = key; render(); return }
    location.hash = stageHash(d.resetStage)
    location.reload()
    return
  }
  if (d.act === 'guide-go') {
    const step = GUIDE[guideIndex()]
    if (!step) return
    await goToTab(pick(step.tab))
    document.querySelectorAll('.guide-target').forEach((x) => x.classList.remove('guide-target'))
    const el = document.querySelector(pick(step.target))
    if (el) { el.classList.add('guide-target'); el.scrollIntoView({ block: 'center' }) }
    return
  }
  if (d.act === 'dismiss') { S.notice = null; renderNotice(); return }
  if (d.source) { S.sourceView = d.source; render(); return }
  if (d.import) {
    S.exportDoc = null
    S.exportFor = null
    const r = await act('Import', () => api('POST', `/api/inbox/${d.import}/import`, { opId: newOpId() }))
    if (r) {
      S.impactExportResult = null
      const reviewed = r.markedStale.find((x) => x.previousState === 'REVIEWED_FOR_DEMO')
      if (reviewed) {
        // Land on the consequence: the impact view for the version that lost its acceptance.
        S.tab = 'impact'
        S.impactVersion = reviewed.versionId
        S.impact = null
        notify('ok', `${r.snapshotId} supersedes ${r.supersedes}. A version that was REVIEWED_FOR_DEMO is now STALE; its acceptance no longer applies. ${r.markedStale.length} version(s) built on ${r.supersedes} marked STALE.`)
        await refresh()
        // Bring the tab row, the notice and the verdict banner into view together.
        const tabs = $('.tabs')
        if (tabs) window.scrollTo(0, tabs.getBoundingClientRect().top + window.scrollY)
        return
      } else {
        notify('ok', `Imported ${r.snapshotId}${r.supersedes ? ` (supersedes ${r.supersedes})` : ''}. ${r.markedStale.length ? `${r.markedStale.length} candidate version(s) marked STALE.` : 'No candidate versions affected.'}`,
          r.markedStale.length ? ' <button class="link" data-tab="impact">Show what needs reassessment</button>' : '')
      }
    }
    await refresh()
    return
  }
  if (d.act === 'new-candidate') { S.candidateId = null; S.candidate = null; S.versionId = null; S.version = null; S.impactVersion = null; S.impactExportResult = null; render(); return }
  if (d.act === 'generate') {
    const r = await act('Generation run', () => api('POST', '/api/runs', { opId: newOpId(), candidateId: S.candidateId, objective: $('#objective').value, provider: $('#provider').value, expectedManifestHash: S.overview.manifest.hash }), {
      success: (x) => `Run ${x.runId} (${modeLabel(x.mode)}) produced v${x.versionNo}: ${x.state}, ${x.blocking} blocking finding(s).`
    })
    if (r) { S.candidateId = r.candidateId; S.versionId = r.versionId; S.impactVersion = null; S.tab = 'candidate'; S.evidence = null; S.exportDoc = null }
    await refresh()
    return
  }
  if (d.cite) {
    const [claimId, i] = d.cite.split('|')
    const l = S.version.checks.links[claimId]?.[Number(i)]
    if (!l) return
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
    await act('Judgments', () => api('POST', `/api/versions/${S.versionId}/judgments`, { opId: newOpId(), judgments: ids.map((claimId) => ({ claimId, support: 'SUPPORTS', note: 'bulk SUPPORTS via demo shortcut (citations mechanically resolved; passages not individually re-read in this click)' })) }), { success: () => `${ids.length} claims marked SUPPORTS via the demo shortcut (recorded as a shortcut).` })
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
    if (r) { clearDraft('edit-note'); S.pending = { remove: new Set(), text: {} }; S.evidence = null; S.versionId = r.versionId }
    await refresh()
    return
  }
  if (d.decide) {
    const v = S.version
    const rationale = $('#rationale').value
    const r = await act('Decision', () => api('POST', `/api/versions/${v.versionId}/decisions`, { opId: newOpId(), decision: d.decide, rationale, expectedDigest: v.digest, expectedManifestHash: v.manifestHash }), { success: (x) => `Recorded ${x.decision}; version is now ${x.state}.` })
    if (r) clearDraft('rationale')
    await refresh()
    return
  }
  if (d.revoke) { S.revoking = d.revoke; render(); $('#revoke-reason')?.focus(); return }
  if (d.act === 'cancel-revoke') { S.revoking = null; render(); return }
  if (d.act === 'confirm-revoke') {
    const reason = $('#revoke-reason').value
    const id = S.revoking
    const r = await act('Revocation', () => api('POST', `/api/decisions/${id}/revoke`, { opId: newOpId(), reason }), { success: () => 'Acceptance revoked; it stays in history.' })
    if (r) { clearDraft('revoke-reason'); S.revoking = null }
    await refresh()
    return
  }
  if (d.export) {
    S.exportDoc = null
    S.exportFor = null
    const r = await act('Export', () => api('POST', `/api/versions/${S.versionId}/export`, { opId: newOpId(), mode: d.export }))
    if (r) { S.exportDoc = r; S.exportFor = { versionId: S.versionId, manifestHash: S.version.currentManifestHash } }
    render()
    return
  }
  if (d.act === 'impact-export') {
    // Inline refusal on the impact tab; deliberately not act(), so the
    // result stays next to the button instead of in the global notice.
    if (S.busy) return
    S.busy = true
    S.impactExportResult = null
    document.body.classList.add('busy')
    try {
      const r = await api('POST', `/api/versions/${S.impactVersion || S.versionId}/export`, { opId: newOpId(), mode: 'reviewed' })
      S.impactExportResult = { ok: true, html: esc(r.banner) }
    } catch (e) {
      if (e instanceof ApiError) { S.lastErrorCode = e.code; S.seenErrors.add(e.code); noteExportRefusal(e.code) }
      // The export refusal names the lapsed decisions, not the manifest delta;
      // lead with the source change from the impact data being shown.
      const im = S.impact
      const delta = e instanceof ApiError && e.code === 'EXPORT_BLOCKED' && im
        ? [...im.sources.changed.map((c) => `${c.from} -> ${c.to}`), ...im.sources.added.map((x) => `added ${x.to}`), ...im.sources.removed.map((x) => `removed ${x.from}`)]
        : []
      // Inserted right after the status line so it is the first thing read.
      const body = errorBody(e)
      const cut = body.indexOf('</div>') + '</div>'.length
      S.impactExportResult = { ok: false, html: `${body.slice(0, cut)}${delta.map((x) => `<div><strong>Source change: ${esc(x)}</strong></div>`).join('')}${body.slice(cut)}` }
    } finally {
      S.busy = false
      document.body.classList.remove('busy')
    }
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
  const flags = parseHashFlags()
  const startTab = window.__WB_START_TAB__ || (flags.includes('changed') ? 'impact' : null)
  if (startTab) S.tab = startTab
  return refresh().catch((e) => {
  document.querySelector('#app').innerHTML = `<div class="card"><h2>Cannot reach the workbench API</h2><p>${esc(e.message)}</p><p>Start it with <code>npm start</code> (built UI) or <code>npm run server</code> + <code>npm run dev</code>.</p></div>`
})
}
