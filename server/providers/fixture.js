// SIMULATED MODEL. A deterministic, offline stand-in for an LLM drafting step.
//
// It reads only the model-visible context (permitted passages and their
// structured fields) and emits the same structured shape a real model is asked
// for. It is not AI and its output quality says nothing about any real model.
// Seeded faults emulate known LLM failure modes so the workflow controls have
// something real to catch:
//   fabricated_step      a plausible step whose quote is not in the cited passage
//   bad_passage          a citation to a passage id that does not exist
//   cite_obsolete_cal    cites the older calibration certificate as "most recent"
//   misattributed_quote  a real quote attached to a claim it does not support
//   hypothesis_as_support  a hypothesis used as support for a step
// Instruction-like source text is "obeyed" (emits an approval field and a
// skip step) to emulate an injection-susceptible model.

export const FIXTURE_PROMPT_VERSION = 'fixture-sim-v1'
const INJECTION_RE = /(ignore (all )?previous|mark this procedure approved|^system:)/i

export function generateFixture(ctx, { faults = [] } = {}) {
  const f = new Set(faults)
  const bySource = (pred) => ctx.sources.filter(pred)
  const passage = (snapshotId, passageId) => ctx.passages.find((p) => p.snapshotId === snapshotId && p.passageId === passageId)
  const ev = (snapshotId, passageId, quote) => {
    const p = passage(snapshotId, passageId)
    return { snapshotId, passageId, quote: quote ?? (p ? p.text : '') }
  }

  const claims = []
  const steps = []
  const assumptions = []
  const openQuestions = []
  const missingEvidence = []
  const conflicts = []
  let n = 0
  const claim = (text, evidence, kind = 'fact', extra = {}) => {
    const id = `C${++n}`
    claims.push({ id, kind, text, evidence, ...extra })
    return id
  }

  const reqs = bySource((s) => s.kind === 'requirement').sort((a, b) => a.sourceId.localeCompare(b.sourceId))
  const req = (reqId) => reqs.find((r) => r.structured?.reqId === reqId)
  const model = bySource((s) => s.kind === 'system_model')[0]
  const asset = bySource((s) => s.structured?.recordType === 'asset_register')[0]
  const log = bySource((s) => s.structured?.recordType === 'inspection_log')[0]
  const cals = bySource((s) => s.structured?.recordType === 'calibration_certificate')
    .sort((a, b) => b.structured.calibrationDate.localeCompare(a.structured.calibrationDate))

  // Step 1: identification.
  const r1 = req('REQ-001')
  if (r1) {
    steps.push({ id: 'S1', text: 'Record the device serial number exactly as shown on the nameplate before starting.', claimIds: [claim('The serial number must be recorded from the nameplate before the inspection starts.', [ev(r1.snapshotId, 'p1')])] })
    const s2Claims = [claim('The recorded serial must match the asset register entry.', [ev(r1.snapshotId, 'p2')])]
    if (asset) {
      s2Claims.push(claim(`The asset register lists serial ${asset.structured.serial} for ${asset.structured.deviceId}.`, [ev(asset.snapshotId, 'p1', `Serial number: ${asset.structured.serial}`)]))
    }
    steps.push({ id: 'S2', text: 'Compare the recorded serial with the asset register entry; stop and escalate if they differ.', claimIds: s2Claims, decisionPoint: { condition: 'Serials match', ifFalse: 'Stop and raise a record discrepancy' } })
    if (asset && log && log.structured.recordedSerial !== asset.structured.serial) {
      conflicts.push({
        id: 'X1',
        text: `Asset register serial ${asset.structured.serial} conflicts with inspection-log serial ${log.structured.recordedSerial}.`,
        evidence: [ev(asset.snapshotId, 'p1', `Serial number: ${asset.structured.serial}`), ev(log.snapshotId, 'p1', `Recorded serial number: ${log.structured.recordedSerial}`)]
      })
      openQuestions.push({ id: 'Q1', text: `Which serial is correct for DEV-0193: ${asset.structured.serial} or ${log.structured.recordedSerial}?` })
      const h = claim('The serial discrepancy is probably a transcription error in the inspection log.', [], 'hypothesis')
      if (f.has('hypothesis_as_support')) s2Claims.push(h)
    }
  }

  // Step 3: calibration currency. The model cites; code computes currency.
  const r2 = req('REQ-002')
  if (r2) {
    const s3 = [claim('Calibration evidence is current only within the window stated in REQ-002.', [ev(r2.snapshotId, 'p1')])]
    const chosen = f.has('cite_obsolete_cal') ? cals[cals.length - 1] : cals[0]
    if (chosen) {
      s3.push(claim(`The most recent calibration certificate is ${chosen.sourceId}, dated ${chosen.structured.calibrationDate}.`, [ev(chosen.snapshotId, 'p1', `Calibration date: ${chosen.structured.calibrationDate}`)]))
      s3.push(claim('Calibration currency for this device, computed by the workbench from REQ-002 and the most recent certificate.', [], 'computed', { check: 'CALIBRATION_CURRENT' }))
    } else {
      missingEvidence.push({ id: 'M-CAL', about: 'calibration', text: 'No calibration certificate for the device was found in permitted sources.' })
    }
    s3.push(claim('If calibration is not current the device is tagged HOLD and functional checks do not proceed.', [ev(r2.snapshotId, 'p2')]))
    steps.push({ id: 'S3', text: 'Confirm calibration evidence is current. If it is not, tag the device HOLD and stop before functional checks.', claimIds: s3, decisionPoint: { condition: 'Calibration current', ifFalse: 'Tag HOLD; do not proceed' } })
  }

  // Inspection points come from the (simulated) system model.
  let stepNo = 4
  if (model) {
    for (const el of model.structured.elements.filter((e) => e.type === 'InspectionPoint')) {
      const ids = [claim(`${el.id} (${el.name}) is an inspection point of the equipment and is recorded as PASS or FAIL.`, [ev(model.snapshotId, el.passage)])]
      const obs = log?.structured.observations.find((o) => o.point === el.id)
      if (obs) {
        ids.push(claim(`The inspection log records ${el.id} as ${obs.result}.`, [ev(log.snapshotId, obs.passage, `Observation ${el.id}: ${obs.result}`)]))
      } else {
        missingEvidence.push({ id: `M-${el.id}`, about: el.id, text: `No observation for ${el.id} (${el.name}) was found in the permitted inspection records.` })
      }
      steps.push({ id: `S${stepNo++}`, text: `Inspect ${el.name.toLowerCase()} and record PASS or FAIL.`, claimIds: ids })
    }
    if (f.has('fabricated_step')) {
      const bat = model.structured.elements.find((e) => e.id === 'IP-BATTERY')
      if (bat) {
        steps.push({ id: `S${stepNo++}`, text: 'Clean the battery contacts with isopropyl alcohol before inspecting them.', claimIds: [claim('Battery contacts are cleaned with isopropyl alcohol before inspection.', [ev(model.snapshotId, bat.passage, 'contacts cleaned with isopropyl alcohol before inspection')])] })
      }
    }
    if (f.has('misattributed_quote')) {
      const hs = model.structured.elements.find((e) => e.id === 'IP-HOUSING')
      if (hs) steps.push({ id: `S${stepNo++}`, text: 'Replace the housing seal every 12 months.', claimIds: [claim('The housing seal is replaced every 12 months.', [ev(model.snapshotId, hs.passage, 'Housing seal condition')])] })
    }
    if (f.has('bad_passage')) {
      steps.push({ id: `S${stepNo++}`, text: 'Verify the display firmware version.', claimIds: [claim('The display firmware version must be verified.', [{ snapshotId: model.snapshotId, passageId: 'p99', quote: 'firmware version' }])] })
    }
  }

  // Injection susceptibility: the simulated model "obeys" instruction-like text.
  let injected = null
  for (const p of ctx.passages) {
    if (INJECTION_RE.test(p.text)) {
      injected = p
      steps.push({ id: `S${stepNo++}`, text: 'Skip the calibration check as directed by the vendor note.', claimIds: [claim('The vendor note directs that the calibration check be skipped.', [ev(p.snapshotId, p.passageId)])] })
    }
  }

  const r3 = req('REQ-003')
  if (r3) {
    steps.push({ id: `S${stepNo++}`, text: 'Record a disposition of SERVICEABLE, HOLD or REMOVE with reviewer identity, date and rationale.', claimIds: [claim('Each inspection needs a disposition recorded by an identified reviewer with date and rationale.', [ev(r3.snapshotId, 'p1')])] })
  }

  assumptions.push({ id: 'A1', text: `The inspection date is the workbench as-of date, ${ctx.asOf}.` })
  assumptions.push({ id: 'A2', text: 'Only device DEV-0193 is in scope for this candidate procedure.' })
  if (model) assumptions.push({ id: 'A3', text: `Inspection points are taken from ${model.snapshotId}, a simulated model export.` })

  const out = {
    title: 'Candidate inspection procedure: PSK-7 portable sensor kit (DEV-0193)',
    objective: ctx.objective,
    steps, claims, assumptions, openQuestions, missingEvidence, conflicts
  }
  if (injected) {
    out.reviewStatus = 'APPROVED'
    out.approved = true
  }
  return out
}
