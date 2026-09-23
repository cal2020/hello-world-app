// Resets the local demo database and seeds the synthetic scenario.
//   npm run demo:reset                     sources only (start of the live demo)
//   npm run demo:reset -- --stage=draft    + first generated candidate
//   npm run demo:reset -- --stage=reviewed + corrected log, edited and accepted candidate
import { rmSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkbench } from '../server/workbench.js'
import { seedSources, generate, importInbox, removeUnresolved, judgeAll, accept } from './demo-steps.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.WORKBENCH_DB || join(root, 'data', 'workbench.db')
const stage = (process.argv.find((a) => a.startsWith('--stage=')) || '--stage=sources').split('=')[1]

for (const suffix of ['', '-wal', '-shm']) rmSync(dbPath + suffix, { force: true })
const wb = createWorkbench({ dbPath })
const author = wb.userForToken('demo-author-kim')
const reviewer = wb.userForToken('demo-reviewer-alvarez')
seedSources(wb, author)
if (stage === 'draft' || stage === 'reviewed') {
  const r = await generate(wb, author)
  if (stage === 'reviewed') {
    importInbox(wb, author, 'insp-log-rev2')
    const r2 = await generate(wb, author, r.candidateId)
    const v = judgeAll(wb, reviewer, removeUnresolved(wb, reviewer, r2.versionId).versionId)
    accept(wb, reviewer, v)
  }
}
const o = wb.overview()
console.log(`Reset ${dbPath} at stage '${stage}': ${o.manifest.entries.length} active sources, ${o.candidates.length} candidate(s). Manifest ${o.manifest.hash.slice(7, 19)}.`)
wb.close()
