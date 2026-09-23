import './style.css'
import { CASES, REQUIREMENTS, EVIDENCE, REVIEWER, JUDGE_FIXTURES } from './cases.js'
import { runChecks, allowedDecisions } from './checks.js'
import { buildRequest, createFixtureJudge, CHOICES, PINNED_MODEL } from './judge.js'
import { createRecord, recordStatus, latestForCase } from './audit.js'
import { renderPlan, renderNotes } from './content.js'
import { esc, highlight } from './html.js'

const STORAGE_KEY = 'evidence-link-bench:v1'
// Public builds (VITE_PUBLIC=1) omit the personal interview notes.
const PUBLIC_BUILD = import.meta.env.VITE_PUBLIC === '1'
const TABS = [
  ['bench', 'Review bench'],
  ['plan', 'Evaluation plan'],
  ...(PUBLIC_BUILD ? [] : [['notes', 'Interview notes']]),
]
const DECISIONS = {
  verifies: { label: 'Accept “verifies” link', short: 'Accepted · verifies', tone: 'pass' },
  related: { label: 'Record as related, not verifying', short: 'Related · not verifying', tone: 'warn' },
  reject: { label: 'Reject candidate', short: 'Rejected', tone: 'fail' },
  route: { label: 'Route to a cleared reviewer', short: 'Routed', tone: 'muted' },
}
const CHOICE_LABELS = {
  supports: 'Supports',
  ambiguous: 'Ambiguous',
  insufficient_evidence: 'Insufficient evidence',
  contradicts: 'Contradicts',
}
const MIN_RATIONALE = 12

const judge = createFixtureJudge(JUDGE_FIXTURES)
const app = document.querySelector('#app')

const state = {
  tab: 'bench',
  caseId: CASES[0].id,
  requirementRevs: Object.fromEntries(Object.values(REQUIREMENTS).map((r) => [r.id, r.baselineRevision])),
  log: [],
  openedAt: Date.now(),
  toast: '',
}

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')
    if (saved?.log) state.log = saved.log
    if (saved?.requirementRevs) Object.assign(state.requirementRevs, saved.requirementRevs)
  } catch {
    // Storage unavailable; the demo runs without persistence.
  }
  const hash = location.hash.slice(1)
  if (TABS.some(([id]) => id === hash)) state.tab = hash
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ log: state.log, requirementRevs: state.requirementRevs }))
  } catch {
    // Ignore; persistence is a convenience.
  }
}

function currentRevisions() {
  return {
    requirements: state.requirementRevs,
    evidence: Object.fromEntries(Object.values(EVIDENCE).map((e) => [e.id, e.rev])),
  }
}

function evaluate(c) {
  const requirement = REQUIREMENTS[c.requirementId]
  const evidence = EVIDENCE[c.evidenceId]
  const requirementRevision = state.requirementRevs[requirement.id]
  const checks = runChecks({ requirement, requirementRevision, evidence, reviewer: REVIEWER })
  const accessOk = checks[0].status === 'pass'
  const request = accessOk ? buildRequest(requirement.revisions[requirementRevision].text, evidence.narrative) : null
  const judgment = request ? judge.judge(`${c.id}@${requirementRevision}`, request) : null
  return { requirement, evidence, requirementRevision, checks, accessOk, request, judgment, allowed: allowedDecisions(checks) }
}

// ---------- rendering ----------

function render() {
  const focusId = document.activeElement?.id
  const rationale = document.querySelector('#rationale')?.value ?? ''
  app.innerHTML = `
    <header class="masthead">
      <div class="masthead-inner">
        <p class="eyebrow">Requirement ↔ test evidence · assisted linking</p>
        <h1>Evidence Link Bench</h1>
        <p class="lede">A working demonstrator of one division of responsibility. Integration code retrieves authoritative records, Jev judges meaning, code checks exact facts, and an engineer approves. All records are synthetic, and the Jev outputs are illustrative fixtures because no model is called.</p>
        <ol class="legend" aria-label="Who decides">
          <li><span class="lane-dot src"></span>Integration code retrieves</li>
          <li><span class="lane-dot model"></span>Jev judges meaning</li>
          <li><span class="lane-dot code"></span>Code checks exact facts</li>
          <li><span class="lane-dot eng"></span>Engineer approves</li>
        </ol>
      </div>
      <nav class="tabs" role="tablist">
        ${TABS.map(([id, label]) => `<button role="tab" id="tab-${id}" class="tab" aria-selected="${state.tab === id}" data-action="tab" data-tab="${id}">${label}</button>`).join('')}
      </nav>
    </header>
    <main class="page">
      ${state.tab === 'bench' ? renderBench() : state.tab === 'plan' ? renderPlan() : PUBLIC_BUILD ? renderBench() : renderNotes()}
    </main>
    <div class="toast" role="status" aria-live="polite" ${state.toast ? '' : 'hidden'}>${esc(state.toast)}</div>
  `
  const box = document.querySelector('#rationale')
  if (box) box.value = rationale
  updateDecisionButtons()
  if (focusId) document.getElementById(focusId)?.focus()
}

