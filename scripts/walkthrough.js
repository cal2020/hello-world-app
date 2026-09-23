// Prints the complete five-minute demo path against a fresh in-memory
// workbench. This is the scripted fallback if the browser demo fails; it is
// a real execution, but it is not the live UI.
import { createWorkbench } from '../server/workbench.js'
import { seedSources, generate, importInbox, removeUnresolved, judgeAll, accept, op } from './demo-steps.js'

const wb = createWorkbench()
const author = wb.userForToken('demo-author-kim')
const reviewer = wb.userForToken('demo-reviewer-alvarez')
const h = (s) => console.log(`\n=== ${s}`)
const findings = (v) => v.checks.findings.filter((f) => f.severity !== 'INFO').map((f) => `  ${f.severity.padEnd(8)} ${f.code} (${f.target}) ${f.message}`).join('\n')
const tryIt = (label, fn) => { try { fn(); console.log(`  ${label}: allowed`) } catch (e) { console.log(`  ${label}: ${e.code} - ${e.message}`); for (const r of e.details?.reasons ?? []) console.log(`    - ${r.code}: ${r.message}`); for (const d of e.details?.decisions ?? []) for (const r of d.reasons) console.log(`    - ${r}`) } }

h('1. Load synthetic sources (stable ids, revisions, hashes)')
seedSources(wb, author)
for (const s of wb.activeSources()) console.log(`  ${s.snapshotId.padEnd(18)} ${s.kind.padEnd(13)} ${s.contentHash.slice(7, 19)}  ${s.title}`)

h('2. Generate a candidate (SIMULATED model: deterministic fixture with one seeded error)')
const r1 = await generate(wb, author)
let v = wb.getVersion(r1.versionId)
console.log(`  v${v.versionNo} ${v.state}; ${v.content.steps.length} steps, ${v.content.claims.length} claims`)
console.log(findings(v))
tryIt('Accept v1', () => accept(wb, reviewer, v))

h('3. Import the corrected inspection log: v1 becomes STALE; regenerate')
console.log('  ', importInbox(wb, author, 'insp-log-rev2').markedStale)
const r2 = await generate(wb, author, r1.candidateId)
v = wb.getVersion(r2.versionId)
console.log(`  v${v.versionNo} ${v.state}`)
console.log(findings(v))

h('4. Reviewer rejects the unsupported step, edits (new version), judges claims, accepts')
v = removeUnresolved(wb, reviewer, v.versionId)
console.log(`  edit -> v${v.versionNo} ${v.state} (parent ${v.parentVersionId})`)
tryIt('Author tries to accept', () => wb.decide(author, v.versionId, { opId: op('x'), decision: 'ACCEPT_FOR_DEMO', rationale: 'x', expectedDigest: v.digest, expectedManifestHash: v.manifestHash }))
v = judgeAll(wb, reviewer, v.versionId)
const d = accept(wb, reviewer, v)
console.log(`  Accepted: ${d.decisionId} -> ${d.state}, bound to digest ${d.candidateDigest.slice(7, 19)} + manifest ${d.manifestHash.slice(7, 19)}`)
console.log(`  Export: ${wb.exportVersion(author, v.versionId, { opId: op('exp'), mode: 'reviewed' }).body.banner}`)

h('5. Change REQ-002 (calibration window 180 -> 90 days)')
console.log('  ', importInbox(wb, author, 'req-002-revB').markedStale)
const im = wb.impact(v.versionId)
for (const c of im.sources.changed) for (const s of c.structured) console.log(`  ${c.from} -> ${c.to}: ${s.field} ${s.before} -> ${s.after}`)
for (const c of im.affectedClaims) console.log(`  ${c.severity.padEnd(9)} ${c.claimId}: ${c.reasons.join('; ')}`)
console.log(`  Unaffected claims: ${im.unaffectedClaims.join(', ')}`)
for (const c of im.computedChanges) console.log(`  Computed: ${c.before.result} -> ${c.after.result}: ${c.after.text}`)
for (const x of im.decisions) console.log(`  Decision ${x.decisionId} applies: ${x.status.valid}; ${x.status.reasons.map((r) => r.message).join(' ')}`)
tryIt('Export as reviewed', () => wb.exportVersion(author, v.versionId, { opId: op('exp'), mode: 'reviewed' }))

h('6. Regenerate under REQ-002 rev B: judgments carry forward only for unchanged claims')
const r3 = await generate(wb, author, r1.candidateId)
const v3 = wb.getVersion(r3.versionId)
const needs = v3.content.claims.filter((c) => c.kind === 'fact' && !v3.judgments[c.id].current)
console.log(`  v${v3.versionNo} ${v3.state}; claims needing a new judgment: ${needs.map((c) => `${c.id} (${c.evidence.map((e) => e.snapshotId).join(',')})`).join(', ')}`)
console.log(`  Calibration now: ${Object.values(v3.checks.computed)[0].text}`)

h('7. Audit')
console.log(`  ${wb.events().length} events, chain ${wb.verifyAudit().ok ? 'verified' : 'BROKEN'}`)
