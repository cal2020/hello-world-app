/* Port of hexis_service/storage/sqlite.py (Store) and storage/__init__.py (open_store): an in-memory store with
 * the same public methods and semantics as the SQLite store, minus raw SQL (``q1``/``qa``/``tx`` and the
 * ``db`` connection are not provided; see deviations/kernel.md).
 *
 * Emulated SQLite behavior (proven call for call against the real SQLite Store by golden/gen_store.py):
 *  - every method is one transaction: on any exception every write of the call is rolled back;
 *  - tables keep rows in insertion (rowid) order; PRIMARY KEY / UNIQUE constraints (NULLs are distinct, and a
 *    non-INTEGER primary key column without NOT NULL accepts NULL, as in SQLite), NOT NULL constraints, and the
 *    conflict modes of INSERT (abort -> IntegrityError), INSERT OR IGNORE (skips the row, including on NOT NULL
 *    violations) and INSERT OR REPLACE (deletes the conflicting rows; NOT NULL -> IntegrityError);
 *  - append-only tables (machine_versions, checkpoints, run_events, action_receipts, trace_blobs,
 *    trace_archive_manifests, approval_responses, machine_lifecycle, admission_reports) have no update paths;
 *  - JSON columns hold the canonical text (``canonical_bytes``) and getters parse it, so every getter returns a
 *    fresh deep copy and objects come back with sorted keys like ``json.loads`` of the stored text;
 *  - ORDER BY ties break like SQLite's index scans (receipts by run: created_at, seq, logical_action_id;
 *    evidence: observed_at, receipt_id).
 *  - parameter binding: column affinity conversions for the values the engine passes (strings, integers, bools,
 *    null); lists/dicts raise ProgrammingError, strings with lone surrogates UnicodeEncodeError. Stricter than
 *    SQLite (documented): non-integral floats in TEXT columns and strings in INTEGER/REAL columns raise
 *    InterfaceError (JS-only), integers outside +/-(2^53-1) too.
 *
 * Python built-in errors (KeyError, TypeError, AttributeError, sqlite3.IntegrityError/ProgrammingError, ...)
 * are ``HX.HXError`` with the Python class name as ``code``. ``ConflictError`` keeps Python's message (e.g.
 * "REVISION_CONFLICT: expected 1, found 2") and carries the prefix as ``code``.
 *
 * Python keyword arguments: methods whose Python signature has defaults/keyword-only parameters accept them
 * positionally or as a trailing options object (``receipts(t, {run_id})``, ``record_outcome(..., now,
 * {intent_status, evidence, require_token, expect_status})``, ``publish_admission({environment, ...})``).
 * Python tuples are arrays (``get_active`` -> ``[hash, version]``, ``admission_record`` -> ``[record, report]``).
 *
 * JS-only: ``snapshot()`` / ``restore(json)`` (whole store as JSON, for persisting a UI session),
 * ``Store.restore(json)``, ``reopen()`` (a new Store object over the same data, a simulated process restart),
 * ``tables()`` (raw rows, for tests), ``Store.reset_storage(path)``.
 */