function statusChip(c) {
  const record = latestForCase(state.log, c.id)
  if (!record) return `<span class="pill pill-muted">Unreviewed</span>`
  if (recordStatus(record, currentRevisions()) === 'stale') return `<span class="pill pill-warn">Stale · re-review</span>`
  const d = DECISIONS[record.decision]
  return `<span class="pill pill-${d.tone}">${esc(d.short)}</span>`
}

function renderBench() {
  const c = CASES.find((x) => x.id === state.caseId)
  const ev = evaluate(c)
  return `
    <section class="bench">
      <aside class="case-list" aria-label="Synthetic cases">
        <h2 class="section-label">Candidate links</h2>
        ${CASES.map((x) => `
          <button class="case-item" aria-current="${x.id === c.id}" data-action="select" data-case="${x.id}" id="case-${x.id}">
            <span class="case-title">${esc(x.label)}</span>
            <span class="case-ids">${esc(x.requirementId)} ↔ ${esc(x.evidenceId)}</span>
            ${statusChip(x)}
          </button>`).join('')}
      </aside>
      <div class="case-detail">
        <div class="case-head">
          <h2>${esc(c.label)}</h2>
          <p>${esc(c.lesson)}</p>
        </div>
        ${renderSources(c, ev)}
        ${renderJudgment(c, ev)}
        ${renderChecks(ev)}
        ${renderDecision(c, ev)}
      </div>
    </section>
    ${renderControls()}
    ${renderLog()}
  `
}

function stage(n, lane, title, who, body) {
  return `
    <section class="stage stage-${lane}">
      <header class="stage-head">
        <span class="stage-num">${n}</span>
        <h3>${title}</h3>
        <span class="stage-who"><span class="lane-dot ${lane}"></span>${who}</span>
      </header>
      <div class="stage-body">${body}</div>
    </section>`
}

function renderSources(c, ev) {
  const { requirement, evidence, requirementRevision, judgment, accessOk } = ev
  const cites = judgment?.status === 'ok' ? judgment.cites : { requirement: [], evidence: [] }
  const reqText = requirement.revisions[requirementRevision].text
  const evBody = accessOk
    ? `<p class="passage">${highlight(evidence.narrative, cites.evidence)}</p>
       <p class="meta">Structured measurements: ${evidence.measurements.length ? evidence.measurements.map((m) => `<code>${esc(m.metric)} = ${esc(m.value)} ${esc(m.unit)}</code>`).join(' ') : '<em>none exported</em>'}</p>`
    : `<p class="passage withheld">Withheld. The reviewer lacks ${esc(evidence.marking)} access, so the integration layer did not return this text.</p>`
  return stage(1, 'src', 'Retrieve authoritative records', 'Integration code', `
    <div class="records">
      <article class="record">
        <p class="record-id"><code>${esc(requirement.id)}</code> rev <strong>${esc(requirementRevision)}</strong> <span class="marking">${esc(requirement.marking)}</span></p>
        <p class="record-src">${esc(requirement.system)} · ${esc(requirement.element)}</p>
        <p class="passage">${highlight(reqText, cites.requirement)}</p>
      </article>
      <article class="record">
        <p class="record-id"><code>${esc(evidence.id)}</code> rev <strong>${esc(evidence.rev)}</strong> <span class="marking">${esc(evidence.marking)}</span></p>
        <p class="record-src">${esc(evidence.system)} · ${esc(evidence.title)} · tested against ${esc(evidence.testedAgainst.id)} rev ${esc(evidence.testedAgainst.rev)} · ${esc(evidence.status)}</p>
        ${evBody}
      </article>
    </div>
    <p class="meta">Candidate relationship: <code>«verify»</code> ${esc(evidence.id)} → ${esc(requirement.id)}. Highlighted text shows the passages the judgment cited.</p>`)
}

