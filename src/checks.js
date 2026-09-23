// Deterministic checks. These decide exact facts (revisions, units, limits,
// access, release status) so the semantic model never has to.

const MS_PER_UNIT = {
  ms: 1,
  millisecond: 1,
  milliseconds: 1,
  s: 1000,
  sec: 1000,
  second: 1000,
  seconds: 1000,
  min: 60000,
  minute: 60000,
  minutes: 60000,
}

const COMPARATORS = {
  '<=': (a, b) => a <= b,
  '<': (a, b) => a < b,
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
}

const INSTRUCTION_PATTERN =
  /\b(ignore (all |any )?(the |previous |prior )?(instructions|requirement)|classify (this|the) (report|record|evidence)|note to (automated|ai) reviewers?|you are an? (ai|assistant|model)|system prompt)\b/i

export function toMilliseconds(quantity) {
  const factor = MS_PER_UNIT[String(quantity?.unit ?? '').toLowerCase()]
  if (factor === undefined || typeof quantity.value !== 'number' || !Number.isFinite(quantity.value)) return null
  return quantity.value * factor
}

export function formatSeconds(ms) {
  return `${Number((ms / 1000).toFixed(3))} s`
}

export function hasAccess(reviewer, marking) {
  return reviewer.clearances.includes(marking)
}

export function containsInstructionText(text) {
  return INSTRUCTION_PATTERN.test(text)
}

// Returns one entry per check: { id, label, status: 'pass' | 'fail' | 'missing', detail }.
// Any status other than 'pass' blocks a "verifies" link.
export function runChecks({ requirement, requirementRevision, evidence, reviewer }) {
  const current = requirement.revisions[requirementRevision]
  const checks = []

  const accessOk = hasAccess(reviewer, requirement.marking) && hasAccess(reviewer, evidence.marking)
  checks.push({
    id: 'access',
    label: 'Reviewer access',
    status: accessOk ? 'pass' : 'fail',
    detail: accessOk
      ? `Reviewer holds ${[...new Set([requirement.marking, evidence.marking])].join(' and ')} access.`
      : `Reviewer lacks ${evidence.marking} access. Record withheld; the model was not called.`,
  })

  if (!accessOk) return checks

  const revOk = evidence.testedAgainst.id === requirement.id && evidence.testedAgainst.rev === requirementRevision
  checks.push({
    id: 'revision',
    label: 'Requirement revision',
    status: revOk ? 'pass' : 'fail',
    detail: revOk
      ? `${evidence.id} was run against ${requirement.id} rev ${requirementRevision}, the current revision.`
      : `${evidence.id} was run against ${evidence.testedAgainst.id} rev ${evidence.testedAgainst.rev}. The current revision is ${requirementRevision}.`,
  })

  const { metric, comparator, limit } = current.criterion
  const measurement = evidence.measurements.find((m) => m.metric === metric)
  if (!measurement) {
    checks.push({
      id: 'measurement',
      label: `Measured ${metric}`,
      status: 'missing',
      detail: `No structured ${metric} measurement in ${evidence.id}. Narrative wording is not accepted as a measurement.`,
    })
  } else {
    const measuredMs = toMilliseconds(measurement)
    const limitMs = toMilliseconds(limit)
    const compare = COMPARATORS[comparator]
    if (measuredMs === null || limitMs === null || !compare) {
      checks.push({
        id: 'measurement',
        label: `Measured ${metric}`,
        status: 'fail',
        detail: `Unrecognized unit or comparator (${measurement.value} ${measurement.unit}, ${comparator} ${limit.value} ${limit.unit}).`,
      })
    } else {
      const ok = compare(measuredMs, limitMs)
      checks.push({
        id: 'measurement',
        label: `Measured ${metric}`,
        status: ok ? 'pass' : 'fail',
        detail: `${measurement.unit === 's' ? '' : `${measurement.value} ${measurement.unit} = `}${formatSeconds(measuredMs)} measured; limit ${comparator} ${formatSeconds(limitMs)} → ${ok ? 'within limit' : 'exceeds limit'}.`,
      })
    }
  }

  const released = evidence.status === 'released'
  checks.push({
    id: 'release',
    label: 'Evidence release status',
    status: released ? 'pass' : 'fail',
    detail: released ? `${evidence.id} rev ${evidence.rev} is released.` : `${evidence.id} rev ${evidence.rev} is ${evidence.status}; only released evidence can verify.`,
  })

  const injected = containsInstructionText(evidence.narrative)
  checks.push({
    id: 'instructions',
    label: 'Instruction-like text',
    status: injected ? 'fail' : 'pass',
    detail: injected
      ? 'The evidence contains text addressed to automated reviewers. Treat the model’s output as untrusted and report the record.'
      : 'No instruction-like text detected.',
  })

  return checks
}

export function allowedDecisions(checks) {
  const accessOk = checks.find((c) => c.id === 'access')?.status === 'pass'
  if (!accessOk) return { verifies: false, related: false, reject: false, route: true }
  return {
    verifies: checks.every((c) => c.status === 'pass'),
    related: true,
    reject: true,
    route: false,
  }
}