(function (HX) {
  "use strict";
  const store = (HX.store = HX.store || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);

  store.SCHEMA_VERSION = 2;
  store.TERMINAL_RUN_STATUSES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]);
  store.IMMUTABLE = Object.freeze(["machine_versions", "checkpoints", "run_events", "action_receipts", "trace_blobs",
    "trace_archive_manifests", "approval_responses", "machine_lifecycle", "admission_reports"]);
  store.SNAPSHOT_FORMAT = "hexis-browser-store/1";

  class ConflictError extends HX.HXError {
    constructor(message) {
      const m = /^([A-Z_]+):/.exec(message);
      super(m ? m[1] : "CONFLICT", message);
      this.message = message; /* Python: str(exc) */
    }
  }
  store.ConflictError = ConflictError;

  function pyerr(cls, message) {
    const e = new HX.HXError(cls, message);
    e.message = message;
    return e;
  }

  function type_name(v) {
    if (v === null || v === undefined) return "NoneType";
    if (typeof v === "boolean") return "bool";
    if (typeof v === "number") return Number.isInteger(v) ? "int" : "float";
    if (typeof v === "string") return "str";
    if (Array.isArray(v)) return "list";
    if (typeof v === "object") return "dict";
    return typeof v;
  }
  const repr = (v) => (HX.kernel ? HX.kernel._py_repr(v) : HX.util.py_repr(v));

  /** Python ``d[k]`` on a JSON value. */
  function getitem(d, k) {
    if (HX.util.is_plain_object(d)) {
      if (hasOwn(d, k)) return d[k];
      throw pyerr("KeyError", repr(k));
    }
    if (Array.isArray(d) || typeof d === "string") {
      throw pyerr("TypeError", (Array.isArray(d) ? "list" : "string") + " indices must be integers" +
        (Array.isArray(d) ? " or slices, not str" : ", not 'str'"));
    }
    throw pyerr("TypeError", "'" + type_name(d) + "' object is not subscriptable");
  }
  /** Python ``d.get(k, dflt)``. */
  function pyget(d, k, dflt) {
    if (!HX.util.is_plain_object(d)) throw pyerr("AttributeError", "'" + type_name(d) + "' object has no attribute 'get'");
    return hasOwn(d, k) ? d[k] : (dflt === undefined ? null : dflt);
  }
  /** Python ``a == b`` / ``a != b`` for values read back from SQLite (scalars) against arguments. */
  function py_eq(a, b) {
    const na = typeof a === "number" || typeof a === "boolean", nb = typeof b === "number" || typeof b === "boolean";
    if (na && nb) return Number(a) === Number(b);
    if (a === null || a === undefined) return b === null || b === undefined;
    if (typeof a === "string" && typeof b === "string") return a === b;
    if (typeof a === "object" || typeof b === "object") return HX.util.deep_equal(a, b);
    return false;
  }
  /** Python truthiness. */
  function truthy(v) {
    if (v === null || v === undefined || v === false) return false;
    if (typeof v === "number") return v !== 0;
    if (typeof v === "string") return v.length > 0;
    if (Array.isArray(v)) return v.length > 0;
    if (typeof v === "object") return Object.keys(v).length > 0;
    return true;
  }
  /** Python iteration of a JSON value (``for x in v``). */
  function iterate(v) {
    if (Array.isArray(v)) return v;
    if (typeof v === "string") return Array.from(v);
    if (HX.util.is_plain_object(v)) return Object.keys(v);
    throw pyerr("TypeError", "'" + type_name(v) + "' object is not iterable");
  }

  /** ``_j(v)``: canonical JSON text (CanonicalError for values Python cannot canonicalize either). */
  function _j(v) { return HX.canonical.canonical_text(v); }

  /* ------------------------------------------------------------------------------------------ */
  /* Schema                                                                                       */
  /* ------------------------------------------------------------------------------------------ */
  /* [name, affinity, not_null] */
  const T = "TEXT", I = "INTEGER", R = "REAL";
  const SCHEMA = {
    schema_migrations: { cols: [["version", I, false]], keys: [["version"]] },
    machine_versions: { cols: [["artifact_hash", T, false], ["skill_id", T, true], ["parent_hash", T, false],
      ["package", T, true], ["created_at", R, true]], keys: [["artifact_hash"]] },
    machine_lifecycle: { cols: [["artifact_hash", T, true], ["seq", I, true], ["state", T, true], ["actor", T, true],
      ["reason", T, false], ["at", R, true]], keys: [["artifact_hash", "seq"]] },
    active_machine_versions: { cols: [["environment", T, true], ["skill_id", T, true], ["artifact_hash", T, true],
      ["archive_version", I, true], ["updated_at", R, true]], keys: [["environment", "skill_id"]] },
    admission_reports: { cols: [["artifact_hash", T, false], ["record", T, true], ["report", T, true]],
      keys: [["artifact_hash"]] },
    runs: { cols: [["tenant_id", T, true], ["run_id", T, true], ["artifact_hash", T, true], ["principal", T, true],
      ["status", T, true], ["request_id", T, false], ["cancel_requested", I, true], ["created_at", R, true]],
      keys: [["tenant_id", "run_id"], ["tenant_id", "request_id"]] },
    checkpoints: { cols: [["tenant_id", T, true], ["run_id", T, true], ["revision", I, true], ["body", T, true],
      ["created_at", R, true]], keys: [["tenant_id", "run_id", "revision"]] },
    run_events: { cols: [["tenant_id", T, true], ["run_id", T, true], ["sequence", I, true], ["type", T, true],
      ["body", T, true], ["created_at", R, true]], keys: [["tenant_id", "run_id", "sequence"]] },
    leases: { cols: [["tenant_id", T, true], ["run_id", T, true], ["worker_id", T, true], ["token", I, true],
      ["expires_at", R, true]], keys: [["tenant_id", "run_id"]] },
    action_intents: { cols: [["tenant_id", T, true], ["run_id", T, true], ["logical_action_id", T, true],
      ["state_id", T, true], ["revision", I, true], ["tool", T, true], ["tool_version", T, true], ["args", T, true],
      ["args_digest", T, true], ["idempotency_key", T, true], ["status", T, true], ["lease_token", I, false],
      ["attempts", I, true], ["created_at", R, true], ["updated_at", R, true]],
      keys: [["tenant_id", "logical_action_id"], ["tenant_id", "run_id", "revision"]] },
    action_receipts: { cols: [["tenant_id", T, true], ["logical_action_id", T, true], ["seq", I, true],
      ["run_id", T, true], ["tool", T, true], ["tool_version", T, true], ["args_digest", T, true],
      ["idempotency_key", T, true], ["dispatch_state", T, true], ["certainty", T, true], ["external_ref", T, false],
      ["result", T, false], ["connector", T, true], ["created_at", R, true]],
      keys: [["tenant_id", "logical_action_id", "seq"]] },
    approval_requests: { cols: [["tenant_id", T, true], ["run_id", T, true], ["interaction_id", T, true],
      ["type", T, true], ["state_id", T, true], ["revision", I, true], ["scope", T, true], ["scope_digest", T, true],
      ["expires_at", R, false], ["status", T, true], ["created_at", R, true]],
      keys: [["tenant_id", "interaction_id"], ["tenant_id", "run_id", "revision"]] },
    approval_responses: { cols: [["tenant_id", T, true], ["interaction_id", T, true], ["run_id", T, true],
      ["responder", T, true], ["response", T, true], ["scope_digest", T, true], ["request_id", T, false],
      ["created_at", R, true]], keys: [["tenant_id", "interaction_id"]] },
    trace_blobs: { cols: [["trace_id", T, false], ["sha256", T, true], ["body", T, true], ["created_at", R, true]],
      keys: [["trace_id"]] },
    trace_archive_manifests: { cols: [["skill_id", T, true], ["version", I, true], ["artifact_hash", T, true],
      ["manifest", T, true], ["created_at", R, true]], keys: [["skill_id", "version"]] },
    update_proposals: { cols: [["proposal_id", T, false], ["parent_hash", T, true], ["candidate_hash", T, false],
      ["status", T, true], ["body", T, true], ["created_at", R, true]], keys: [["proposal_id"]] },
    evidence_receipts: { cols: [["tenant_id", T, true], ["receipt_id", T, true], ["run_id", T, true],
      ["claim", T, true], ["verifier", T, true], ["verifier_version", T, true], ["subject", T, true],
      ["subject_digest", T, true], ["result", T, true], ["source_ref", T, true], ["observed_at", R, true],
      ["invalidated_at", R, false], ["invalidation_reason", T, false]],
      keys: [["tenant_id", "run_id", "receipt_id"]] },
  };
  for (const name of Object.keys(SCHEMA)) {
    const s = SCHEMA[name];
    s.name = name;
    s.idx = {};
    s.cols.forEach((c, i) => { s.idx[c[0]] = i; });
    s.key_idx = s.keys.map((k) => k.map((c) => s.idx[c]));
  }
  store.TABLES = Object.freeze(Object.keys(SCHEMA));
  store.COLUMNS = Object.freeze(Object.fromEntries(Object.keys(SCHEMA).map((n) => [n, SCHEMA[n].cols.map((c) => c[0])])));

  /* ------------------------------------------------------------------------------------------ */
  /* Parameter binding (Python sqlite3 + SQLite column affinity)                                  */
  /* ------------------------------------------------------------------------------------------ */
  /** Bind one parameter (1-based position ``n`` in its statement) for a column of affinity ``aff``. */
  function bind(v, aff, n) {
    if (v === null) return null;
    if (v === undefined) throw pyerr("TypeError", "parameter " + n + " is undefined (JS port)");
    if (Array.isArray(v) || (typeof v === "object")) {
      throw pyerr("ProgrammingError", "Error binding parameter " + n + ": type '" + type_name(v) + "' is not supported");
    }
    if (typeof v === "boolean") v = v ? 1 : 0;
    if (typeof v === "number") {
      if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) {
        throw pyerr("InterfaceError", "parameter " + n + ": number " + String(v) + " is not supported by the JavaScript port");
      }
      if (aff === T) {
        if (!Number.isInteger(v)) {
          throw pyerr("InterfaceError", "parameter " + n + ": a float in a TEXT column is not supported by the JavaScript port");
        }
        return String(v === 0 ? 0 : v);
      }
      return v === 0 ? 0 : v;
    }
    if (typeof v === "string") {
      if (HX.util.has_lone_surrogate(v)) {
        throw pyerr("UnicodeEncodeError", "'utf-8' codec can't encode character: surrogates not allowed");
      }
      if (aff !== T) {
        throw pyerr("InterfaceError", "parameter " + n + ": a string in a numeric column is not supported by the JavaScript port");
      }
      return v;
    }
    throw pyerr("InterfaceError", "parameter " + n + ": unsupported type " + typeof v);
  }

  /** SQLite value ordering: NULL < numbers < text (BINARY = code point order). */
  function cmp_sql(a, b) {
    const rank = (x) => (x === null ? 0 : typeof x === "number" ? 1 : 2);
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return 0;
    if (ra === 1) return a < b ? -1 : a > b ? 1 : 0;
    return HX.util.cmp_codepoints(a, b);
  }
  /** SQL ``col = ?`` (NULL never equal). */
  const sql_eq = (a, b) => a !== null && b !== null && cmp_sql(a, b) === 0;

  /* ------------------------------------------------------------------------------------------ */
  /* Database (shared by every Store object opened on it)                                          */
  /* ------------------------------------------------------------------------------------------ */
  function new_db() {
    const tables = {};
    for (const name of Object.keys(SCHEMA)) tables[name] = [];
    tables.schema_migrations.push([store.SCHEMA_VERSION]);
    return { tables };
  }

  const FILES = new Map(); /* path -> db, like reopening the same SQLite file */

  class Store {
    constructor(path) {
      this.path = path === undefined ? ":memory:" : path;
      if (typeof this.path !== "string") throw pyerr("TypeError", "expected str, bytes or os.PathLike object, not " + type_name(this.path));
      if (this.path === ":memory:" || this.path === "") {
        this._db = new_db();
      } else {
        if (!FILES.has(this.path)) FILES.set(this.path, new_db());
        this._db = FILES.get(this.path);
      }
      this._closed = false;
      this._log = null;
    }

    static _over(db, path) {
      const s = Object.create(Store.prototype);
      s.path = path;
      s._db = db;
      s._closed = false;
      s._log = null;
      return s;
    }

    /** Forget the rows of a file-backed path (tests). */
    static reset_storage(path) { FILES.delete(path); }

    /* ---- low-level table access -------------------------------------------------------------- */
    _check() {
      if (this._closed) throw pyerr("ProgrammingError", "Cannot operate on a closed database.");
    }
    _rows(table) { this._check(); return this._db.tables[table]; }

    /** One transaction: on any exception every change of ``fn`` is undone. */
    _tx(fn) {
      this._check();
      if (this._log) return fn();
      const log = (this._log = []);
      try {
        const out = fn();
        this._log = null;
        return out;
      } catch (e) {
        this._log = null;
        for (let i = log.length - 1; i >= 0; i--) log[i]();
        throw e;
      }
    }

    _not_null(s, row) {
      for (let i = 0; i < s.cols.length; i++) {
        if (s.cols[i][2] && row[i] === null) return s.name + "." + s.cols[i][0];
      }
      return null;
    }

    _conflicts(s, row, except) {
      const rows = this._db.tables[s.name];
      const out = [];
      for (const ki of s.key_idx) {
        if (ki.some((i) => row[i] === null)) continue;
        for (const r of rows) {
          if (r === except || out.indexOf(r) >= 0) continue;
          if (ki.every((i) => cmp_sql(r[i], row[i]) === 0)) out.push(r);
        }
      }
      return out;
    }

    /** INSERT [OR IGNORE | OR REPLACE] of one bound row. Returns true when the row was written. */
    _insert(table, row, mode) {
      const s = SCHEMA[table];
      const rows = this._rows(table);
      const nn = this._not_null(s, row);
      if (nn) {
        if (mode === "ignore") return false;
        throw pyerr("IntegrityError", "NOT NULL constraint failed: " + nn);
      }
      const conf = this._conflicts(s, row, null);
      if (conf.length) {
        if (mode === "ignore") return false;
        if (mode !== "replace") {
          const ki = s.key_idx.find((k) => k.every((i) => row[i] !== null && conf.some((r) => cmp_sql(r[i], row[i]) === 0)));
          throw pyerr("IntegrityError", "UNIQUE constraint failed: " + (ki || s.key_idx[0]).map((i) => table + "." + s.cols[i][0]).join(", "));
        }
        for (const r of conf) {
          const at = rows.indexOf(r);
          rows.splice(at, 1);
          if (this._log) this._log.push(() => rows.splice(at, 0, r));
        }
      }
      rows.push(row);
      if (this._log) this._log.push(() => { const at = rows.lastIndexOf(row); if (at >= 0) rows.splice(at, 1); });
      return true;
    }

    /** UPDATE rows matching ``where(row)`` with ``set(row) -> {col: value}``. Returns the row count. */
    _update(table, where, set) {
      if (store.IMMUTABLE.indexOf(table) >= 0) throw pyerr("IntegrityError", table + " is append-only");
      const s = SCHEMA[table];
      let n = 0;
      for (const r of this._rows(table)) {
        if (!where(r)) continue;
        const ch = set(r);
        const old = r.slice();
        for (const c of Object.keys(ch)) r[s.idx[c]] = ch[c];
        const nn = this._not_null(s, r);
        if (nn) {
          for (let i = 0; i < r.length; i++) r[i] = old[i];
          throw pyerr("IntegrityError", "NOT NULL constraint failed: " + nn);
        }
        if (this._log) this._log.push(() => { for (let i = 0; i < r.length; i++) r[i] = old[i]; });
        n++;
      }
      return n;
    }

    _find(table, where) { return this._rows(table).filter(where); }
    _first(table, where) { const r = this._rows(table).find(where); return r === undefined ? null : r; }
    _col(table, name) { return SCHEMA[table].idx[name]; }
    _obj(table, row) {
      const out = {};
      SCHEMA[table].cols.forEach((c, i) => { out[c[0]] = row[i]; });
      return out;
    }
    _max(table, col, where) {
      const i = this._col(table, col);
      let m = null;
      for (const r of this._rows(table)) if (where(r) && r[i] !== null && (m === null || cmp_sql(r[i], m) > 0)) m = r[i];
      return m;
    }

    /** Bind the arguments of one statement: ``[[value, affinity], ...]``. */
    static _bind_all(pairs) { return pairs.map(([v, aff], i) => bind(v, aff, i + 1)); }

    /* ---- lifecycle / snapshot ------------------------------------------------------------------ */
    schema_version() {
      return this._max("schema_migrations", "version", () => true);
    }

    /** Simulated process restart. Python: ``Store(self.path) if self.path != ":memory:" else self``.
     *  - a file path: a new Store on that path (its rows), also after close();
     *  - "" (SQLite's private temporary database): a new, empty Store, like Python;
     *  - ":memory:": a closed store returns itself (like Python); an open one returns a new Store object over the
     *    same data (spec: simulated restart; Python returns self). */
    reopen() {
      if (this.path !== ":memory:") return new Store(this.path);
      if (this._closed) return this;
      return Store._over(this._db, this.path);
    }

    close() { this._closed = true; }

    /** Raw rows of every table (fresh copies; column order as in the DDL). */
    tables() {
      this._check();
      const out = {};
      for (const name of Object.keys(SCHEMA)) out[name] = this._db.tables[name].map((r) => r.slice());
      return out;
    }

    /** The whole store as a JSON-compatible object. */
    snapshot() {
      return { format: store.SNAPSHOT_FORMAT, schema_version: store.SCHEMA_VERSION, columns: store.COLUMNS, tables: this.tables() };
    }

    /** Replace this store's data with a snapshot (object or JSON text). Validates every row. */
    restore(json) {
      this._check();
      const db = parse_snapshot(json);
      this._db.tables = db.tables;
      return this;
    }

    static restore(json, path) {
      const db = parse_snapshot(json);
      return Store._over(db, path === undefined ? ":memory:" : path);
    }

    /* ---- artifact registry ---------------------------------------------------------------------- */
    put_version(package_json, actor, now) {
      this._check();
      const h = getitem(package_json, "artifact_hash");
      return this._tx(() => {
        const hb = bind(h, T, 1);
        if (this._first("machine_versions", (r) => sql_eq(r[0], hb))) return null;
        const skill = getitem(getitem(package_json, "machine"), "skill_id");
        const parent = pyget(getitem(package_json, "lineage"), "parent_hash");
        const row = Store._bind_all([[h, T], [skill, T], [parent, T], [_j(package_json), T], [now, R]]);
        this._insert("machine_versions", row, "abort");
        this._insert("machine_lifecycle", Store._bind_all([[h, T], [1, I], ["validated", T], [actor, T], ["", T], [now, R]]), "abort");
        return null;
      });
    }

    get_version(artifact_hash) {
      const h = bind(artifact_hash, T, 1);
      const r = this._first("machine_versions", (x) => sql_eq(x[0], h));
      return r ? JSON.parse(r[3]) : null;
    }

    lifecycle(artifact_hash) {
      const h = bind(artifact_hash, T, 1);
      return this._find("machine_lifecycle", (x) => sql_eq(x[0], h)).sort((a, b) => cmp_sql(a[1], b[1]))
        .map((r) => ({ seq: r[1], state: r[2], actor: r[3], reason: r[4], at: r[5] }));
    }

    /** ``add_lifecycle(db, ...)``: the ``db`` argument (a connection in Python) is ignored; runs in the current
     *  transaction when called from inside one. */
    add_lifecycle(_db, artifact_hash, state, actor, reason, now) {
      return this._tx(() => {
        const h = bind(artifact_hash, T, 1);
        const m = this._max("machine_lifecycle", "seq", (x) => sql_eq(x[0], h));
        const seq = (m === null ? 0 : m) + 1;
        this._insert("machine_lifecycle", Store._bind_all([[artifact_hash, T], [seq, I], [state, T], [actor, T], [reason, T], [now, R]]), "abort");
        return null;
      });
    }

    is_revoked(artifact_hash) {
      const h = bind(artifact_hash, T, 1);
      return this._first("machine_lifecycle", (x) => sql_eq(x[0], h) && x[2] === "revoked") !== null;
    }

    is_admitted(artifact_hash) {
      const h = bind(artifact_hash, T, 1);
      return this._first("machine_lifecycle", (x) => sql_eq(x[0], h) && x[2] === "admitted") !== null;
    }

    add_lifecycle_entry(artifact_hash, state, actor, reason, now) {
      return this._tx(() => this.add_lifecycle(null, artifact_hash, state, actor, reason, now));
    }

    /** ``[record_json, report_json]`` stored under ``key`` (an artifact hash or ``hash@environment``), or null. */
    admission_record(key) {
      const k = bind(key, T, 1);
      const r = this._first("admission_reports", (x) => sql_eq(x[0], k));
      return r ? [r[1], r[2]] : null;
    }

    _store_traces(traces, now) {
      for (const t of iterate(traces)) {
        const parts = iterate(t);
        if (parts.length !== 3) {
          throw pyerr("ValueError", parts.length > 3 ? "too many values to unpack (expected 3)"
            : "not enough values to unpack (expected 3, got " + parts.length + ")");
        }
        this._insert("trace_blobs", Store._bind_all([[parts[0], T], [parts[1], T], [parts[2], T], [now, R]]), "ignore");
      }
    }

    publish_admission(kw) {
      this._check();
      const a = kwargs(kw, ["environment", "skill_id", "artifact_hash", "expected_parent_hash", "gated_archive_version",
        "traces", "record", "report", "env_key", "actor", "manifest", "now"], "publish_admission");
      return this._tx(() => {
        const env = bind(a.environment, T, 1), skill = bind(a.skill_id, T, 2);
        const row = this._first("active_machine_versions", (x) => sql_eq(x[0], env) && sql_eq(x[1], skill));
        const current = row ? row[2] : null;
        if (!py_eq(current, a.expected_parent_hash)) return { status: "CONFLICT", conflict: "active", current };
        const latest = this._max("trace_archive_manifests", "version", (x) => sql_eq(x[0], skill));
        if (!py_eq(latest, a.gated_archive_version)) return { status: "CONFLICT", conflict: "archive", current };
        const version = (truthy(latest) ? latest : 0) + 1;
        this._store_traces(a.traces, a.now);
        for (const key of [a.artifact_hash, a.env_key]) {
          this._insert("admission_reports", Store._bind_all([[key, T], [_j(a.record), T], [_j(a.report), T]]), "ignore");
        }
        this.add_lifecycle(null, a.artifact_hash, "admitted", a.actor, a.environment, a.now);
        this.add_lifecycle(null, a.artifact_hash, "active", a.actor, a.environment, a.now);
        const man = manifest_with(a.manifest, version, a.artifact_hash);
        this._insert("trace_archive_manifests", Store._bind_all([[a.skill_id, T], [version, I], [a.artifact_hash, T], [_j(man), T], [a.now, R]]), "abort");
        this._insert("active_machine_versions", Store._bind_all([[a.environment, T], [a.skill_id, T], [a.artifact_hash, T], [version, I], [a.now, R]]), "replace");
        return { status: "ADMITTED", version };
      });
    }

    append_archive_manifest(kw) {
      this._check();
      const a = kwargs(kw, ["skill_id", "expected_version", "artifact_hash", "manifest", "traces", "actor",
        "lifecycle_state", "lifecycle_reason", "now"], "append_archive_manifest");
      return this._tx(() => {
        const skill = bind(a.skill_id, T, 1);
        const latest = this._max("trace_archive_manifests", "version", (x) => sql_eq(x[0], skill));
        if (!py_eq(latest, a.expected_version)) return { status: "CONFLICT" };
        const version = (truthy(latest) ? latest : 0) + 1;
        this._store_traces(a.traces, a.now);
        const man = manifest_with(a.manifest, version, a.artifact_hash);
        this._insert("trace_archive_manifests", Store._bind_all([[a.skill_id, T], [version, I], [a.artifact_hash, T], [_j(man), T], [a.now, R]]), "abort");
        const [v, s2, h] = Store._bind_all([[version, I], [a.skill_id, T], [a.artifact_hash, T]]);
        this._update("active_machine_versions", (x) => sql_eq(x[1], s2) && sql_eq(x[2], h), () => ({ archive_version: v }));
        this.add_lifecycle(null, a.artifact_hash, a.lifecycle_state, a.actor, a.lifecycle_reason, a.now);
        return { status: "ADMITTED", version };
      });
    }

    /** ``[artifact_hash, archive_version]`` or null. */
    get_active(environment, skill_id) {
      const [e, s] = Store._bind_all([[environment, T], [skill_id, T]]);
      const r = this._first("active_machine_versions", (x) => sql_eq(x[0], e) && sql_eq(x[1], s));
      return r ? [r[2], r[3]] : null;
    }

    /* ---- runs / checkpoints / events ---------------------------------------------------------- */
    create_run(tenant_id, run_id, artifact_hash, principal, request_id, checkpoint, events, now) {
      return this._tx(() => {
        if (truthy(request_id)) {
          const [t, q] = Store._bind_all([[tenant_id, T], [request_id, T]]);
          if (this._first("runs", (x) => sql_eq(x[0], t) && sql_eq(x[5], q))) return false;
        }
        const status = getitem(checkpoint, "status");
        this._insert("runs", Store._bind_all([[tenant_id, T], [run_id, T], [artifact_hash, T], [principal, T], [status, T],
          [truthy(request_id) ? request_id : null, T], [0, I], [now, R]]), "abort");
        this._insert("checkpoints", Store._bind_all([[tenant_id, T], [run_id, T], [0, I], [_j(checkpoint), T], [now, R]]), "abort");
        this._append_events(tenant_id, run_id, events, now);
        return true;
      });
    }

    run_by_request(tenant_id, request_id) {
      const [t, q] = Store._bind_all([[tenant_id, T], [request_id, T]]);
      const r = this._first("runs", (x) => sql_eq(x[0], t) && sql_eq(x[5], q));
      return r ? r[1] : null;
    }

    /** Run ids of one tenant in creation order (never another tenant's). */
    list_runs(tenant_id) {
      const t = bind(tenant_id, T, 1);
      return this._find("runs", (x) => sql_eq(x[0], t))
        .sort((a, b) => cmp_sql(a[7], b[7]) || cmp_sql(a[1], b[1])).map((r) => r[1]);
    }

    get_run(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      const r = this._first("runs", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
      if (!r) return null;
      return { tenant_id, run_id, artifact_hash: r[2], principal: r[3], status: r[4], cancel_requested: truthy(r[6]),
        created_at: r[7] };
    }

    latest_checkpoint(tenant_id, run_id) {
      const cps = this._checkpoint_rows(tenant_id, run_id);
      return cps.length ? JSON.parse(cps[cps.length - 1][3]) : null;
    }

    checkpoints(tenant_id, run_id) {
      return this._checkpoint_rows(tenant_id, run_id).map((r) => JSON.parse(r[3]));
    }

    _checkpoint_rows(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      return this._find("checkpoints", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0)).sort((a, b) => cmp_sql(a[2], b[2]));
    }

    _append_events(tenant_id, run_id, events, now) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      const m = this._max("run_events", "sequence", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
      let seq = m === null ? 0 : m;
      for (const e of iterate(events)) {
        seq += 1;
        const type = getitem(e, "type");
        this._insert("run_events", Store._bind_all([[tenant_id, T], [run_id, T], [seq, I], [event_type(type), T], [_j(e), T], [now, R]]), "abort");
      }
    }

    append_events(tenant_id, run_id, events, now) {
      return this._tx(() => { this._append_events(tenant_id, run_id, events, now); return null; });
    }

    events(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      return this._find("run_events", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0)).sort((a, b) => cmp_sql(a[2], b[2]))
        .map((r) => {
          const body = JSON.parse(r[4]);
          const out = { sequence: r[2] };
          if (HX.util.is_plain_object(body)) {
            for (const k of Object.keys(body)) Object.defineProperty(out, k, { value: body[k], enumerable: true, writable: true, configurable: true });
          }
          return out;
        });
    }

    /** Atomically: fencing check, revision CAS, checkpoint insert, events, run status. */
    commit_transition(tenant_id, run_id, expected_revision, lease_token, checkpoint, events, now) {
      return this._tx(() => {
        const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
        if (lease_token !== null && lease_token !== undefined) {
          const r = this._first("leases", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
          if (!r || !py_eq(r[3], lease_token)) throw new ConflictError("STALE_LEASE: worker no longer owns this run");
        }
        const cur = this._max("checkpoints", "revision", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
        if (!py_eq(cur, expected_revision)) {
          throw new ConflictError("REVISION_CONFLICT: expected " + py_str(expected_revision) + ", found " + py_str(cur));
        }
        const rev = getitem(checkpoint, "revision");
        this._insert("checkpoints", Store._bind_all([[tenant_id, T], [run_id, T], [rev, I], [_j(checkpoint), T], [now, R]]), "abort");
        this._append_events(tenant_id, run_id, events, now);
        const status = getitem(checkpoint, "status");
        const sb = bind(status, T, 1);
        this._update("runs", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0), () => ({ status: sb }));
        if (getitem(checkpoint, "status") !== null && store.TERMINAL_RUN_STATUSES.some((s) => py_eq(s, getitem(checkpoint, "status")))) {
          /* A finished run can never be reopened by a late answer to a still-open interaction. */
          this._update("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && x[9] === "OPEN", () => ({ status: "CLOSED" }));
        }
        return null;
      });
    }

    /** Set a non-terminal run status. Never overwrites a terminal status (returns false). */
    set_run_status(tenant_id, run_id, status) {
      return this._tx(() => this._set_run_status(tenant_id, run_id, status));
    }

    _set_run_status(tenant_id, run_id, status) {
      const [s, t, r0] = Store._bind_all([[status, T], [tenant_id, T], [run_id, T]]);
      return this._update("runs", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && x[4] !== null &&
        store.TERMINAL_RUN_STATUSES.indexOf(x[4]) < 0, () => ({ status: s })) > 0;
    }

    request_cancel(tenant_id, run_id) {
      return this._tx(() => {
        const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
        this._update("runs", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0), () => ({ cancel_requested: 1 }));
        return null;
      });
    }

    /* ---- leases (fencing) ------------------------------------------------------------------------ */
    acquire_lease(tenant_id, run_id, worker_id, now, ttl) {
      return this._tx(() => {
        const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
        const r = this._first("leases", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
        if (r && !py_eq(r[2], worker_id) && r[4] > py_num(now)) return null;
        const token = (r ? r[3] : 0) + 1;
        const exp = py_add(now, ttl);
        this._insert("leases", Store._bind_all([[tenant_id, T], [run_id, T], [worker_id, T], [token, I], [exp, R]]), "replace");
        return token;
      });
    }

    lease_token(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      const r = this._first("leases", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
      return r ? r[3] : null;
    }

    /* ---- action ledger ----------------------------------------------------------------------------- */
    create_intent(tenant_id, run_id, lid, state_id, revision, tool, version, args, args_digest, idem, lease_token, now) {
      this._tx(() => {
        const [t, r0, rv] = Store._bind_all([[tenant_id, T], [run_id, T], [revision, I]]);
        if (!this._first("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && sql_eq(x[4], rv))) {
          this._insert("action_intents", Store._bind_all([[tenant_id, T], [run_id, T], [lid, T], [state_id, T], [revision, I],
            [tool, T], [version, T], [_j(args), T], [args_digest, T], [idem, T], ["PENDING", T], [lease_token, I], [0, I],
            [now, R], [now, R]]), "abort");
        }
        return null;
      });
      return this.intent_for_revision(tenant_id, run_id, revision);
    }

    _intent_row(r) {
      const d = this._obj("action_intents", r);
      d.args = JSON.parse(d.args);
      return d;
    }

    intent_for_revision(tenant_id, run_id, revision) {
      const [t, r0, rv] = Store._bind_all([[tenant_id, T], [run_id, T], [revision, I]]);
      const r = this._first("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && sql_eq(x[4], rv));
      return r ? this._intent_row(r) : null;
    }

    intent(tenant_id, lid) {
      const [t, l] = Store._bind_all([[tenant_id, T], [lid, T]]);
      const r = this._first("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[2], l));
      return r ? this._intent_row(r) : null;
    }

    intents(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      return this._find("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0))
        .sort((a, b) => cmp_sql(a[4], b[4])).map((r) => this._intent_row(r));
    }

    _fence_ok(tenant_id, lid, token, run_id) {
      if (run_id === null || run_id === undefined) {
        const [t, l] = Store._bind_all([[tenant_id, T], [lid, T]]);
        const r = this._first("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[2], l));
        if (!r) return false;
        run_id = r[1];
      }
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      const r = this._first("leases", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0));
      return !!r && py_eq(r[3], token);
    }

    _update_intent(tenant_id, lid, status, now, bump_attempt, lease_token, expect_status) {
      const [s, n, inc, lt, t, l] = Store._bind_all([[status, T], [now, R], [truthy(bump_attempt) ? 1 : 0, I],
        [lease_token, I], [tenant_id, T], [lid, T]]);
      let expect = null;
      if (expect_status !== null && expect_status !== undefined) {
        expect = iterate(expect_status).map((v, i) => bind(v, T, 7 + i));
      }
      return this._update("action_intents", (x) => sql_eq(x[0], t) && sql_eq(x[2], l) &&
        (expect === null || expect.some((e) => sql_eq(x[10], e))),
      (x) => ({ status: s, updated_at: n, attempts: x[12] + inc, lease_token: lt !== null ? lt : x[11] })) > 0;
    }

    /** ``update_intent(t, lid, status, now, bump_attempt=False, lease_token=None, require_token=None,
     *  expect_status=None, run_id=None)``; the optional parameters positionally or as an options object. */
    update_intent(tenant_id, lid, status, now, ...rest) {
      const o = opts(rest, ["bump_attempt", "lease_token", "require_token", "expect_status", "run_id"], "update_intent");
      return this._tx(() => {
        if (o.require_token !== null && !this._fence_ok(tenant_id, lid, o.require_token, o.run_id)) {
          throw new ConflictError("STALE_LEASE: dispatch fenced off");
        }
        return this._update_intent(tenant_id, lid, status, now, o.bump_attempt === null ? false : o.bump_attempt,
          o.lease_token, o.expect_status);
      });
    }

    /** Atomically append an action receipt, move the intent to ``intent_status`` and issue the evidence receipts
     *  derived from it (``evidence(seq)``). Returns the receipt seq, or null (writing nothing) when the lease fence
     *  or the expected intent status no longer holds. Keyword-only options: ``{intent_status, evidence,
     *  require_token, expect_status}``. */
    record_outcome(tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state, certainty, external_ref,
      result, connector, now, kw) {
      const o = kwopts(kw, ["intent_status", "evidence", "require_token", "expect_status"], "record_outcome");
      return this._tx(() => {
        if (o.require_token !== null && !this._fence_ok(tenant_id, lid, o.require_token, run_id)) return null;
        if (o.intent_status !== null) {
          const changed = this._update_intent(tenant_id, lid, o.intent_status, now, false, null, o.expect_status);
          if (o.expect_status !== null && !changed) return null;
        }
        const seq = this._add_receipt(tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state, certainty,
          external_ref, result, connector, now);
        if (truthy(o.evidence)) {
          if (typeof o.evidence !== "function") throw pyerr("TypeError", "'" + type_name(o.evidence) + "' object is not callable");
          for (const rec of iterate(o.evidence(seq))) this._add_evidence(tenant_id, rec);
        }
        return seq;
      });
    }

    add_receipt(tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state, certainty, external_ref, result,
      connector, now) {
      return this._tx(() => this._add_receipt(tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state,
        certainty, external_ref, result, connector, now));
    }

    _add_receipt(tenant_id, lid, run_id, tool, version, args_digest, idem, dispatch_state, certainty, external_ref, result,
      connector, now) {
      const [t, l] = Store._bind_all([[tenant_id, T], [lid, T]]);
      const m = this._max("action_receipts", "seq", (x) => sql_eq(x[0], t) && sql_eq(x[1], l));
      const seq = (m === null ? 0 : m) + 1;
      const res = result !== null && result !== undefined ? _j(result) : null;
      this._insert("action_receipts", Store._bind_all([[tenant_id, T], [lid, T], [seq, I], [run_id, T], [tool, T], [version, T],
        [args_digest, T], [idem, T], [dispatch_state, T], [certainty, T], [external_ref, T], [res, T], [connector, T],
        [now, R]]), "abort");
      return seq;
    }

    /** ``receipts(t, lid=None, run_id=None)``: by logical action (seq order) when ``lid`` is truthy, else by run
     *  (created_at, seq order). ``receipts(t, {run_id})`` or ``receipts(t, null, run_id)``. */
    receipts(tenant_id, ...rest) {
      const o = opts(rest, ["lid", "run_id"], "receipts");
      const rows = truthy(o.lid)
        ? (() => {
          const [t, l] = Store._bind_all([[tenant_id, T], [o.lid, T]]);
          return this._find("action_receipts", (x) => sql_eq(x[0], t) && sql_eq(x[1], l)).sort((a, b) => cmp_sql(a[2], b[2]));
        })()
        : (() => {
          const [t, r0] = Store._bind_all([[tenant_id, T], [o.run_id, T]]);
          /* SQLite scans the (tenant_id, logical_action_id, seq) index, then sorts stably by created_at, seq */
          return this._find("action_receipts", (x) => sql_eq(x[0], t) && sql_eq(x[3], r0))
            .sort((a, b) => cmp_sql(a[13], b[13]) || cmp_sql(a[2], b[2]) || cmp_sql(a[1], b[1]));
        })();
      return rows.map((r) => {
        const d = this._obj("action_receipts", r);
        d.result = truthy(d.result) ? JSON.parse(d.result) : null;
        return d;
      });
    }

    /* ---- interactions ------------------------------------------------------------------------------ */
    create_interaction(tenant_id, run_id, iid, typ, state_id, revision, scope, scope_digest, expires_at, now) {
      this._tx(() => {
        const [t, r0, rv] = Store._bind_all([[tenant_id, T], [run_id, T], [revision, I]]);
        if (!this._first("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && sql_eq(x[5], rv))) {
          this._insert("approval_requests", Store._bind_all([[tenant_id, T], [run_id, T], [iid, T], [typ, T], [state_id, T],
            [revision, I], [_j(scope), T], [scope_digest, T], [expires_at, R], ["OPEN", T], [now, R]]), "abort");
        }
        return null;
      });
      return this.interaction_for_revision(tenant_id, run_id, revision);
    }

    _ix(r) {
      const d = this._obj("approval_requests", r);
      d.scope = JSON.parse(d.scope);
      return d;
    }

    interaction(tenant_id, iid) {
      const [t, i] = Store._bind_all([[tenant_id, T], [iid, T]]);
      const r = this._first("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[2], i));
      return r ? this._ix(r) : null;
    }

    interaction_for_revision(tenant_id, run_id, revision) {
      const [t, r0, rv] = Store._bind_all([[tenant_id, T], [run_id, T], [revision, I]]);
      const r = this._first("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[1], r0) && sql_eq(x[5], rv));
      return r ? this._ix(r) : null;
    }

    set_interaction_status(tenant_id, iid, status) {
      return this._tx(() => {
        const [s, t, i] = Store._bind_all([[status, T], [tenant_id, T], [iid, T]]);
        this._update("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[2], i), () => ({ status: s }));
        return null;
      });
    }

    /** Record the single response to an OPEN interaction, plus its events and the run status, in one
     *  transaction. Returns false (writing nothing) if another response won or the interaction is closed.
     *  ``events``/``run_status`` positionally or as an options object. */
    record_response(tenant_id, iid, run_id, responder, response, scope_digest, request_id, now, ...rest) {
      const o = opts(rest, ["events", "run_status"], "record_response");
      return this._tx(() => {
        const [t, i] = Store._bind_all([[tenant_id, T], [iid, T]]);
        if (this._first("approval_responses", (x) => sql_eq(x[0], t) && sql_eq(x[1], i))) return false;
        const st = this._first("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[2], i));
        if (st !== null && st[9] !== "OPEN") return false;
        this._insert("approval_responses", Store._bind_all([[tenant_id, T], [iid, T], [run_id, T], [responder, T],
          [_j(response), T], [scope_digest, T], [request_id, T], [now, R]]), "abort");
        this._update("approval_requests", (x) => sql_eq(x[0], t) && sql_eq(x[2], i), () => ({ status: "ANSWERED" }));
        if (truthy(o.events)) this._append_events(tenant_id, run_id, o.events, now);
        if (o.run_status !== null) this._set_run_status(tenant_id, run_id, o.run_status);
        return true;
      });
    }

    response(tenant_id, iid) {
      const [t, i] = Store._bind_all([[tenant_id, T], [iid, T]]);
      const r = this._first("approval_responses", (x) => sql_eq(x[0], t) && sql_eq(x[1], i));
      if (!r) return null;
      return { responder: r[3], response: JSON.parse(r[4]), scope_digest: r[5], request_id: r[6], created_at: r[7] };
    }

    /* ---- evidence ------------------------------------------------------------------------------------ */
    /** Idempotent per (tenant, run, receipt id). */
    add_evidence(tenant_id, rec) {
      return this._tx(() => { this._add_evidence(tenant_id, rec); return null; });
    }

    _add_evidence(tenant_id, rec) {
      const g = (k) => getitem(rec, k);
      const vals = [[tenant_id, T], [g("receipt_id"), T], [g("run_id"), T], [g("claim"), T], [g("verifier"), T],
        [g("verifier_version"), T], [_j(g("subject")), T], [g("subject_digest"), T], [g("result"), T],
        [g("source_ref"), T], [g("observed_at"), R], [null, R], [null, T]];
      this._insert("evidence_receipts", Store._bind_all(vals), "ignore");
    }

    evidence(tenant_id, run_id) {
      const [t, r0] = Store._bind_all([[tenant_id, T], [run_id, T]]);
      /* SQLite scans the (tenant_id, run_id, receipt_id) index, then sorts stably by observed_at */
      return this._find("evidence_receipts", (x) => sql_eq(x[0], t) && sql_eq(x[2], r0))
        .sort((a, b) => cmp_sql(a[10], b[10]) || cmp_sql(a[1], b[1]))
        .map((r) => {
          const d = this._obj("evidence_receipts", r);
          d.subject = JSON.parse(d.subject);
          return d;
        });
    }

    /** Invalidate a receipt. Pass ``run_id`` to scope it to one run (receipt ids are unique per run). */
    invalidate_evidence(tenant_id, receipt_id, reason, now, ...rest) {
      const o = opts(rest, ["run_id"], "invalidate_evidence");
      return this._tx(() => {
        const pairs = [[now, R], [reason, T], [tenant_id, T], [receipt_id, T]];
        if (o.run_id !== null) pairs.push([o.run_id, T]);
        const [n, why, t, rid, r0] = Store._bind_all(pairs);
        this._update("evidence_receipts", (x) => sql_eq(x[0], t) && sql_eq(x[1], rid) && x[11] === null &&
          (o.run_id === null || sql_eq(x[2], r0)), () => ({ invalidated_at: n, invalidation_reason: why }));
        return null;
      });
    }

    /* ---- traces / proposals -------------------------------------------------------------------------- */
    put_trace(trace_id, sha, body, now) {
      return this._tx(() => {
        this._insert("trace_blobs", Store._bind_all([[trace_id, T], [sha, T], [body, T], [now, R]]), "ignore");
        return null;
      });
    }

    trace_body(trace_id) {
      const k = bind(trace_id, T, 1);
      const r = this._first("trace_blobs", (x) => sql_eq(x[0], k));
      return r ? r[2] : null;
    }

    put_proposal(pid, parent, cand, status, body, now) {
      return this._tx(() => {
        this._insert("update_proposals", Store._bind_all([[pid, T], [parent, T], [cand, T], [status, T], [_j(body), T], [now, R]]), "replace");
        return null;
      });
    }

    /** JS-only reader for update_proposals (Python reads it with raw SQL): rows in table order. */
    proposals() {
      return this._rows("update_proposals").map((r) => {
        const d = this._obj("update_proposals", r);
        d.body = JSON.parse(d.body);
        return d;
      });
    }

    archive(skill_id, ...rest) {
      const o = opts(rest, ["version"], "archive");
      const s = bind(skill_id, T, 1);
      let r;
      if (o.version === null) {
        const rows = this._find("trace_archive_manifests", (x) => sql_eq(x[0], s)).sort((a, b) => cmp_sql(b[1], a[1]));
        r = rows.length ? rows[0] : null;
      } else {
        const v = bind(o.version, I, 2);
        r = this._first("trace_archive_manifests", (x) => sql_eq(x[0], s) && sql_eq(x[1], v));
      }
      return r ? JSON.parse(r[3]) : null;
    }
  }
  store.Store = Store;

  /* ------------------------------------------------------------------------------------------ */
  /* helpers                                                                                      */
  /* ------------------------------------------------------------------------------------------ */
  function py_str(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    if (typeof v === "number") return HX.canonical.py_number(v);
    if (typeof v === "string") return v;
    return repr(v);
  }
  function py_num(v) {
    if (typeof v === "boolean") return v ? 1 : 0;
    if (typeof v === "number") return v;
    throw pyerr("TypeError", "'>' not supported between instances of 'float' and '" + type_name(v) + "'");
  }
  function py_add(a, b) {
    const na = typeof a === "number" || typeof a === "boolean", nb = typeof b === "number" || typeof b === "boolean";
    if (na && nb) return Number(a) + Number(b);
    if (typeof a === "string" && typeof b === "string") return a + b;
    throw pyerr("TypeError", "unsupported operand type(s) for +: '" + type_name(a) + "' and '" + type_name(b) + "'");
  }
  function event_type(v) {
    /* the run_events.type column is never read back; SQLite stores whatever binds */
    if (typeof v === "number" && !Number.isInteger(v)) return String(v);
    return v;
  }
  function manifest_with(manifest, version, artifact_hash) {
    if (!HX.util.is_plain_object(manifest)) {
      throw pyerr("TypeError", "'" + type_name(manifest) + "' object is not a mapping");
    }
    const out = {};
    for (const k of Object.keys(manifest)) Object.defineProperty(out, k, { value: manifest[k], enumerable: true, writable: true, configurable: true });
    out.version = version;
    out.artifact_hash = artifact_hash;
    return out;
  }

  /** Trailing optional parameters: positional values, or one plain options object (Python keywords). An object
   *  whose keys are not all parameter names is a positional value (Python binding then rejects it). */
  function opts(rest, names, fn) {
    const out = {};
    if (rest.length === 1 && HX.util.is_plain_object(rest[0]) && Object.keys(rest[0]).every((k) => names.indexOf(k) >= 0)) {
      for (const n of names) out[n] = hasOwn(rest[0], n) && rest[0][n] !== undefined ? rest[0][n] : null;
      return out;
    }
    if (rest.length > names.length) throw pyerr("TypeError", fn + "() takes too many positional arguments");
    names.forEach((n, i) => { out[n] = i < rest.length && rest[i] !== undefined ? rest[i] : null; });
    return out;
  }
  /** Keyword-only parameters given as one options object. */
  function kwopts(kw, names, fn) {
    const out = {};
    if (kw !== undefined && kw !== null) {
      if (!HX.util.is_plain_object(kw)) throw pyerr("TypeError", fn + "() takes keyword-only options as an object");
      for (const k of Object.keys(kw)) {
        if (names.indexOf(k) < 0) throw pyerr("TypeError", fn + "() got an unexpected keyword argument " + repr(k));
      }
    }
    for (const n of names) out[n] = kw && hasOwn(kw, n) && kw[n] !== undefined ? kw[n] : null;
    return out;
  }
  /** All-keyword-only methods (publish_admission, append_archive_manifest): every name is required. */
  function kwargs(kw, names, fn) {
    if (!HX.util.is_plain_object(kw)) throw pyerr("TypeError", fn + "() takes keyword arguments as an object");
    for (const k of Object.keys(kw)) {
      if (names.indexOf(k) < 0) throw pyerr("TypeError", fn + "() got an unexpected keyword argument " + repr(k));
    }
    const missing = names.filter((n) => !hasOwn(kw, n) || kw[n] === undefined);
    if (missing.length) {
      throw pyerr("TypeError", fn + "() missing " + missing.length + " required keyword-only argument" +
        (missing.length > 1 ? "s" : "") + ": " + missing.map((m) => "'" + m + "'").join(", "));
    }
    return kw;
  }

  function parse_snapshot(json) {
    const bad = (m) => pyerr("ValueError", "invalid store snapshot: " + m);
    const snap = typeof json === "string" ? JSON.parse(json) : json;
    if (!HX.util.is_plain_object(snap) || snap.format !== store.SNAPSHOT_FORMAT) throw bad("format");
    if (snap.schema_version !== store.SCHEMA_VERSION) throw bad("schema_version " + String(snap.schema_version));
    if (!HX.util.is_plain_object(snap.tables)) throw bad("tables");
    for (const k of Object.keys(snap.tables)) if (!hasOwn(SCHEMA, k)) throw bad("unknown table " + k);
    const db = { tables: {} };
    for (const name of Object.keys(SCHEMA)) db.tables[name] = [];
    const s0 = Store._over(db, ":memory:");
    for (const name of Object.keys(SCHEMA)) {
      const s = SCHEMA[name];
      const rows = hasOwn(snap.tables, name) ? snap.tables[name] : [];
      if (!Array.isArray(rows)) throw bad(name + " rows");
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== s.cols.length) throw bad(name + " row shape");
        row.forEach((v, i) => {
          const aff = s.cols[i][1];
          const ok = v === null || (aff === T ? typeof v === "string" : typeof v === "number" && Number.isFinite(v));
          if (!ok) throw bad(name + "." + s.cols[i][0] + " value");
        });
        try {
          s0._insert(name, row.slice(), "abort");
        } catch (e) {
          throw bad(name + ": " + e.message);
        }
      }
    }
    if (!db.tables.schema_migrations.length) db.tables.schema_migrations.push([store.SCHEMA_VERSION]);
    return db;
  }

  /** ``open_store(url_or_path)``: ``:memory:``, ``sqlite:...`` URLs and bare paths open a Store; PostgreSQL URLs
   *  are not available in the browser (ValueError). */
  store.open_store = function (url_or_path) {
    const s = String(url_or_path);
    if (s.startsWith("postgresql://") || s.startsWith("postgres://")) {
      throw pyerr("ValueError", "PostgreSQL stores are not available in the browser port (" + repr(s) + ")");
    }
    if (s.startsWith("sqlite:")) {
      const rest = s.slice("sqlite:".length);
      if (["", "//", "///", "///:memory:", "//:memory:"].indexOf(rest) >= 0) return new Store(":memory:");
      if (!rest.startsWith("///")) {
        throw pyerr("ValueError", "unsupported sqlite URL " + repr(s) + " (use sqlite:///relative.db or sqlite:////abs.db)");
      }
      return new Store(rest.slice(3));
    }
    if (s.indexOf("://") >= 0) {
      throw pyerr("ValueError", "unsupported store URL scheme in " + repr(s) + " (use sqlite:/// or postgresql://)");
    }
    return new Store(s);
  };
})(globalThis.HX = globalThis.HX || {});