function renderJudgment(c, ev) {
  const { judgment, request } = ev
  let body
  if (!judgment) {
    body = `<p class="empty">Not called. Access enforcement happens before any text reaches a model.</p>`
  } else if (judgment.status !== 'ok') {
    body = `<p class="empty">${esc(judgment.reason)}</p>`
  } else {
    body = `
      <p class="question">${esc(request.question)}</p>
      <div class="bars" role="list">
        ${CHOICES.map((choice) => {
          const p = judgment.probabilities[choice] ?? 0
          const top = choice === judgment.choice
          return `<div class="bar-row${top ? ' top' : ''}" role="listitem">
            <span class="bar-label">${CHOICE_LABELS[choice]}</span>
            <span class="bar-track"><span class="bar-fill" style="width:${(p * 100).toFixed(0)}%"></span></span>
            <span class="bar-val">${p.toFixed(2)}</span>
          </div>`
        }).join('')}
      </div>
      <p class="meta">Illustrative fixture, not a recorded Jev response. Pinned version <code>${esc(judgment.model)}</code> is recorded with every decision. A probability alone is weak evidence of a relationship; review the cited passages.</p>`
  }
  const payload = request
    ? `<details class="payload"><summary>Exactly what would be sent to the model</summary><pre>${esc(JSON.stringify(request, null, 2))}</pre></details>`
    : ''
  return stage(2, 'model', 'Judge meaning', `Jev · ${PINNED_MODEL} (simulated)`, body + payload)
}

function renderChecks(ev) {
  return stage(3, 'code', 'Check exact facts', 'Deterministic code', `
    <ul class="checks">
      ${ev.checks.map((ch) => `
        <li class="check check-${ch.status}">
          <span class="check-mark" aria-hidden="true">${ch.status === 'pass' ? '✓' : ch.status === 'missing' ? '–' : '✕'}</span>
          <span class="check-label">${esc(ch.label)}<span class="sr-only"> ${ch.status}</span></span>
          <span class="check-detail">${esc(ch.detail)}</span>
        </li>`).join('')}
    </ul>
    <p class="meta">${ev.allowed.verifies ? 'All checks pass, so a “verifies” link may be accepted.' : 'A failing or missing check blocks a “verifies” link, whatever the model output says.'}</p>`)
}

function renderDecision(c, ev) {
  const record = latestForCase(state.log, c.id)
  let prior = ''
  if (record) {
    const status = recordStatus(record, currentRevisions())
    const d = DECISIONS[record.decision]
    prior = `<div class="prior ${status}">
      <span class="pill pill-${status === 'stale' ? 'warn' : d.tone}">${status === 'stale' ? 'Stale' : 'Current'}</span>
      Last decision: <strong>${esc(d.short)}</strong> against ${esc(record.requirement.id)} rev ${esc(record.requirement.rev)} · ${esc(record.evidence.id)} rev ${esc(record.evidence.rev)} · <code>${esc(record.fingerprint)}</code>
      ${status === 'stale' ? '<br>A source revision changed after this decision, so it no longer counts. Re-review required.' : ''}
    </div>`
  }
  const buttons = Object.entries(DECISIONS)
    .filter(([key]) => (ev.allowed.route ? key === 'route' : key !== 'route'))
    .map(([key, d]) => `<button class="btn btn-${d.tone}" data-action="decide" data-decision="${key}" data-allowed="${ev.allowed[key]}" id="decide-${key}">${esc(d.label)}</button>`)
    .join('')
  return stage(4, 'eng', 'Approve or reject', `${REVIEWER.name}`, `
    ${prior}
    <label class="field" for="rationale">Rationale <span class="muted">(required, cite the passages you relied on)</span></label>
    <textarea id="rationale" rows="3" placeholder="e.g. TR-2291 rev 2 unplugs TS-1 and records SENSOR FAULT at 1.4 s; meets rev C."></textarea>
    <div class="actions">${buttons}</div>
    <p class="meta" id="decision-hint"></p>
    <p class="meta">Accepted links would be written back through a controlled, audited integration. Here they go to the audit log below.</p>`)
}

function renderControls() {
  const req = REQUIREMENTS['REQ-TS-014']
  const rev = state.requirementRevs[req.id]
  const changed = rev !== req.baselineRevision
  return `
    <section class="controls">
      <div>
        <h2 class="section-label">Source change control</h2>
        <p><code>${esc(req.id)}</code> is at rev <strong>${esc(rev)}</strong>. ${changed ? 'Every approval made against rev C is now stale.' : 'Simulate an upstream edit in the Cameo model to see approvals go stale.'}</p>
      </div>
      <div class="actions">
        ${changed ? '' : `<button class="btn" data-action="bump" id="bump-rev">Change ${esc(req.id)} to rev D</button>`}
        <button class="btn btn-ghost" data-action="reset" id="reset-demo">Reset demo</button>
      </div>
    </section>`
}

