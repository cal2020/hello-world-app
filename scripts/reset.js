// Resets the local demo database and seeds the synthetic scenario.
//   npm run demo:reset                     sources only (start of the live demo)
//   npm run demo:reset -- --stage=draft    + first generated candidate
//   npm run demo:reset -- --stage=reviewed + corrected log, edited and accepted candidate
//   npm run demo:reset -- --stage=changed  + REQ-002 revision B imported (accepted v3 is STALE)
// All stage setup is recorded as scripted demo setup (op ids 'setup-*').
import { rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkbench } from '../server/workbench.js'
import { setupStage } from './demo-steps.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.WORKBENCH_DB || join(root, 'data', 'workbench.db')
const stage = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=sources').split('=')[1]

for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
const wb = createWorkbench({ dbPath })
const author = wb.userForToken('demo-author-kim')
const reviewer = wb.userForToken('demo-reviewer-alvarez')
await setupStage(wb, author, reviewer, stage)
const o = wb.overview()
console.log(`Reset ${dbPath} at stage '${stage}': ${o.manifest.entries.length} active sources, ${o.candidates.length} candidate(s). Manifest ${o.manifest.hash.slice(7, 19)}.`)
wb.close()
