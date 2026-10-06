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

  /* Draft 2020-12 metaschema rules that python-jsonschema's check_schema enforces and
   * HX.jsonschema.check_schema does not (so check_schemas is never more lenient than Python). */
  const JS_ONLY_REGEX = /\\[pP]\{|\(\?<(?![=!])|\\k<|\\u\{|\(\?<[=!][^)]*[*+?{|]/;
  function regex_problem(p) {
    try {
      new RegExp(p, "u");
    } catch (e) {
      return "invalid regular expression";
    }
    return JS_ONLY_REGEX.test(p) ? "regular expression uses syntax Python's re does not accept" : null;
  }
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
    if (has("$id") && (typeof s.$id !== "string" || !/^[^#]*#?$/.test(s.$id))) out.push(where + ": $id must be a URI without fragment");
    if (has("examples") && !Array.isArray(s.examples)) out.push(where + ": examples must be an array");
    for (const k of ["deprecated", "readOnly", "writeOnly"]) {
      if (has(k) && typeof s[k] !== "boolean") out.push(where + ": " + k + " must be a boolean");
    }
    if (has("pattern") && typeof s.pattern === "string") {
      const why = regex_problem(s.pattern);
      if (why) out.push(where + ": pattern " + why);
    }
    if (has("patternProperties")) {
      if (!HX.util.is_plain_object(s.patternProperties)) out.push(where + ": patternProperties must be an object");
      else {
        for (const k of Object.keys(s.patternProperties)) {
          const why = regex_problem(k);
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
