/* JSON Schema (Draft 2020-12) subset used by the HEXIS catalog, contracts and task inputs.
 * Mirrors hexis_service.tools.catalog.validate_against, which wraps python-jsonschema's
 * Draft202012Validator. Supported keywords: type (string or list, incl. "null"), enum, const,
 * required, properties, additionalProperties (bool or schema), patternProperties, items (schema),
 * minItems, maxItems, uniqueItems, minLength, maxLength, pattern, minimum, maximum,
 * exclusiveMinimum, exclusiveMaximum, multipleOf, allOf, anyOf, oneOf, not. Annotations
 * (title, description, default, examples, format, $comment, $schema, $id) are ignored.
 * Any other keyword makes check_schema report an error, and validate_against fails closed
 * ("unsupported keyword") rather than silently accepting.
 */
(function (HX) {
  "use strict";
  const js = (HX.jsonschema = HX.jsonschema || {});
  const util = HX.util;

  const ANNOTATIONS = new Set(["title", "description", "default", "examples", "format", "$comment", "$schema",
    "$id", "readOnly", "writeOnly", "deprecated"]);
  const SUPPORTED = new Set(["type", "enum", "const", "required", "properties", "additionalProperties",
    "patternProperties", "items", "minItems", "maxItems", "uniqueItems", "minLength", "maxLength", "pattern",
    "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "allOf", "anyOf", "oneOf", "not"]);
  const TYPES = new Set(["string", "integer", "number", "boolean", "array", "object", "null"]);

  function is_type(v, t) {
    switch (t) {
      case "null": return v === null;
      case "boolean": return v === true || v === false;
      case "string": return typeof v === "string";
      case "integer": return typeof v === "number" && Number.isInteger(v);
      case "number": return typeof v === "number" && Number.isFinite(v);
      case "array": return Array.isArray(v);
      case "object": return util.is_plain_object(v);
      default: return false;
    }
  }
  js.is_type = is_type;

  const R = (v) => util.py_repr(v);

  function compile_pattern(p) {
    try {
      return new RegExp(p, "u");
    } catch (e) {
      return null;
    }
  }

  function walk(schema, value, path, errors) {
    if (schema === true) return;
    if (schema === false) { errors.push([path, "False schema does not allow " + R(value)]); return; }
    if (!util.is_plain_object(schema)) { errors.push([path, "invalid schema"]); return; }
    for (const kw of Object.keys(schema)) {
      if (!SUPPORTED.has(kw) && !ANNOTATIONS.has(kw)) {
        errors.push([path, "unsupported schema keyword " + R(kw)]);
      }
    }
    if ("type" in schema) {
      const types = Array.isArray(schema.type) ? schema.type : [schema.type];
      if (!types.some((t) => is_type(value, t))) {
        errors.push([path, R(value) + " is not of type " + types.map(R).join(", ")]);
      }
    }
    if ("enum" in schema) {
      if (!schema.enum.some((e) => util.deep_equal(e, value))) {
        errors.push([path, R(value) + " is not one of " + R(schema.enum)]);
      }
    }
    if ("const" in schema && !util.deep_equal(schema.const, value)) {
      errors.push([path, R(schema.const) + " was expected"]);
    }
    if (typeof value === "string") {
      const len = util.codepoint_length(value);
      if ("minLength" in schema && len < schema.minLength) {
        errors.push([path, schema.minLength === 1 ? R(value) + " should be non-empty" : R(value) + " is too short"]);
      }
      if ("maxLength" in schema && len > schema.maxLength) errors.push([path, R(value) + " is too long"]);
      if ("pattern" in schema) {
        const re = compile_pattern(schema.pattern);
        if (re === null) errors.push([path, "invalid pattern " + R(schema.pattern)]);
        else if (!re.test(value)) errors.push([path, R(value) + " does not match " + R(schema.pattern)]);
      }
    }
    if (typeof value === "number") {
      if ("minimum" in schema && value < schema.minimum) {
        errors.push([path, R(value) + " is less than the minimum of " + R(schema.minimum)]);
      }
      if ("maximum" in schema && value > schema.maximum) {
        errors.push([path, R(value) + " is greater than the maximum of " + R(schema.maximum)]);
      }
      if ("exclusiveMinimum" in schema && value <= schema.exclusiveMinimum) {
        errors.push([path, R(value) + " is less than or equal to the minimum of " + R(schema.exclusiveMinimum)]);
      }
      if ("exclusiveMaximum" in schema && value >= schema.exclusiveMaximum) {
        errors.push([path, R(value) + " is greater than or equal to the maximum of " + R(schema.exclusiveMaximum)]);
      }
      if ("multipleOf" in schema) {
        const q = value / schema.multipleOf;
        if (!Number.isFinite(q) || Math.abs(q - Math.round(q)) > 1e-9) {
          errors.push([path, R(value) + " is not a multiple of " + R(schema.multipleOf)]);
        }
      }
    }
    if (Array.isArray(value)) {
      if ("minItems" in schema && value.length < schema.minItems) {
        errors.push([path, schema.minItems === 1 ? R(value) + " should be non-empty" : R(value) + " is too short"]);
      }
      if ("maxItems" in schema && value.length > schema.maxItems) {
        errors.push([path, R(value) + " is too long"]);
      }
      if (schema.uniqueItems === true) {
        for (let i = 0; i < value.length; i++) {
          for (let j = i + 1; j < value.length; j++) {
            if (util.deep_equal(value[i], value[j])) {
              errors.push([path, R(value) + " has non-unique elements"]);
              i = value.length;
              break;
            }
          }
        }
      }
      if ("items" in schema) {
        value.forEach((item, idx) => walk(schema.items, item, path.concat([idx]), errors));
      }
    }
    if (util.is_plain_object(value)) {
      if (Array.isArray(schema.required)) {
        for (const k of schema.required) {
          if (!Object.prototype.hasOwnProperty.call(value, k)) errors.push([path, R(k) + " is a required property"]);
        }
      }
      const props = util.is_plain_object(schema.properties) ? schema.properties : {};
      const pprops = util.is_plain_object(schema.patternProperties) ? schema.patternProperties : {};
      const extras = [];
      for (const k of Object.keys(value)) {
        let matched = false;
        if (Object.prototype.hasOwnProperty.call(props, k)) {
          matched = true;
          walk(props[k], value[k], path.concat([k]), errors);
        }
        for (const p of Object.keys(pprops)) {
          const re = compile_pattern(p);
          if (re && re.test(k)) {
            matched = true;
            walk(pprops[p], value[k], path.concat([k]), errors);
          }
        }
        if (!matched) extras.push(k);
      }
      if ("additionalProperties" in schema && extras.length) {
        const ap = schema.additionalProperties;
        if (ap === false) {
          const shown = extras.map(R).join(", ");
          errors.push([path, "Additional properties are not allowed (" + shown + (extras.length === 1 ? " was" : " were") +
            " unexpected)"]);
        } else if (ap !== true) {
          for (const k of extras) walk(ap, value[k], path.concat([k]), errors);
        }
      }
    }
    if (Array.isArray(schema.allOf)) schema.allOf.forEach((s) => walk(s, value, path, errors));
    if (Array.isArray(schema.anyOf)) {
      const ok = schema.anyOf.some((s) => { const e = []; walk(s, value, path, e); return e.length === 0; });
      if (!ok) errors.push([path, R(value) + " is not valid under any of the given schemas"]);
    }
    if (Array.isArray(schema.oneOf)) {
      const n = schema.oneOf.filter((s) => { const e = []; walk(s, value, path, e); return e.length === 0; }).length;
      if (n !== 1) {
        errors.push([path, n === 0 ? R(value) + " is not valid under any of the given schemas"
          : R(value) + " is valid under each of " + n + " schemas"]);
      }
    }
    if ("not" in schema) {
      const e = [];
      walk(schema.not, value, path, e);
      if (e.length === 0) errors.push([path, R(value) + " should not be valid under " + R(schema.not)]);
    }
  }

  function path_key(p) {
    return p.map((x) => (typeof x === "number" ? "#" + String(x).padStart(12, "0") : "$" + x)).join("\u0000");
  }

  /** Validate and return readable errors ("path: message"), sorted by path; [] means valid. */
  js.validate_against = function (schema, value) {
    const errors = [];
    walk(schema, value, [], errors);
    errors.sort((a, b) => util.cmp_codepoints(path_key(a[0]), path_key(b[0])));
    return errors.map(([p, msg]) => (p.length ? p.map(String).join("/") : "<root>") + ": " + msg);
  };

  /** Structural check of a schema (mirrors Draft202012Validator.check_schema for the subset). */
  js.check_schema = function check_schema(schema, where) {
    where = where || "<root>";
    const errs = [];
    if (schema === true || schema === false) return errs;
    if (!util.is_plain_object(schema)) return [where + ": schema must be an object or boolean"];
    for (const kw of Object.keys(schema)) {
      if (!SUPPORTED.has(kw) && !ANNOTATIONS.has(kw)) errs.push(where + ": unsupported keyword " + R(kw));
    }
    if ("type" in schema) {
      const ts = Array.isArray(schema.type) ? schema.type : [schema.type];
      for (const t of ts) if (!TYPES.has(t)) errs.push(where + ": unknown type " + R(t));
    }
    if ("enum" in schema && !Array.isArray(schema.enum)) errs.push(where + ": enum must be an array");
    if ("required" in schema && !(Array.isArray(schema.required) && schema.required.every((x) => typeof x === "string"))) {
      errs.push(where + ": required must be an array of strings");
    }
    for (const kw of ["minItems", "maxItems", "minLength", "maxLength"]) {
      if (kw in schema && !(Number.isInteger(schema[kw]) && schema[kw] >= 0)) {
        errs.push(where + ": " + kw + " must be a non-negative integer");
      }
    }
    for (const kw of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]) {
      if (kw in schema && typeof schema[kw] !== "number") errs.push(where + ": " + kw + " must be a number");
    }
    if ("pattern" in schema && (typeof schema.pattern !== "string" || compile_pattern(schema.pattern) === null)) {
      errs.push(where + ": pattern must be a valid regular expression");
    }
    if ("properties" in schema) {
      if (!util.is_plain_object(schema.properties)) errs.push(where + ": properties must be an object");
      else for (const k of Object.keys(schema.properties)) errs.push(...check_schema(schema.properties[k], where + "/properties/" + k));
    }
    if ("patternProperties" in schema && util.is_plain_object(schema.patternProperties)) {
      for (const k of Object.keys(schema.patternProperties)) errs.push(...check_schema(schema.patternProperties[k], where + "/patternProperties/" + k));
    }
    if ("additionalProperties" in schema) errs.push(...check_schema(schema.additionalProperties, where + "/additionalProperties"));
    if ("items" in schema) errs.push(...check_schema(schema.items, where + "/items"));
    for (const kw of ["allOf", "anyOf", "oneOf"]) {
      if (kw in schema) {
        if (!Array.isArray(schema[kw]) || !schema[kw].length) errs.push(where + ": " + kw + " must be a non-empty array");
        else schema[kw].forEach((s, i) => errs.push(...check_schema(s, where + "/" + kw + "/" + i)));
      }
    }
    if ("not" in schema) errs.push(...check_schema(schema.not, where + "/not"));
    return errs;
  };
})(globalThis.HX = globalThis.HX || {});
