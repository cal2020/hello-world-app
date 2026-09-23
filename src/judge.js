// Semantic judgment adapter.
//
// The demo uses fixture outputs only; it makes no network calls. A live
// adapter would implement the same `judge(key, request)` shape against
// TypeSafe's API. That adapter is deliberately absent: API details, data
// handling and deployment approval for any real environment are unestablished.

// Pin the tested version and record it with every result. Aliases can move.
export const PINNED_MODEL = 'jev-1.13.0'

export const JUDGE_QUESTION =
  'Does the test evidence describe the failure condition and the expected operator behavior stated in the requirement?'

export const CHOICES = ['supports', 'ambiguous', 'insufficient_evidence', 'contradicts']

// Narrow input: only the two passages under comparison. Revisions,
// measurements and access decisions stay with code.
export function buildRequest(requirementText, evidenceText) {
  return {
    model: PINNED_MODEL,
    question: JUDGE_QUESTION,
    choices: CHOICES,
    context: { requirement: requirementText, evidence: evidenceText },
  }
}

export function createFixtureJudge(fixtures) {
  return {
    source: 'fixture',
    judge(key, request) {
      const fixture = fixtures[key]
      if (!fixture) {
        return { status: 'unavailable', model: request.model, reason: `No fixture for ${key}. A live adapter would re-run the judgment.` }
      }
      const ranked = CHOICES.map((c) => [c, fixture.probabilities[c] ?? 0]).sort((a, b) => b[1] - a[1])
      return {
        status: 'ok',
        model: request.model,
        source: 'fixture',
        choice: ranked[0][0],
        probabilities: fixture.probabilities,
        cites: fixture.cites,
      }
    },
  }
}
