// Browser version of server/fixtures.js: the same fixtures, bundled at build time.
const scenario = import.meta.glob('../../fixtures/scenario/*.json', { eager: true, import: 'default' })
const inbox = import.meta.glob('../../fixtures/inbox/*.json', { eager: true, import: 'default' })
const evalSources = import.meta.glob('../../fixtures/eval/sources/*.json', { eager: true, import: 'default' })
import cases from '../../fixtures/eval/cases.json'
import criteria from '../../fixtures/eval/criteria.json'

const clone = (x) => JSON.parse(JSON.stringify(x))
const base = (path) => path.split('/').pop().replace(/\.json$/, '')
export const FIXTURE_DIR = 'bundled'

export function loadScenario() {
  return Object.keys(scenario).sort().map((k) => clone(scenario[k]))
}
export function listInbox() {
  return Object.keys(inbox).sort().map((k) => {
    const item = inbox[k]
    return { name: base(k), label: item.label, snapshotId: `${item.source.sourceId}@${item.source.revision}`, source: clone(item.source) }
  })
}
export function loadInbox(name) {
  const item = listInbox().find((i) => i.name === name)
  if (!item) throw new Error(`Unknown inbox item ${name}`)
  return item.source
}
export const loadEvalCases = () => clone(cases)
export const loadEvalCriteria = () => clone(criteria)
export function loadEvalSource(name) {
  const k = Object.keys(evalSources).find((p) => base(p) === name)
  if (!k) throw new Error(`Unknown eval source ${name}`)
  return clone(evalSources[k])
}
