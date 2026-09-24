// Browser stand-in for node:sqlite's DatabaseSync, backed by sql.js (SQLite
// compiled to asm.js, so no WebAssembly permission is needed). Only the
// methods the workbench uses are implemented: exec, prepare().run/get/all, close.
import initSqlJs from 'sql.js/dist/sql-asm-memory-growth.js'

let SQL = null
export const ready = initSqlJs().then((mod) => { SQL = mod })

const norm = (params) => params.map((p) => (p === undefined ? null : p))

class Statement {
  constructor(db, sql) { this.db = db; this.sql = sql }
  run(...params) {
    this.db.run(this.sql, norm(params))
    return { changes: this.db.getRowsModified() }
  }
  get(...params) {
    const st = this.db.prepare(this.sql)
    try {
      st.bind(norm(params))
      return st.step() ? st.getAsObject() : undefined
    } finally { st.free() }
  }
  all(...params) {
    const st = this.db.prepare(this.sql)
    const rows = []
    try {
      st.bind(norm(params))
      while (st.step()) rows.push(st.getAsObject())
    } finally { st.free() }
    return rows
  }
}

export class DatabaseSync {
  constructor() {
    if (!SQL) throw new Error('sql.js not initialized; await ready first')
    this.db = new SQL.Database()
  }
  exec(sql) { this.db.exec(sql) }
  prepare(sql) { return new Statement(this.db, sql) }
  close() { this.db.close() }
}
