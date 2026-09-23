// Entrypoint: `npm start` (serves the built UI and the API on one port).
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createWorkbench } from './workbench.js'
import { createHttpServer } from './http.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dbPath = process.env.WORKBENCH_DB || join(root, 'data', 'workbench.db')
const port = Number(process.env.PORT ?? 8787)

const wb = createWorkbench({ dbPath })
const server = createHttpServer(wb, { staticDir: join(root, 'dist') })
server.listen(port, () => {
  console.log(`TTP workbench listening on http://localhost:${server.address().port}  (db: ${dbPath})`)
})
