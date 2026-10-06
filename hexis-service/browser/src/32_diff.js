/* Port of hexis_service/artifacts/diff.py (HX.diff): structural diff between two machine packages
 * (brief §9.4 "Candidate diffs must show"). Packages are MachinePackage dumps (normalized first). */
(function (HX) {
  "use strict";
  const diff = (HX.diff = HX.diff || {});
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const cmp = (a, b) => HX.util.cmp_codepoints(a, b);
  const sorted = (it) => Array.from(it).sort(cmp);
  const get = (o, k) => (hasOwn(o, k) && o[k] !== undefined ? o[k] : null);
  const eq = (a, b) => HX.validate._py_eq(a, b);

  function edge_tuples(st) {
    return st.transitions.map((t) => [t["if"], t.to, t.inc]);
  }
  const tuple_eq = (x, y) => x[0] === y[0] && x[1] === y[1] && x[2] === y[2];
  const tuple_in = (e, list) => list.some((x) => tuple_eq(x, e));
  const as_edge = (e) => ({ if: e[0], to: e[1], inc: e[2] });
  /** Python ``str(tuple)``-keyed sort is a total order on these tuples; equal keys mean equal tuples. */
  const tuple_key = (e) => JSON.stringify(e);

  /** ``package_diff(old, new, catalog=None)``. */
  diff.package_diff = function package_diff(old_, new_, catalog) {
    const old = HX.pkg.normalize_package(old_);
    const nw = HX.pkg.normalize_package(new_);
    const om = old.machine, nm = nw.machine;
    const os = new Set(Object.keys(om.states)), ns = new Set(Object.keys(nm.states));
    const added_states = sorted([...ns].filter((s) => !os.has(s)));
    const removed_states = sorted([...os].filter((s) => !ns.has(s)));
    const changed_actions = [];
    for (const sid of sorted([...os].filter((s) => ns.has(s)))) {
      const a = om.states[sid].action, b = nm.states[sid].action;
      if (!eq(a, b)) {
        const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
        changed_actions.push({ state: sid, fields: sorted([...keys].filter((k) => !eq(get(a, k), get(b, k)))) });
      }
    }
    const edge_changes = [];
    for (const sid of sorted(new Set([...os, ...ns]))) {
      const before = os.has(sid) ? edge_tuples(om.states[sid]) : [];
      const after = ns.has(sid) ? edge_tuples(nm.states[sid]) : [];
      const same = before.length === after.length && before.every((e, i) => tuple_eq(e, after[i]));
      if (!same) {
        const sb = before.map(tuple_key).sort(), sa = after.map(tuple_key).sort();
        edge_changes.push({
          state: sid,
          added: after.filter((e) => !tuple_in(e, before)).map(as_edge),
          removed: before.filter((e) => !tuple_in(e, after)).map(as_edge),
          order_changed: sb.length === sa.length && sb.every((k, i) => k === sa[i]),
        });
      }
    }
    const vars_of = (m) => {
      const out = new Map();
      for (const v of m.variables) out.set(v.name, v);
      return out;
    };
    const ov = vars_of(om), nv = vars_of(nm);
    const var_changes = {
      added: sorted([...nv.keys()].filter((k) => !ov.has(k))),
      removed: sorted([...ov.keys()].filter((k) => !nv.has(k))),
      changed: sorted([...ov.keys()].filter((k) => nv.has(k) && !eq(ov.get(k), nv.get(k)))),
    };
    const oc = old.contracts, nc = nw.contracts;
    const contract_changes = sorted(new Set([...Object.keys(oc), ...Object.keys(nc)])).filter((k) => !eq(get(oc, k), get(nc, k)));
    const policy_changed = !eq(old.execution_policy, nw.execution_policy);
    const cl = new Set();
    for (const s of added_states) if (nm.states[s].clause) cl.add(nm.states[s].clause);
    for (const e of edge_changes) if (hasOwn(nm.states, e.state) && nm.states[e.state].clause) cl.add(nm.states[e.state].clause);
    const clauses = sorted(cl);
    let newly_reachable_effects = [];
    if (catalog !== undefined && catalog !== null) {
      const WRITE = new Set(HX.catalog.WRITE_EFFECTS);
      const effects = (p) => {
        const r = HX.validate.reachable(p.machine, p.machine.initial);
        const out = new Set();
        for (const s of r) {
          if (!hasOwn(p.machine.states, s)) throw HX.validate._pyerr("KeyError", HX.validate._repr(s));
          const a = p.machine.states[s].action;
          if (a.kind === "tool") {
            const spec = HX.catalog.get(catalog, a.name);
            if (spec !== null && WRITE.has(spec.effect)) out.add(s + ":" + a.name);
          }
        }
        return out;
      };
      const eo = effects(old);
      newly_reachable_effects = sorted([...effects(nw)].filter((x) => !eo.has(x)));
    }
    return {
      states_added: added_states, states_removed: removed_states, actions_changed: changed_actions,
      edges_changed: edge_changes, variables: var_changes, contracts_changed: contract_changes,
      execution_policy_changed: policy_changed, affected_clauses: clauses,
      newly_reachable_effects,
    };
  };
})(globalThis.HX = globalThis.HX || {});
