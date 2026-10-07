/* Port of hexis_service/artifacts/package.py (HX.pkg) and hexis_service/tools/catalog.py (HX.catalog).
 *
 * ``hexis-production-package/1``: the versioned wrapper around an efsm-v1 machine. Every model is
 * normalized like ``Model.model_validate(obj).model_dump(mode="json", by_alias=True)`` by the pydantic
 * emulation in 25_efsm.js (HX.efsm.pyd). Hashes use the model-aware canonical serializer, so integral
 * values of float fields (``budgets.max_spend_usd``, machine thresholds, judge ``error_rate``) hash exactly
 * like Python (``2`` in a float field is ``2.0``).
 *
 * Also defined here because the fixture needs them: ``DeploymentPolicy`` and ``SkillSource`` (Python:
 * compiler/compile.py).
 *
 * ``HX.catalog.check_schemas`` is never more lenient than python-jsonschema's ``check_schema``: it adds the
 * metaschema rules HX.jsonschema does not check, and validates every ``pattern`` and ``patternProperties``
 * key with ``HX.catalog.py_regex_check``, a port of CPython 3.12's ``re`` parser (``re.compile`` acceptance).
 */
(function (HX) {
  "use strict";
  const pkg = (HX.pkg = HX.pkg || {});
  const catalog = (HX.catalog = HX.catalog || {});
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  pkg.PACKAGE_SCHEMA = "hexis-production-package/1";
  pkg.HASHED_FIELDS = ["package_schema", "machine", "source_manifest", "compiler_manifest", "contracts", "execution_policy"];
  pkg.OWNERS = ["model", "tool", "user", "engine", "task"];
  pkg.TERMINAL_CATEGORIES = ["verified", "unverified", "fallback"];
  pkg.CLASSIFICATIONS = ["executable_control", "state_local_knowledge", "external_precondition", "unsupported", "non_material"];
  pkg.FALLBACK_MODES = ["stop_for_review", "sandbox_interpret"];
  pkg.INTERACTION_TYPES = ["input", "approval"];
  pkg.UPSTREAM_REFERENCE = "Worldbuilder013/HEXIS@96be2719ee79fc5071dc7eb2aeed816dc03aaa6c (format reference only)";

  catalog.EFFECTS = ["read", "pure", "idempotent_write", "reconciliable_write", "non_idempotent_write"];
  catalog.WRITE_EFFECTS = ["idempotent_write", "reconciliable_write", "non_idempotent_write"];

  /** Package / sub-model validation failure (Python: pydantic.ValidationError). */
  class PackageError extends HX.HXError {
    constructor(message, errors, model) {
      super("PACKAGE_INVALID", message, { errors: errors || [], model: model || "MachinePackage" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "MachinePackage";
    }
  }
  pkg.PackageError = PackageError;

  /** Tool catalog validation failure (Python: pydantic.ValidationError). */
  class CatalogError extends HX.HXError {
    constructor(message, errors, model) {
      super("CATALOG_INVALID", message, { errors: errors || [], model: model || "ToolCatalog" });
      this.message = message;
      this.errors = errors || [];
      this.model = model || "ToolCatalog";
    }
  }
  catalog.CatalogError = CatalogError;

  /* ---- model specs (plain data interpreted by HX.efsm.pyd at call time) ---- */
  const T = {
    str: { k: "str" }, int: { k: "int" }, float: { k: "float" }, bool: { k: "bool" }, any: { k: "any" },
    dict: { k: "dict" },
    list: (of) => ({ k: "list", of }),
    map: (of) => ({ k: "map", of, ordered: true }),
    lit: (...values) => ({ k: "lit", values }),
    opt: (of) => ({ k: "opt", of }),
    model: (m) => ({ k: "model", m }),
  };
  function F(name, type, opts) {
    opts = opts || {};
    const key = opts.alias || name;
    const f = { name, type, key, lookup: opts.lookup || [key] };
    if (hasOwn(opts, "default")) f.default = opts.default;
    else if (opts.factory) f.factory = opts.factory;
    else if (opts.model_default) f.model_default = true;
    else f.required = true;
    return f;
  }
  const emptyMap = () => Object.create(null);
  const MODELS = (pkg.MODELS = Object.create(null));
  function model(name, fields, opts) {
    const m = Object.assign({ name, fields, extra: "forbid" }, opts || {});
    MODELS[name] = m;
    return m;
  }
  const M = (name) => () => MODELS[name];

  model("ClauseRef", [
    F("id", T.str), F("start", T.int), F("end", T.int), F("heading", T.str, { default: "" }), F("text", T.str),
    F("sha256", T.str),
  ]);
  model("SourceManifest", [
    F("skill_path", T.str, { default: "" }),
    F("skill_sha256", T.str),
    F("resources", T.map(T.str), { factory: emptyMap }),
    F("clauses", T.list(T.model(M("ClauseRef"))), { default: [] }),
    F("tool_catalog_sha256", T.str),
    F("input_contract_sha256", T.str, { default: "" }),
    F("deployment_policy_sha256", T.str, { default: "" }),
  ]);
  model("CompilerManifest", [
    F("compiler", T.str),
    F("compiler_commit", T.str, { default: "unknown" }),
    F("prompts_sha256", T.str, { default: "" }),
    F("model_id", T.str),
    F("model_settings", T.dict, { default: {} }),
    F("validator_version", T.str),
    F("normalizer_version", T.str),
    F("upstream_reference", T.str, { default: pkg.UPSTREAM_REFERENCE }),
  ]);
  model("VariableContract", [
    F("owner", T.lit(...pkg.OWNERS)),
    F("schema_", T.dict, { alias: "schema", lookup: ["schema", "schema_"], default: {} }),
  ]);
  model("EvidenceRequirement", [F("claim", T.str), F("verifier_tool", T.str), F("subject_vars", T.list(T.str))]);
  model("TerminalContract", [
    F("category", T.lit(...pkg.TERMINAL_CATEGORIES)),
    F("evidence", T.list(T.model(M("EvidenceRequirement"))), { default: [] }),
    F("verification_scope", T.str, { default: "" }),
  ]);
  model("OrderingRequirement", [
    F("id", T.str), F("requires", T.list(T.str)), F("before", T.str),
    F("invalidated_by", T.list(T.str), { default: [] }), F("clause", T.str, { default: "" }),
  ]);
  model("InteractionContract", [
    F("type", T.lit(...pkg.INTERACTION_TYPES)),
    F("approves_state", T.str, { default: "" }),
    F("response_schema", T.dict, { default: {} }),
    F("required_role", T.str, { default: "" }),
  ]);
  model("ClauseCoverage", [
    F("classification", T.lit(...pkg.CLASSIFICATIONS)),
    F("justification", T.str),
    F("states", T.list(T.str), { default: [] }),
    F("critical", T.bool, { default: false }),
  ]);
  model("FieldScope", [F("variable", T.str), F("allowed_fields_from", T.str), F("field_key", T.str, { default: "field" })]);
  model("Contracts", [
    F("variables", T.map(T.model(M("VariableContract")))),
    F("field_scoped_writes", T.map(T.model(M("FieldScope"))), { factory: emptyMap }),
    F("task_input_schema", T.dict, { default: {} }),
    F("terminals", T.map(T.model(M("TerminalContract")))),
    F("ordering", T.list(T.model(M("OrderingRequirement"))), { default: [] }),
    F("interactions", T.map(T.model(M("InteractionContract"))), { factory: emptyMap }),
    F("clause_coverage", T.map(T.model(M("ClauseCoverage"))), { factory: emptyMap }),
    F("explained_unreachable", T.map(T.str), { factory: emptyMap }),
  ]);
  model("Budgets", [
    F("max_steps", T.int, { default: 64 }),
    F("max_tool_calls", T.int, { default: 32 }),
    F("max_model_calls", T.int, { default: 16 }),
    F("max_tokens", T.int, { default: 200000 }),
    F("max_elapsed_s", T.int, { default: 7 * 24 * 3600 }),
    F("max_spend_usd", T.opt(T.float), { default: null }),
  ]);
  model("ExecutionPolicy", [
    F("capability_ceiling", T.list(T.str)),
    F("fallback_mode", T.lit(...pkg.FALLBACK_MODES), { default: "stop_for_review" }),
    F("budgets", T.model(M("Budgets")), { model_default: true }),
    F("structured_output_repairs", T.int, { default: 1 }),
    F("transport_retries", T.int, { default: 2 }),
    F("approval_expiry_s", T.int, { default: 24 * 3600 }),
    F("max_loop_bound", T.int, { default: 3 }),
    F("write_workflow", T.bool, { default: true }),
  ]);
  model("ValidationManifest", [
    F("profile", T.str, { default: "" }),
    F("report_digest", T.str, { default: "" }),
    F("passed", T.bool, { default: false }),
    F("findings", T.list(T.dict), { default: [] }),
    F("replay_archive_digest", T.str, { default: "" }),
    F("unresolved_limitations", T.list(T.str), { default: [] }),
  ]);
  model("Lineage", [
    F("parent_hash", T.opt(T.str), { default: null }),
    F("changes", T.list(T.dict), { default: [] }),
    F("trace_ids", T.list(T.str), { default: [] }),
  ]);
  model("AdmissionRecord", [
    F("artifact_hash", T.str), F("environment", T.str), F("approver", T.str), F("admitted_at", T.str),
    F("validation_report_digest", T.str), F("replay_archive_digest", T.str), F("key_id", T.str),
    F("signature", T.str, { default: "" }),
  ]);
  model("MachinePackage", [
    F("package_schema", T.lit(pkg.PACKAGE_SCHEMA), { default: pkg.PACKAGE_SCHEMA }),
    F("machine", T.model(() => HX.efsm.MODELS.Machine)),
    F("artifact_hash", T.str, { default: "" }),
    F("source_manifest", T.model(M("SourceManifest"))),
    F("compiler_manifest", T.model(M("CompilerManifest"))),
    F("contracts", T.model(M("Contracts"))),
    F("execution_policy", T.model(M("ExecutionPolicy"))),
    F("validation_manifest", T.model(M("ValidationManifest")), { model_default: true }),
    F("lineage", T.model(M("Lineage")), { model_default: true }),
    F("admission", T.opt(T.model(M("AdmissionRecord"))), { default: null }),
  ]);
  /* compiler/compile.py models used by the fixture and the compiler port */
  model("DeploymentPolicy", [
    F("environment", T.str, { default: "sandbox" }),
    F("execution_policy", T.model(M("ExecutionPolicy"))),
    F("task_input_schema", T.dict),
    F("profile", T.str, { default: "production" }),
  ]);
  model("SkillSource", [
    F("path", T.str, { default: "" }),
    F("text", T.str),
    F("resources", T.map(T.str), { factory: emptyMap }),
  ]);
  /* the hash payload: MachinePackage restricted to HASHED_FIELDS (typed for float fields) */
  const HASH_PAYLOAD_TYPE = T.model(() => {
    if (!MODELS._HashPayload) {
      Object.defineProperty(MODELS, "_HashPayload", {
        value: { name: "HashPayload", extra: "forbid",
                 fields: MODELS.MachinePackage.fields.filter((f) => pkg.HASHED_FIELDS.indexOf(f.name) >= 0) },
        enumerable: false,
      });
    }
    return MODELS._HashPayload;
  });

  /* catalog models */
  const CMODELS = (catalog.MODELS = Object.create(null));
  CMODELS.ToolSpec = { name: "ToolSpec", extra: "forbid", fields: [
    F("name", T.str), F("version", T.str), F("description", T.str, { default: "" }),
    F("input_schema", T.dict), F("output_schema", T.dict), F("effect", T.lit(...catalog.EFFECTS)),
    F("capability", T.str), F("verifier_claims", T.list(T.str), { default: [] }),
    F("business_reference_field", T.str, { default: "" }),
  ] };
  CMODELS.ToolCatalog = { name: "ToolCatalog", extra: "forbid", fields: [
    F("catalog_id", T.str), F("version", T.str), F("tools", T.map(T.model(() => CMODELS.ToolSpec))),
  ] };

  /** Model handle whose methods use the engine at call time. */
  function api(spec, ErrCls) {
    const type = { k: "model", m: spec };
    return {
      name: spec.name,
      spec,
      model_fields: spec.fields.map((f) => f.name),
      model_validate(value) { return HX.efsm.pyd.model_validate(spec, value, ErrCls); },
      canonical_text(value) { return HX.efsm.pyd.canonical_text(type, HX.efsm.pyd.model_validate(spec, value, ErrCls)); },
      digest(value) { return HX.efsm.pyd.digest(type, HX.efsm.pyd.model_validate(spec, value, ErrCls)); },
    };
  }
  for (const name of Object.keys(MODELS)) pkg[name] = api(MODELS[name], PackageError);
  catalog.ToolSpec = api(CMODELS.ToolSpec, CatalogError);
  catalog.ToolCatalog = api(CMODELS.ToolCatalog, CatalogError);

  /* ============================================================================================ */
  /* MachinePackage methods                                                                       */
  /* ============================================================================================ */

  /** ``MachinePackage.model_validate(obj).model_dump(mode="json", by_alias=True)`` (a new object). */
  pkg.normalize_package = function (obj) {
    return pkg.MachinePackage.model_validate(obj);
  };
  /** ``MachinePackage.from_json(data)`` */
  pkg.from_json = pkg.normalize_package;
  /** ``MachinePackage.to_json()``: a fresh normalized dump. */
  pkg.to_json = pkg.normalize_package;

  /** Sub-model normalizers used by the compiler/update ports. */
  pkg.normalize_contracts = (obj) => pkg.Contracts.model_validate(obj);
  pkg.normalize_execution_policy = (obj) => pkg.ExecutionPolicy.model_validate(obj);
  pkg.normalize_admission_record = (obj) => pkg.AdmissionRecord.model_validate(obj);

  function payload_of(full) {
    const out = {};
    for (const k of pkg.HASHED_FIELDS) out[k] = full[k];
    return out;
  }
  const hash_of_normalized = (full) => HX.efsm.pyd.digest(HASH_PAYLOAD_TYPE, payload_of(full));

  /** ``hash_payload()``: the six hashed fields of the normalized dump, in HASHED_FIELDS order. */
  pkg.hash_payload = function (p) {
    return payload_of(pkg.normalize_package(p));
  };

  /** ``compute_hash()``: ``digest(hash_payload())`` with Python float typing. */
  pkg.compute_hash = function (p) {
    return hash_of_normalized(pkg.normalize_package(p));
  };

  /** ``sealed()``: a normalized copy with ``artifact_hash`` set to the computed hash. */
  pkg.sealed = function (p) {
    const out = pkg.normalize_package(p);
    out.artifact_hash = hash_of_normalized(out);
    return out;
  };

  /** ``verify_hash()``: true iff ``artifact_hash`` is set and equals the computed hash. */
  pkg.verify_hash = function (p) {
    const n = pkg.normalize_package(p);
    return !!n.artifact_hash && n.artifact_hash === hash_of_normalized(n);
  };

  /* ---- admission signatures (HMAC-SHA256 development signer) ---- */
  function signing_payload(rec) {
    const body = {};
    for (const k of Object.keys(rec)) if (k !== "signature") body[k] = rec[k];
    return HX.canonical.canonical_bytes(body);
  }

  /** ``sign_admission(rec, key)``: a normalized copy of ``rec`` with
   *  ``signature = "hmac-sha256:" + HMAC(key, canonical(record without signature))``.
   *  ``key``: string (UTF-8) or Uint8Array. */
  pkg.sign_admission = function (rec, key) {
    const r = pkg.AdmissionRecord.model_validate(rec);
    r.signature = "hmac-sha256:" + HX.canonical.hmac_sha256_hex(key, signing_payload(r));
    return r;
  };

  /** ``verify_admission(rec, key)``. A signature with non-ASCII characters is reported as invalid
   *  (Python's ``hmac.compare_digest`` raises TypeError there). */
  pkg.verify_admission = function (rec, key) {
    const r = pkg.AdmissionRecord.model_validate(rec);
    const expected = "hmac-sha256:" + HX.canonical.hmac_sha256_hex(key, signing_payload(r));
    if (/[^\x00-\x7f]/.test(r.signature)) return false;
    return HX.canonical.compare_digest(expected, r.signature);
  };

  /** ``package_digest_of(data)``: plain canonical digest. */
  pkg.package_digest_of = function (data) {
    return HX.canonical.digest(data);
  };

  /* ============================================================================================ */
  /* catalog                                                                                      */
  /* ============================================================================================ */

  /** ``ToolCatalog.model_validate(obj)`` dump; ``tools`` is a null-prototype map. Throws CatalogError. */
  catalog.load_catalog = function (obj) {
    return catalog.ToolCatalog.model_validate(obj);
  };

  /** ``ToolCatalog.digest()``: ``digest(model_dump(mode="json"))`` of the normalized catalog. */
  catalog.digest = function (c) {
    return catalog.ToolCatalog.digest(c);
  };

  /** ``ToolCatalog.get(name)``: the tool spec or null. */
  catalog.get = function (c, name) {
    return typeof name === "string" && c && c.tools && hasOwn(c.tools, name) ? c.tools[name] : null;
  };

  /** ``ToolSpec.is_write`` */
  catalog.is_write = function (spec) {
    return catalog.WRITE_EFFECTS.indexOf(spec.effect) >= 0;
  };

  /* ============================================================================================ */
  /* Python ``re`` acceptance                                                                      */
  /* ============================================================================================ */
  /* python-jsonschema checks the metaschema's ``format: "regex"`` (``pattern`` values and
   * ``patternProperties`` keys) with ``re.compile(p)``. This is a port of CPython 3.12's
   * re/_parser.py ``parse()`` plus the checks re/_compiler.py makes on the parsed tree (look-behind
   * width, template flag) and ``fix_flags``. It answers one question: does ``re.compile(p)`` raise?
   * The set/branch optimizations and the unpacking of non-capturing groups are left out: they change
   * neither acceptance nor widths. Stricter than Python (documented in deviations/models.md):
   *  - ``\N{NAME}`` escapes are rejected (no Unicode name database);
   *  - group names must be ASCII identifiers (Python: ``str.isidentifier()``);
   *  - groups nested deeper than PY_RE_MAX_NESTING are rejected. Python raises RecursionError at
   *    about 489 levels minus the caller's stack depth (about 8 frames per enclosing schema level).
   * Error messages follow Python's wording; positions are code-point offsets. */
  const PY_RE = {
    MAXREPEAT: 4294967295, /* _sre.MAXREPEAT */
    MAXGROUPS: 1073741823, /* _sre.MAXGROUPS */
    MAXCODE: 4294967295, /* (1 << 32) - 1 */
    MAXWIDTH: 18446744073709551616, /* 1 << 64, exact as a double */
    MAX_NESTING: 100,
    MAX_STR_DIGITS: 4300, /* int() refuses longer digit strings (ValueError) */
  };
  catalog.PY_RE_MAX_NESTING = PY_RE.MAX_NESTING;

  /** ``re.error`` (or the OverflowError / ValueError / RecursionError ``re.compile`` lets escape). */
  class PyReError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind || "error";
    }
  }
  const RE_F = { TEMPLATE: 1, IGNORECASE: 2, LOCALE: 4, MULTILINE: 8, DOTALL: 16, UNICODE: 32, VERBOSE: 64, DEBUG: 128,
    ASCII: 256 };
  const RE_FLAGS = { i: RE_F.IGNORECASE, L: RE_F.LOCALE, m: RE_F.MULTILINE, s: RE_F.DOTALL, x: RE_F.VERBOSE,
    a: RE_F.ASCII, t: RE_F.TEMPLATE, u: RE_F.UNICODE };
  const RE_TYPE_FLAGS = RE_F.ASCII | RE_F.LOCALE | RE_F.UNICODE;
  const RE_GLOBAL_FLAGS = RE_F.DEBUG | RE_F.TEMPLATE;
  const RE_SPECIAL = ".\\[{()*+?^$|", RE_REPEAT_CHARS = "*+?{";
  const RE_DIGITS = "0123456789", RE_OCT = "01234567", RE_HEX = "0123456789abcdefABCDEF", RE_WS = " \t\n\r\v\f";
  const RE_ESCAPES = { "\\a": 7, "\\b": 8, "\\f": 12, "\\n": 10, "\\r": 13, "\\t": 9, "\\v": 11, "\\\\": 92 };
  const RE_CATEGORIES = { "\\A": "AT", "\\b": "AT", "\\B": "AT", "\\d": "IN", "\\D": "IN", "\\s": "IN", "\\S": "IN",
    "\\w": "IN", "\\W": "IN", "\\Z": "AT" };
  const RE_REPEAT_OPS = ["MAX_REPEAT", "MIN_REPEAT", "POSSESSIVE_REPEAT"];
  const RE_UNIT_OPS = ["ANY", "RANGE", "IN", "LITERAL", "NOT_LITERAL", "CATEGORY"];
  /* Python ``tok in "<ascii chars>"`` for a token: escape tokens and astral characters never match. */
  const tin = (tok, chars) => tok !== null && tok.length === 1 && chars.indexOf(tok) >= 0;
  const is_flag_char = (tok) => tok !== null && hasOwn(RE_FLAGS, tok);
  const ascii_letter = (c) => /^[A-Za-z]$/.test(c);
  const is_alpha = (c) => /^\p{L}$/u.test(c);
  const repr = (v) => HX.util.py_repr(v);
  const plen = (t) => Array.from(t).length; /* Python len() of a str: code points */
  /** re.error(msg, pattern, pos): "msg at position N", plus " (line L, column C)" when the pattern has a newline. */
  function re_error(msg, cps, pos) {
    let out = msg + " at position " + pos;
    if (cps.indexOf("\n") >= 0) {
      let line = 1, last = -1;
      for (let k = 0; k < pos && k < cps.length; k++) if (cps[k] === "\n") { line++; last = k; }
      out += " (line " + line + ", column " + (pos - last) + ")";
    }
    return new PyReError(out);
  }

  /** re/_parser.py Tokenizer over code points. A token is one code point or a backslash pair. */
  class ReTokenizer {
    constructor(text) {
      this.cps = Array.from(text);
      this.index = 0;
      this.next = null;
      this.next_len = 0;
      this._advance();
    }
    _advance() {
      let index = this.index;
      if (index >= this.cps.length) {
        this.next = null;
        this.next_len = 0;
        return;
      }
      let ch = this.cps[index];
      let n = 1;
      if (ch === "\\") {
        index += 1;
        if (index >= this.cps.length) {
          throw re_error("bad escape (end of pattern)", this.cps, this.cps.length - 1);
        }
        ch += this.cps[index];
        n = 2;
      }
      this.index = index + 1;
      this.next = ch;
      this.next_len = n;
    }
    match(ch) {
      if (ch === this.next) {
        this._advance();
        return true;
      }
      return false;
    }
    get() {
      const t = this.next;
      this._advance();
      return t;
    }
    getwhile(n, chars) {
      let out = "";
      for (let k = 0; k < n; k++) {
        const c = this.next;
        if (!tin(c, chars)) break;
        out += c;
        this._advance();
      }
      return out;
    }
    getuntil(terminator, name) {
      let out = "";
      while (true) {
        const c = this.next;
        this._advance();
        if (c === null) {
          if (!out) throw this.error("missing " + name);
          throw this.error("missing " + terminator + ", unterminated name", plen(out));
        }
        if (c === terminator) {
          if (!out) throw this.error("missing " + name, 1);
          break;
        }
        out += c;
      }
      return out;
    }
    tell() {
      return this.index - this.next_len;
    }
    seek(index) {
      this.index = index;
      this._advance();
    }
    /** Python ``Tokenizer.error(msg, offset)``: the position is ``tell() - offset``. */
    error(msg, offset) {
      return re_error(msg, this.cps, this.tell() - (offset || 0));
    }
    checkgroupname(name, offset) {
      /* Python: str.isidentifier(); the port accepts ASCII identifiers only (stricter) */
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw this.error("bad character in group name " + repr(name), plen(name) + offset);
      }
    }
  }

  class ReState {
    constructor() {
      this.flags = 0;
      this.groupdict = new Map();
      this.groupwidths = [null]; /* group 0 */
      this.lookbehindgroups = null;
      this.grouprefpos = new Map();
    }
    get groups() {
      return this.groupwidths.length;
    }
    opengroup(name, src) {
      const gid = this.groups;
      this.groupwidths.push(null);
      if (this.groups > PY_RE.MAXGROUPS) throw src.error("too many groups");
      if (name !== null) {
        if (this.groupdict.has(name)) {
          throw src.error("redefinition of group name " + repr(name) + " as group " + gid + "; was group " +
            this.groupdict.get(name), plen(name) + 1);
        }
        this.groupdict.set(name, gid);
      }
      return gid;
    }
    closegroup(gid, p) {
      this.groupwidths[gid] = p.getwidth();
    }
    checkgroup(gid) {
      return gid < this.groups && this.groupwidths[gid] !== null;
    }
    checklookbehindgroup(gid, src) {
      if (this.lookbehindgroups !== null) {
        if (!this.checkgroup(gid)) throw src.error("cannot refer to an open group");
        if (gid >= this.lookbehindgroups) {
          throw src.error("cannot refer to group defined in the same lookbehind subpattern");
        }
      }
    }
  }

  /** re/_parser.py SubPattern: ``data`` holds [op, ...args] entries. */
  class ReSubPattern {
    constructor(state, data) {
      this.state = state;
      this.data = data || [];
      this.width = null;
    }
    /** (min, max) match width, capped at MAXWIDTH like Python. Doubles are exact below 2^53, and every
     *  comparison Python makes on widths (> MAXCODE, lo != hi) gets the same answer above it. */
    getwidth() {
      if (this.width !== null) return this.width;
      let lo = 0, hi = 0;
      for (const op of this.data) {
        const kind = op[0];
        if (kind === "BRANCH") {
          let i = PY_RE.MAXWIDTH, j = 0;
          for (const b of op[1]) {
            const [l, h] = b.getwidth();
            i = Math.min(i, l);
            j = Math.max(j, h);
          }
          lo += i;
          hi += j;
        } else if (kind === "ATOMIC_GROUP") {
          const [i, j] = op[1].getwidth();
          lo += i;
          hi += j;
        } else if (kind === "SUBPATTERN") {
          const [i, j] = op[4].getwidth();
          lo += i;
          hi += j;
        } else if (RE_REPEAT_OPS.indexOf(kind) >= 0) {
          const [i, j] = op[3].getwidth();
          lo += i * op[1];
          if (op[2] === PY_RE.MAXREPEAT && j) hi = PY_RE.MAXWIDTH;
          else hi += j * op[2];
        } else if (RE_UNIT_OPS.indexOf(kind) >= 0) {
          lo += 1;
          hi += 1;
        } else if (kind === "GROUPREF") {
          const [i, j] = this.state.groupwidths[op[1]];
          lo += i;
          hi += j;
        } else if (kind === "GROUPREF_EXISTS") {
          let [i, j] = op[2].getwidth();
          if (op[3] !== null) {
            const [l, h] = op[3].getwidth();
            i = Math.min(i, l);
            j = Math.max(j, h);
          } else {
            i = 0;
          }
          lo += i;
          hi += j;
        }
      }
      this.width = [Math.min(lo, PY_RE.MAXWIDTH), Math.min(hi, PY_RE.MAXWIDTH)];
      return this.width;
    }
  }

  function re_int(digits) {
    if (digits.length > PY_RE.MAX_STR_DIGITS) {
      throw new PyReError("Exceeds the limit (4300 digits) for integer string conversion: value has " + digits.length +
        " digits; use sys.set_int_max_str_digits() to increase the limit", "ValueError");
    }
    return Number(digits); /* exact below 2^53; larger values only ever compare >= MAXREPEAT / MAXGROUPS */
  }

  function re_hex_escape(src, esc, c) {
    const n = c === "x" ? 2 : c === "u" ? 4 : 8;
    esc += src.getwhile(n, RE_HEX);
    if (esc.length !== n + 2) throw src.error("incomplete escape " + esc, plen(esc));
    const v = parseInt(esc.slice(2), 16);
    if (c === "U" && v > 0x10ffff) {
      /* chr(c): ValueError (caught: "bad escape") up to INT_MAX, OverflowError (escapes) above */
      if (v > 0x7fffffff) throw new PyReError("Python int too large to convert to C int", "OverflowError");
      throw src.error("bad escape " + esc, plen(esc));
    }
    return ["LITERAL", v];
  }

  /** _class_escape: an escape inside a character set. */
  function re_class_escape(src, esc) {
    if (hasOwn(RE_ESCAPES, esc)) return ["LITERAL", RE_ESCAPES[esc]];
    if (hasOwn(RE_CATEGORIES, esc) && RE_CATEGORIES[esc] === "IN") return ["IN"];
    const c = esc.slice(1);
    if (c === "x" || c === "u" || c === "U") return re_hex_escape(src, esc, c);
    if (c === "N") throw src.error("bad escape " + esc + " (named Unicode escapes are not supported by the JS port)", plen(esc));
    if (tin(c, RE_OCT)) {
      esc += src.getwhile(2, RE_OCT);
      const v = parseInt(esc.slice(1), 8);
      if (v > 0o377) throw src.error("octal escape value " + esc + " outside of range 0-0o377", plen(esc));
      return ["LITERAL", v];
    }
    if (tin(c, RE_DIGITS) || ascii_letter(c)) throw src.error("bad escape " + esc, plen(esc));
    return ["LITERAL", c.codePointAt(0)];
  }

  /** _escape: an escape outside character sets (categories, group references, octal escapes). */
  function re_escape(src, esc, state) {
    if (hasOwn(RE_CATEGORIES, esc)) return [RE_CATEGORIES[esc]];
    if (hasOwn(RE_ESCAPES, esc)) return ["LITERAL", RE_ESCAPES[esc]];
    const c = esc.slice(1);
    if (c === "x" || c === "u" || c === "U") return re_hex_escape(src, esc, c);
    if (c === "N") throw src.error("bad escape " + esc + " (named Unicode escapes are not supported by the JS port)", plen(esc));
    if (c === "0") {
      esc += src.getwhile(2, RE_OCT);
      return ["LITERAL", parseInt(esc.slice(1), 8)];
    }
    if (tin(c, RE_DIGITS)) {
      /* octal escape *or* decimal group reference */
      if (tin(src.next, RE_DIGITS)) {
        esc += src.get();
        if (tin(esc[1], RE_OCT) && tin(esc[2], RE_OCT) && tin(src.next, RE_OCT)) {
          esc += src.get();
          const v = parseInt(esc.slice(1), 8);
          if (v > 0o377) throw src.error("octal escape value " + esc + " outside of range 0-0o377", plen(esc));
          return ["LITERAL", v];
        }
      }
      const group = parseInt(esc.slice(1), 10);
      if (group < state.groups) {
        if (!state.checkgroup(group)) throw src.error("cannot refer to an open group", plen(esc));
        state.checklookbehindgroup(group, src);
        return ["GROUPREF", group];
      }
      throw src.error("invalid group reference " + group, plen(esc) - 1);
    }
    if (ascii_letter(c)) throw src.error("bad escape " + esc, plen(esc));
    return ["LITERAL", c.codePointAt(0)];
  }

  function re_check_depth(depth) {
    if (depth > PY_RE.MAX_NESTING) {
      throw new PyReError("groups nested deeper than " + PY_RE.MAX_NESTING + " levels (JS port limit; Python raises " +
        "RecursionError for deep nesting)", "RecursionError");
    }
  }

  /** _parse_sub: an alternation a|b|c. */
  function re_parse_sub(src, state, verbose, nested, depth) {
    re_check_depth(depth);
    const items = [];
    while (true) {
      items.push(re_parse(src, state, verbose, nested + 1, !nested && !items.length, depth));
      if (!src.match("|")) break;
      if (!nested) verbose = state.flags & RE_F.VERBOSE;
    }
    if (items.length === 1) return items[0];
    return new ReSubPattern(state, [["BRANCH", items]]);
  }

  /** _parse_flags: inline flags after "(?". Returns null for global flags, else [add, del]. */
  function re_parse_flags(src, state, ch) {
    let add = 0, del = 0;
    if (ch !== "-") {
      while (true) {
        const flag = RE_FLAGS[ch];
        if (ch === "L") throw src.error("bad inline flags: cannot use 'L' flag with a str pattern");
        add |= flag;
        if ((flag & RE_TYPE_FLAGS) && (add & RE_TYPE_FLAGS) !== flag) {
          throw src.error("bad inline flags: flags 'a', 'u' and 'L' are incompatible");
        }
        ch = src.get();
        if (ch === null) throw src.error("missing -, : or )");
        if (tin(ch, ")-:")) break;
        if (!is_flag_char(ch)) throw src.error(is_alpha(ch) ? "unknown flag" : "missing -, : or )", plen(ch));
      }
    }
    if (ch === ")") {
      state.flags |= add;
      return null;
    }
    if (add & RE_GLOBAL_FLAGS) throw src.error("bad inline flags: cannot turn on global flag", 1);
    if (ch === "-") {
      ch = src.get();
      if (ch === null) throw src.error("missing flag");
      if (!is_flag_char(ch)) throw src.error(is_alpha(ch) ? "unknown flag" : "missing flag", plen(ch));
      while (true) {
        const flag = RE_FLAGS[ch];
        if (flag & RE_TYPE_FLAGS) throw src.error("bad inline flags: cannot turn off flags 'a', 'u' and 'L'");
        del |= flag;
        ch = src.get();
        if (ch === null) throw src.error("missing :");
        if (ch === ":") break;
        if (!is_flag_char(ch)) throw src.error(is_alpha(ch) ? "unknown flag" : "missing :", plen(ch));
      }
    }
    if (del & RE_GLOBAL_FLAGS) throw src.error("bad inline flags: cannot turn off global flag", 1);
    if (add & del) throw src.error("bad inline flags: flag turned on and off", 1);
    return [add, del];
  }

  /** _parse: a sequence of items up to "|" or ")". */
  function re_parse(src, state, verbose, nested, first, depth) {
    re_check_depth(depth);
    const sp = new ReSubPattern(state);
    const data = sp.data;
    while (true) {
      let tok = src.next;
      if (tok === null) break;
      if (tin(tok, "|)")) break;
      src.get();
      if (verbose) {
        if (tin(tok, RE_WS)) continue;
        if (tok === "#") {
          while (true) {
            tok = src.get();
            if (tok === null || tok === "\n") break;
          }
          continue;
        }
      }
      if (tok[0] === "\\") {
        data.push(re_escape(src, tok, state));
      } else if (!tin(tok, RE_SPECIAL)) {
        data.push(["LITERAL", tok.codePointAt(0)]);
      } else if (tok === "[") {
        /* character set; its NOT_LITERAL/LITERAL/IN result is one unit of width */
        const here = src.tell() - 1;
        let set = 0;
        src.match("^");
        while (true) {
          const t = src.get();
          if (t === null) throw src.error("unterminated character set", src.tell() - here);
          let code1;
          if (t === "]" && set) break;
          else if (t[0] === "\\") code1 = re_class_escape(src, t);
          else code1 = ["LITERAL", t.codePointAt(0)];
          if (src.match("-")) {
            const that = src.get();
            if (that === null) throw src.error("unterminated character set", src.tell() - here);
            if (that === "]") {
              set += 2;
              break;
            }
            const code2 = that[0] === "\\" ? re_class_escape(src, that) : ["LITERAL", that.codePointAt(0)];
            if (code1[0] !== "LITERAL" || code2[0] !== "LITERAL" || code2[1] < code1[1]) {
              throw src.error("bad character range " + t + "-" + that, plen(t) + 1 + plen(that));
            }
          }
          set += 1;
        }
        data.push(["IN"]);
      } else if (tin(tok, RE_REPEAT_CHARS)) {
        const here = src.tell();
        let min, max;
        if (tok === "?") {
          min = 0;
          max = 1;
        } else if (tok === "*") {
          min = 0;
          max = PY_RE.MAXREPEAT;
        } else if (tok === "+") {
          min = 1;
          max = PY_RE.MAXREPEAT;
        } else {
          /* "{" */
          if (src.next === "}") {
            data.push(["LITERAL", 0x7b]);
            continue;
          }
          min = 0;
          max = PY_RE.MAXREPEAT;
          let lo = "", hi = "";
          while (tin(src.next, RE_DIGITS)) lo += src.get();
          if (src.match(",")) {
            while (tin(src.next, RE_DIGITS)) hi += src.get();
          } else {
            hi = lo;
          }
          if (!src.match("}")) {
            data.push(["LITERAL", 0x7b]);
            src.seek(here);
            continue;
          }
          if (lo) {
            min = re_int(lo);
            if (min >= PY_RE.MAXREPEAT) throw new PyReError("the repetition number is too large", "OverflowError");
          }
          if (hi) {
            max = re_int(hi);
            if (max >= PY_RE.MAXREPEAT) throw new PyReError("the repetition number is too large", "OverflowError");
            if (max < min) throw src.error("min repeat greater than max repeat", src.tell() - here);
          }
        }
        const last = data.length ? data[data.length - 1] : null;
        if (last === null || last[0] === "AT") throw src.error("nothing to repeat", src.tell() - here + plen(tok));
        if (RE_REPEAT_OPS.indexOf(last[0]) >= 0) throw src.error("multiple repeat", src.tell() - here + plen(tok));
        let item = new ReSubPattern(state, [last]);
        if (last[0] === "SUBPATTERN" && last[1] === null && !last[2] && !last[3]) item = last[4];
        let op = "MAX_REPEAT";
        if (src.match("?")) op = "MIN_REPEAT";
        else if (src.match("+")) op = "POSSESSIVE_REPEAT";
        data[data.length - 1] = [op, min, max, item];
      } else if (tok === ".") {
        data.push(["ANY"]);
      } else if (tok === "(") {
        const start = src.tell() - 1;
        let capture = true, atomic = false, name = null, add_flags = 0, del_flags = 0;
        if (src.match("?")) {
          let ch = src.get();
          if (ch === null) throw src.error("unexpected end of pattern");
          if (ch === "P") {
            if (src.match("<")) {
              name = src.getuntil(">", "group name");
              src.checkgroupname(name, 1);
            } else if (src.match("=")) {
              name = src.getuntil(")", "group name");
              src.checkgroupname(name, 1);
              const gid = state.groupdict.has(name) ? state.groupdict.get(name) : null;
              if (gid === null) throw src.error("unknown group name " + repr(name), plen(name) + 1);
              if (!state.checkgroup(gid)) throw src.error("cannot refer to an open group", plen(name) + 1);
              state.checklookbehindgroup(gid, src);
              data.push(["GROUPREF", gid]);
              continue;
            } else {
              ch = src.get();
              if (ch === null) throw src.error("unexpected end of pattern");
              throw src.error("unknown extension ?P" + ch, plen(ch) + 2);
            }
          } else if (ch === ":") {
            capture = false;
          } else if (ch === "#") {
            while (true) {
              if (src.next === null) throw src.error("missing ), unterminated comment", src.tell() - start);
              if (src.get() === ")") break;
            }
            continue;
          } else if (tin(ch, "=!<")) {
            let dir = 1, outer_lookbehind = null;
            if (ch === "<") {
              ch = src.get();
              if (ch === null) throw src.error("unexpected end of pattern");
              if (!tin(ch, "=!")) throw src.error("unknown extension ?<" + ch, plen(ch) + 2);
              dir = -1;
              outer_lookbehind = state.lookbehindgroups;
              if (outer_lookbehind === null) state.lookbehindgroups = state.groups;
            }
            const p = re_parse_sub(src, state, verbose, nested + 1, depth + 1);
            if (dir < 0 && outer_lookbehind === null) state.lookbehindgroups = null;
            if (!src.match(")")) throw src.error("missing ), unterminated subpattern", src.tell() - start);
            data.push([ch === "=" ? "ASSERT" : "ASSERT_NOT", dir, p]);
            continue;
          } else if (ch === "(") {
            /* conditional backreference group */
            const condname = src.getuntil(")", "group name");
            let condgroup;
            if (!/^[0-9]+$/.test(condname)) {
              src.checkgroupname(condname, 1);
              condgroup = state.groupdict.has(condname) ? state.groupdict.get(condname) : null;
              if (condgroup === null) throw src.error("unknown group name " + repr(condname), plen(condname) + 1);
            } else {
              condgroup = re_int(condname);
              if (!condgroup) throw src.error("bad group number", plen(condname) + 1);
              if (condgroup >= PY_RE.MAXGROUPS) throw src.error("invalid group reference " + condname.replace(/^0+(?=[0-9])/, ""), plen(condname) + 1);
              if (!state.grouprefpos.has(condgroup)) state.grouprefpos.set(condgroup, src.tell() - condname.length - 1);
            }
            state.checklookbehindgroup(condgroup, src);
            const item_yes = re_parse(src, state, verbose, nested + 1, false, depth + 1);
            let item_no = null;
            if (src.match("|")) {
              item_no = re_parse(src, state, verbose, nested + 1, false, depth + 1);
              if (src.next === "|") throw src.error("conditional backref with more than two branches");
            }
            if (!src.match(")")) throw src.error("missing ), unterminated subpattern", src.tell() - start);
            data.push(["GROUPREF_EXISTS", condgroup, item_yes, item_no]);
            continue;
          } else if (ch === ">") {
            capture = false;
            atomic = true;
          } else if (is_flag_char(ch) || ch === "-") {
            const flags = re_parse_flags(src, state, ch);
            if (flags === null) {
              if (!first || data.length) throw src.error("global flags not at the start of the expression", src.tell() - start);
              verbose = state.flags & RE_F.VERBOSE;
              continue;
            }
            add_flags = flags[0];
            del_flags = flags[1];
            capture = false;
          } else {
            throw src.error("unknown extension ?" + ch, plen(ch) + 1);
          }
        }
        const group = capture ? state.opengroup(name, src) : null;
        const sub_verbose = (verbose || (add_flags & RE_F.VERBOSE)) && !(del_flags & RE_F.VERBOSE);
        const p = re_parse_sub(src, state, sub_verbose, nested + 1, depth + 1);
        if (!src.match(")")) throw src.error("missing ), unterminated subpattern", src.tell() - start);
        if (group !== null) state.closegroup(group, p);
        if (atomic) data.push(["ATOMIC_GROUP", p]);
        else data.push(["SUBPATTERN", group, add_flags, del_flags, p]);
      } else if (tok === "^" || tok === "$") {
        data.push(["AT"]);
      } else {
        throw new Error("unsupported special character " + tok);
      }
    }
    return sp;
  }

  /** The checks re/_compiler.py makes while compiling the parsed tree (it visits every node). */
  function re_compile_check(data, flags) {
    for (const op of data) {
      const kind = op[0];
      if (RE_REPEAT_OPS.indexOf(kind) >= 0) {
        if (flags & RE_F.TEMPLATE) throw new PyReError("internal: unsupported template operator " + kind);
        re_compile_check(op[3].data, flags);
      } else if (kind === "SUBPATTERN") {
        re_compile_check(op[4].data, flags);
      } else if (kind === "ATOMIC_GROUP") {
        re_compile_check(op[1].data, flags);
      } else if (kind === "ASSERT" || kind === "ASSERT_NOT") {
        if (op[1] < 0) {
          const [lo, hi] = op[2].getwidth();
          if (lo > PY_RE.MAXCODE) throw new PyReError("looks too much behind");
          if (lo !== hi) throw new PyReError("look-behind requires fixed-width pattern");
        }
        re_compile_check(op[2].data, flags);
      } else if (kind === "BRANCH") {
        for (const b of op[1]) re_compile_check(b.data, flags);
      } else if (kind === "GROUPREF_EXISTS") {
        re_compile_check(op[2].data, flags);
        if (op[3] !== null && op[3].data.length) re_compile_check(op[3].data, flags);
      }
    }
  }

  /** Why ``re.compile(pattern)`` (CPython 3.12) raises, or null when it compiles. ``kind`` names the
   *  Python exception (``error`` = re.error); the message follows Python's wording. */
  catalog.py_regex_check = function (pattern) {
    if (typeof pattern !== "string") return { kind: "TypeError", message: "first argument must be string or compiled pattern" };
    try {
      const src = new ReTokenizer(pattern);
      const state = new ReState();
      const p = re_parse_sub(src, state, 0, 0, 0);
      /* fix_flags for a str pattern ((?L) is already refused by the flag parser) */
      if (!(state.flags & RE_F.ASCII)) state.flags |= RE_F.UNICODE;
      else if (state.flags & RE_F.UNICODE) throw new PyReError("ASCII and UNICODE flags are incompatible", "ValueError");
      if (src.next !== null) throw src.error("unbalanced parenthesis");
      for (const [g, pos] of state.grouprefpos) {
        if (g >= state.groups) throw re_error("invalid group reference " + g, src.cps, pos);
      }
      re_compile_check(p.data, state.flags);
      return null;
    } catch (e) {
      if (e instanceof PyReError) return { kind: e.kind, message: e.message };
      throw e;
    }
  };

  /** The message of ``py_regex_check`` or null. */
  catalog.py_regex_error = function (pattern) {
    const r = catalog.py_regex_check(pattern);
    return r === null ? null : r.message;
  };

  /** Problem with a regex in a schema, or null: Python ``re`` must accept it (python-jsonschema's
   *  check) and the JS engine must compile it with the ``u`` flag (the port validates with it). */
  function regex_problem(p, js_too) {
    const py = catalog.py_regex_error(p);
    if (py !== null) return "is not a valid Python regular expression (" + py + ")";
    if (js_too) {
      try {
        new RegExp(p, "u");
      } catch (e) {
        return "is not a valid regular expression for the JS port (u flag)";
      }
    }
    return null;
  }

  /* Draft 2020-12 metaschema rules that python-jsonschema's check_schema enforces and
   * HX.jsonschema.check_schema does not (so check_schemas is never more lenient than Python). */
  function metaschema_gaps(s, where, out) {
    if (!HX.util.is_plain_object(s)) return out;
    const has = (k) => hasOwn(s, k);
    if (has("type") && Array.isArray(s.type)) {
      if (!s.type.length) out.push(where + ": type must be a non-empty array");
      else if (new Set(s.type).size !== s.type.length) out.push(where + ": type entries must be unique");
    }
    if (has("required") && Array.isArray(s.required) && new Set(s.required).size !== s.required.length) {
      out.push(where + ": required entries must be unique");
    }
    if (has("multipleOf") && typeof s.multipleOf === "number" && !(s.multipleOf > 0)) out.push(where + ": multipleOf must be > 0");
    if (has("uniqueItems") && typeof s.uniqueItems !== "boolean") out.push(where + ": uniqueItems must be a boolean");
    for (const k of ["title", "description", "$comment", "format", "$schema"]) {
      if (has(k) && typeof s[k] !== "string") out.push(where + ": " + k + " must be a string");
    }
    /* metaschema pattern "^[^#]*#?$" under re.search: "$" also matches before a final "\n" */
    if (has("$id") && (typeof s.$id !== "string" || !/^[^#]*#?(?=\n?$)/.test(s.$id))) {
      out.push(where + ": $id must be a URI without fragment");
    }
    if (has("examples") && !Array.isArray(s.examples)) out.push(where + ": examples must be an array");
    for (const k of ["deprecated", "readOnly", "writeOnly"]) {
      if (has(k) && typeof s[k] !== "boolean") out.push(where + ": " + k + " must be a boolean");
    }
    /* (HX.jsonschema.check_schema already reports a pattern the JS engine cannot compile) */
    if (has("pattern") && typeof s.pattern === "string") {
      const why = regex_problem(s.pattern, false);
      if (why) out.push(where + ": pattern " + why);
    }
    if (has("patternProperties")) {
      if (!HX.util.is_plain_object(s.patternProperties)) out.push(where + ": patternProperties must be an object");
      else {
        for (const k of Object.keys(s.patternProperties)) {
          const why = regex_problem(k, true);
          if (why) out.push(where + ": patternProperties key " + why);
          metaschema_gaps(s.patternProperties[k], where + "/patternProperties/" + k, out);
        }
      }
    }
    if (has("properties") && HX.util.is_plain_object(s.properties)) {
      for (const k of Object.keys(s.properties)) metaschema_gaps(s.properties[k], where + "/properties/" + k, out);
    }
    for (const k of ["additionalProperties", "items", "not"]) if (has(k)) metaschema_gaps(s[k], where + "/" + k, out);
    for (const k of ["allOf", "anyOf", "oneOf"]) {
      if (has(k) && Array.isArray(s[k])) s[k].forEach((x, i) => metaschema_gaps(x, where + "/" + k + "/" + i, out));
    }
    return out;
  }
  catalog.metaschema_gaps = (schema) => metaschema_gaps(schema, "<root>", []);

  /** ``ToolCatalog.check_schemas()``: one entry per invalid input/output schema, in tool order.
   *  Uses HX.jsonschema.check_schema (the supported Draft 2020-12 subset; keywords outside it are
   *  reported, which is stricter than python-jsonschema) plus the metaschema rules above. */
  catalog.check_schemas = function (c) {
    const n = catalog.load_catalog(c);
    const errs = [];
    for (const name of Object.keys(n.tools)) {
      const t = n.tools[name];
      for (const [label, sch] of [["input", t.input_schema], ["output", t.output_schema]]) {
        const e = HX.jsonschema.check_schema(sch).concat(metaschema_gaps(sch, "<root>", []));
        if (e.length) errs.push(t.name + "." + label + "_schema invalid: " + e.join("; "));
      }
    }
    return errs;
  };

  /** Re-export of ``HX.jsonschema.validate_against`` (tools/catalog.py validate_against). */
  catalog.validate_against = function (schema, value) {
    return HX.jsonschema.validate_against(schema, value);
  };
})(globalThis.HX = globalThis.HX || {});