function renderLog() {
  const revs = currentRevisions()
  const rows = [...state.log].reverse()
  return `
    <section class="log">
      <div class="log-head">
        <h2 class="section-label">Audit log</h2>
        ${rows.length ? '<button class="btn btn-ghost" data-action="copy" id="copy-log">Copy log as JSON</button>' : ''}
      </div>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Decision</th><th>Link</th><th>Model</th><th>Checks</th><th class="num">Review time</th><th>Fingerprint</th><th>Status</th></tr></thead>
        <tbody>${rows.map((r) => {
          const status = recordStatus(r, revs)
          const failed = r.checks.filter((c) => c.status !== 'pass').length
          return `<tr>
            <td class="nowrap">${esc(new Date(r.at).toLocaleTimeString())}</td>
            <td>${esc(DECISIONS[r.decision].short)}</td>
            <td class="nowrap"><code>${esc(r.evidence.id)}@${esc(r.evidence.rev)}</code> → <code>${esc(r.requirement.id)}@${esc(r.requirement.rev)}</code></td>
            <td>${r.model ? `<code>${esc(r.model.version)}</code> ${esc(r.model.choice)}` : '<span class="muted">not called</span>'}</td>
            <td>${failed ? `${failed} not passing` : 'all pass'}</td>
            <td class="num">${(r.reviewMs / 1000).toFixed(1)} s</td>
            <td><code>${esc(r.fingerprint)}</code></td>
            <td><span class="pill pill-${status === 'stale' ? 'warn' : 'pass'}">${status}</span></td>
          </tr>`
        }).join('')}</tbody>
      </table></div>
      <p class="meta">Review time runs from opening a case to recording a decision in this browser. The pilot’s main metric would be measured the same way.</p>`
      : '<p class="empty">No decisions yet. Record one above and it appears here, bound to the exact source revisions.</p>'}
    </section>`
}

function updateDecisionButtons() {
  const text = document.querySelector('#rationale')?.value.trim() ?? ''
  const enough = text.length >= MIN_RATIONALE
  let blockedVerify = false
  document.querySelectorAll('[data-action="decide"]').forEach((btn) => {
    const allowed = btn.dataset.allowed === 'true'
    if (btn.dataset.decision === 'verifies' && !allowed) blockedVerify = true
    btn.disabled = !allowed || !enough
  })
  const hint = document.querySelector('#decision-hint')
  if (hint) {
    hint.textContent = [
      enough ? '' : `Write a rationale of at least ${MIN_RATIONALE} characters to enable decisions.`,
      blockedVerify ? '“Verifies” is blocked by the exact checks.' : '',
    ].filter(Boolean).join(' ')
  }
}

// ---------- actions ----------

function flash(message) {
  state.toast = message
  render()
  clearTimeout(flash.timer)
  flash.timer = setTimeout(() => {
    state.toast = ''
    const el = document.querySelector('.toast')
    if (el) el.hidden = true
  }, 2600)
}

function decide(decision) {
  const c = CASES.find((x) => x.id === state.caseId)
  const ev = evaluate(c)
  const rationale = document.querySelector('#rationale')?.value.trim() ?? ''
  if (!ev.allowed[decision] || rationale.length < MIN_RATIONALE) return
  const now = Date.now()
  state.log.push(createRecord({
    caseId: c.id,
    decision,
    requirement: ev.requirement,
    requirementRevision: ev.requirementRevision,
    evidence: ev.evidence,
    judgment: ev.judgment,
    checks: ev.checks,
    rationale,
    reviewer: REVIEWER,
    reviewMs: now - state.openedAt,
    at: new Date(now).toISOString(),
  }))
  save()
  document.querySelector('#rationale').value = ''
  state.openedAt = Date.now()
  flash(`Recorded: ${DECISIONS[decision].short}`)
}

app.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]')
  if (!el) return
  switch (el.dataset.action) {
    case 'tab':
      state.tab = el.dataset.tab
      try { history.replaceState(null, '', `#${state.tab}`) } catch { /* sandboxed */ }
      render()
      break
    case 'select':
      if (el.dataset.case !== state.caseId) {
        state.caseId = el.dataset.case
        state.openedAt = Date.now()
        const box = document.querySelector('#rationale')
        if (box) box.value = ''
        render()
      }
      break
    case 'decide':
      decide(el.dataset.decision)
      break
    case 'bump':
      state.requirementRevs['REQ-TS-014'] = 'D'
      save()
      flash('REQ-TS-014 is now rev D. Earlier approvals are stale.')
      break
    case 'reset':
      state.log = []
      state.requirementRevs['REQ-TS-014'] = REQUIREMENTS['REQ-TS-014'].baselineRevision
      state.openedAt = Date.now()
      save()
      flash('Demo reset')
      break
    case 'copy': {
      const json = JSON.stringify(state.log, null, 2)
      try {
        await navigator.clipboard.writeText(json)
        flash('Audit log copied')
      } catch {
        flash('Copy was blocked. The log is shown below for manual copying.')
        const pre = document.createElement('pre')
        pre.className = 'fallback-copy'
        pre.textContent = json
        document.querySelector('.log')?.append(pre)
      }
      break
    }
  }
})

app.addEventListener('input', (e) => {
  if (e.target.id === 'rationale') updateDecisionButtons()
})

load()
render()
