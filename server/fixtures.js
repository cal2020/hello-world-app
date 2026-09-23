// Loads the synthetic scenario and inbox fixtures from disk.
import { readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures')

export function loadScenario() {
  const dir = join(FIXTURE_DIR, 'scenario')
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
}

export function listInbox() {
  const dir = join(FIXTURE_DIR, 'inbox')
  return readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => {
    const item = JSON.parse(readFileSync(join(dir, f), 'utf8'))
    return { name: f.replace(/\.json$/, ''), label: item.label, snapshotId: `${item.source.sourceId}@${item.source.revision}`, source: item.source }
  })
}

export function loadInbox(name) {
  const item = listInbox().find((i) => i.name === name)
  if (!item) throw new Error(`Unknown inbox item ${name}`)
  return item.source
}
