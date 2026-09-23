// Deterministic template baseline: one step per requirement passage and per
// modeled inspection point, each citing its own source. No synthesis across
// records, no gap or conflict disclosure. This is what "no AI" looks like for
// the comparison in the evaluation report.
export const BASELINE_PROMPT_VERSION = 'baseline-template-v1'

export function generateBaseline(ctx) {
  const steps = []
  const claims = []
  let n = 0
  let s = 0
  const add = (text, evidence) => {
    const id = `C${++n}`
    claims.push({ id, kind: 'fact', text, evidence })
    steps.push({ id: `S${++s}`, text, claimIds: [id] })
  }
  for (const p of ctx.passages.filter((x) => x.kind === 'requirement').sort((a, b) => a.snapshotId.localeCompare(b.snapshotId) || a.passageId.localeCompare(b.passageId))) {
    add(`Comply with ${p.sourceId} ${p.passageId}: ${p.text}`, [{ snapshotId: p.snapshotId, passageId: p.passageId, quote: p.text }])
  }
  const model = ctx.sources.find((x) => x.kind === 'system_model')
  if (model) {
    for (const el of model.structured.elements.filter((e) => e.type === 'InspectionPoint')) {
      const p = ctx.passages.find((x) => x.snapshotId === model.snapshotId && x.passageId === el.passage)
      add(`Inspect ${el.name.toLowerCase()} (${el.id}).`, [{ snapshotId: model.snapshotId, passageId: el.passage, quote: p?.text ?? '' }])
    }
  }
  return {
    title: 'Template procedure: PSK-7 portable sensor kit',
    objective: ctx.objective,
    steps, claims, assumptions: [], openQuestions: [], missingEvidence: [], conflicts: []
  }
}
