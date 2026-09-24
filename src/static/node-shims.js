// Minimal browser stand-ins for node:fs, node:path, node:url and
// node:child_process. The browser build uses an in-memory database and
// bundled fixtures, so file access is never needed.
export const mkdirSync = () => {}
export const readFileSync = () => { throw new Error('No file system in the browser build') }
export const readdirSync = () => []
export const existsSync = () => false
export const statSync = () => ({ isDirectory: () => false })
export const rmSync = () => {}
export const writeFileSync = () => {}
export const dirname = (p) => String(p).split('/').slice(0, -1).join('/') || '/'
export const join = (...parts) => parts.join('/').replace(/\/+/g, '/')
export const resolve = join
export const extname = (p) => { const m = String(p).match(/\.[^./]+$/); return m ? m[0] : '' }
export const normalize = (p) => p
export const fileURLToPath = (u) => String(u).replace(/^file:\/\//, '')
// codeRevision() asks git for the revision; answer with the build-time value.
export const execSync = (cmd) => ({ toString: () => (String(cmd).includes('rev-parse') ? __BUILD_REV__ : '') })
export default { mkdirSync, readFileSync, readdirSync, existsSync, statSync, rmSync, writeFileSync }
