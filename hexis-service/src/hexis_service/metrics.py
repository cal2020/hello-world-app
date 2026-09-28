"""Observability metrics (brief §15): latency breakdown and usage aggregates from run records.

Inputs are the append-only ``TIMING`` run events written by :class:`RunService` after every step (see
``docs/OPERATIONS.md`` "Metrics") plus the existing domain records (action intents/receipts and the
``EFFECT_UNKNOWN`` / ``RECONCILIATION_REQUIRED`` events) for external-effect uncertainty. Nothing here
writes to the store, and every query is scoped to one tenant.

Report keys: ``by_model`` (model id), ``by_state`` (state id), ``by_tool`` (tool name), ``per_run``
(engine vs model vs tool vs human-wait totals per run) and ``totals``. Cost is ``None`` (JSON ``null``)
whenever any contributing call did not report a cost; unknown is never rendered as 0.
"""

from __future__ import annotations

import math
import re
from typing import Any, Optional

UNCERTAIN_EVENTS = ("EFFECT_UNKNOWN", "RECONCILIATION_REQUIRED")
_UNRESOLVED_STATUSES = ("DISPATCHING", "UNKNOWN_EFFECT")


# --------------------------------------------------------------------------------------------- #
def percentile(values: list[float], q: float) -> Optional[float]:
    """Nearest-rank percentile (``q`` in 0..100); ``None`` for no samples."""
    if not values:
        return None
    s = sorted(values)
    k = max(1, math.ceil(q / 100.0 * len(s)))
    return s[k - 1]


def _latency(values: list[float]) -> dict:
    return {"p50": percentile(values, 50), "p95": percentile(values, 95), "max": max(values) if values else None,
            "total": sum(values), "samples": len(values)}


def _cost(costs: list[Optional[float]]) -> Optional[float]:
    """Known only if there is at least one priced call and every call reported its cost."""
    if not costs or any(c is None for c in costs):
        return None
    return sum(costs)  # type: ignore[arg-type]


class _Acc:
    """Accumulator for one report key (a model, a state or a tool)."""

    def __init__(self) -> None:
        self.count = 0
        self.latencies: list[float] = []
        self.tokens_in = 0
        self.tokens_out = 0
        self.costs: list[Optional[float]] = []
        self.retries = 0
        self.validation_failures = 0
        self.visits: set[tuple[str, int]] = set()
        self.fallback_visits: set[tuple[str, int]] = set()
        self.human_wait: list[float] = []
        self.raised: set[str] = set()
        self.outstanding: set[str] = set()
        self.split = {"engine_s": 0.0, "model_s": 0.0, "tool_s": 0.0}

    def to_json(self, *, human_wait: bool = False, split: bool = False) -> dict:
        out: dict[str, Any] = {
            "count": self.count, "latency_s": _latency(self.latencies),
            "tokens": {"input": self.tokens_in, "output": self.tokens_out, "total": self.tokens_in + self.tokens_out},
            "cost_usd": _cost(self.costs), "retries": self.retries, "validation_failures": self.validation_failures,
            "fallback": {"visits": len(self.visits), "entries": len(self.fallback_visits),
                         "frequency": (len(self.fallback_visits) / len(self.visits)) if self.visits else None},
            "uncertain_effects": {"raised": len(self.raised), "resolved": len(self.raised - self.outstanding),
                                  "outstanding": len(self.outstanding)},
        }
        if human_wait:
            out["human_wait_s"] = _latency(self.human_wait)
        if split:
            out.update(self.split)
        return out


# --------------------------------------------------------------------------------------------- #
def _run_ids(store, tenant_id: str) -> list[str]:
    lister = getattr(store, "list_runs", None)
    if callable(lister):
        return [r if isinstance(r, str) else r["run_id"] for r in lister(tenant_id)]
    return [r[0] for r in store.qa("SELECT run_id FROM runs WHERE tenant_id=? ORDER BY created_at, run_id",
                                   (tenant_id,))]


def collect(store, tenant_id: str, *, run_id: Optional[str] = None, artifact_hash: Optional[str] = None) -> dict:
    """Aggregate the metrics report for ``tenant_id`` (optionally one run and/or one artifact).

    The tenant is the caller's authenticated tenant; runs of any other tenant are never read."""
    ids = [run_id] if run_id else _run_ids(store, tenant_id)
    by_model: dict[str, _Acc] = {}
    by_state: dict[str, _Acc] = {}
    by_tool: dict[str, _Acc] = {}
    per_run: dict[str, dict] = {}
    totals = {"engine_s": 0.0, "model_s": 0.0, "tool_s": 0.0, "human_wait_s": 0.0, "steps": 0}
    all_costs: list[Optional[float]] = []
    for rid in ids:
        run = store.get_run(tenant_id, rid)
        if run is None or (artifact_hash and run["artifact_hash"] != artifact_hash):
            continue
        events = store.events(tenant_id, rid)
        r = {"status": run["status"], "artifact_hash": run["artifact_hash"], "steps": 0, "engine_s": 0.0,
             "model_s": 0.0, "tool_s": 0.0, "human_wait_s": 0.0, "tokens": 0}
        run_costs: list[Optional[float]] = []
        model_costs: list[Optional[float]] = []
        for ev in events:
            if ev.get("type") != "TIMING":
                continue
            visit = (rid, int(ev.get("revision", 0)))
            st = by_state.setdefault(ev.get("state", "?"), _Acc())
            st.count += 1
            st.visits.add(visit)
            st.latencies.append(float(ev.get("total_s", 0.0)))
            for k in ("engine_s", "model_s", "tool_s"):
                st.split[k] += float(ev.get(k, 0.0))
                r[k] += float(ev.get(k, 0.0))
            tok = ev.get("tokens") or {}
            st.tokens_in += int(tok.get("input", 0))
            st.tokens_out += int(tok.get("output", 0))
            r["tokens"] += int(tok.get("input", 0)) + int(tok.get("output", 0))
            retries = ev.get("retries") or {}
            st.retries += sum(int(v) for v in retries.values())
            st.validation_failures += int(ev.get("validation_failures", 0))
            if ev.get("fallback"):
                st.fallback_visits.add(visit)
            if ev.get("human_wait_s") is not None:
                st.human_wait.append(float(ev["human_wait_s"]))
                r["human_wait_s"] += float(ev["human_wait_s"])
            r["steps"] += 1
            models_here: set[str] = set()
            for c in ev.get("model_calls") or []:
                mid = c.get("model_id", "?")
                models_here.add(mid)
                acc = by_model.setdefault(mid, _Acc())
                acc.count += 1
                acc.latencies.append(float(c.get("latency_s", 0.0)))
                acc.tokens_in += int(c.get("input_tokens", 0))
                acc.tokens_out += int(c.get("output_tokens", 0))
                if c.get("transport_retry") or c.get("repair"):
                    acc.retries += 1
                if c.get("outcome") == "rejected":
                    acc.validation_failures += 1
                if c.get("outcome") != "unavailable":
                    acc.costs.append(c.get("cost_usd"))
                    st.costs.append(c.get("cost_usd"))
                    run_costs.append(c.get("cost_usd"))
                    model_costs.append(c.get("cost_usd"))
            for mid in models_here:
                by_model[mid].visits.add(visit)
                if ev.get("fallback"):
                    by_model[mid].fallback_visits.add(visit)
            tools_here: set[str] = set()
            for c in ev.get("tool_calls") or []:
                name = c.get("tool", "?")
                tools_here.add(name)
                acc = by_tool.setdefault(name, _Acc())
                acc.count += 1
                acc.latencies.append(float(c.get("latency_s", 0.0)))
                acc.costs.append(None)  # connector cost is not measurable here: unknown, not 0
                st.costs.append(None)
                run_costs.append(None)
                if int(c.get("attempt", 1)) > 1 or c.get("op") == "redispatch":
                    acc.retries += 1
            for name in tools_here:
                by_tool[name].visits.add(visit)
                if ev.get("fallback"):
                    by_tool[name].fallback_visits.add(visit)
        # External-effect uncertainty from the authoritative ledger, not from timing.
        raised = {e["logical_action_id"] for e in events if e.get("type") in UNCERTAIN_EVENTS
                  and e.get("logical_action_id")}
        if raised:
            intents = {i["logical_action_id"]: i for i in store.intents(tenant_id, rid)}
            succeeded = {x["logical_action_id"] for x in store.receipts(tenant_id, run_id=rid)
                         if x["dispatch_state"] == "SUCCEEDED"}
            for lid in raised:
                it = intents.get(lid) or {}
                open_ = it.get("status") in _UNRESOLVED_STATUSES and lid not in succeeded
                for acc in (by_tool.setdefault(it.get("tool", "?"), _Acc()),
                            by_state.setdefault(it.get("state_id", "?"), _Acc())):
                    acc.raised.add(lid)
                    if open_:
                        acc.outstanding.add(lid)
        r["cost_usd"] = _cost(run_costs)
        r["model_cost_usd"] = _cost(model_costs)
        r["uncertain_effects"] = len(raised)
        all_costs.extend(run_costs)
        per_run[rid] = r
        for k in ("engine_s", "model_s", "tool_s", "human_wait_s", "steps"):
            totals[k] += r[k]
    return {
        "schema": "hexis-metrics/1", "tenant_id": tenant_id,
        "filters": {"run_id": run_id, "artifact_hash": artifact_hash}, "runs": len(per_run),
        "by_model": {k: v.to_json() for k, v in sorted(by_model.items())},
        "by_state": {k: v.to_json(human_wait=True, split=True) for k, v in sorted(by_state.items())},
        "by_tool": {k: v.to_json() for k, v in sorted(by_tool.items())},
        "per_run": per_run,
        "totals": {**totals, "cost_usd": _cost(all_costs)},
    }


# --------------------------------------------------------------------------------------------- #
# Prometheus text exposition format (version 0.0.4)
# --------------------------------------------------------------------------------------------- #
_METRIC_RE = re.compile(r"^[a-zA-Z_:][a-zA-Z0-9_:]*$")
_LABEL_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


def escape_label(value: str) -> str:
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def _num(v: float) -> str:
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, int):
        return str(v)
    if math.isnan(v):
        return "NaN"
    if math.isinf(v):
        return "+Inf" if v > 0 else "-Inf"
    return repr(float(v))


class _Families:
    def __init__(self) -> None:
        self.order: list[str] = []
        self.meta: dict[str, tuple[str, str]] = {}
        self.samples: dict[str, list[str]] = {}

    def add(self, name: str, typ: str, help_: str, value: Optional[float], labels: dict[str, str],
            family: Optional[str] = None) -> None:
        """``family`` groups ``_sum``/``_count`` samples under their summary's TYPE line."""
        if value is None:
            return  # unknown values are omitted, never rendered as 0
        fam = family or name
        assert _METRIC_RE.match(name) and _METRIC_RE.match(fam), name
        if fam not in self.meta:
            self.order.append(fam)
            self.meta[fam] = (typ, help_)
            self.samples[fam] = []
        lab = ",".join(f'{k}="{escape_label(v)}"' for k, v in labels.items() if _LABEL_RE.match(k))
        self.samples[fam].append(f"{name}{{{lab}}} {_num(value)}" if lab else f"{name} {_num(value)}")

    def render(self) -> str:
        out: list[str] = []
        for fam in self.order:
            typ, help_ = self.meta[fam]
            out.append(f"# HELP {fam} {help_.replace(chr(92), chr(92) * 2).replace(chr(10), chr(92) + 'n')}")
            out.append(f"# TYPE {fam} {typ}")
            out.extend(self.samples[fam])
        return "\n".join(out) + "\n"


def render_json(report: dict) -> dict:
    return report


def render_prometheus(report: dict) -> str:
    f = _Families()
    for dim, key in (("model", "by_model"), ("state", "by_state"), ("tool", "by_tool")):
        what = {"model": "model calls", "state": "state steps", "tool": "tool connector calls"}[dim]
        for k, s in report[key].items():
            lab = {dim: k}
            fam = f"hexis_{dim}_latency_seconds"
            lat = s["latency_s"]
            help_ = f"Latency of {what} in seconds (monotonic timer)."
            for q in ("0.5", "0.95"):
                f.add(fam, "summary", help_, lat["p50" if q == "0.5" else "p95"], {**lab, "quantile": q})
            f.add(fam + "_sum", "summary", help_, lat["total"], lab, family=fam)
            f.add(fam + "_count", "summary", help_, lat["samples"], lab, family=fam)
            f.add(f"hexis_{dim}_latency_max_seconds", "gauge", f"Maximum latency of {what} in seconds.",
                  lat["max"], lab)
            f.add(f"hexis_{dim}_calls_total", "counter", f"Number of {what}.", s["count"], lab)
            for direction in ("input", "output"):
                f.add(f"hexis_{dim}_tokens_total", "counter", f"Model tokens consumed by {what}.",
                      s["tokens"][direction], {**lab, "direction": direction})
            f.add(f"hexis_{dim}_cost_known", "gauge", "1 if every call reported its cost, 0 if cost is unknown.",
                  1 if s["cost_usd"] is not None else 0, lab)
            f.add(f"hexis_{dim}_cost_usd_total", "counter", "Reported cost in USD (omitted when unknown).",
                  s["cost_usd"], lab)
            f.add(f"hexis_{dim}_retries_total", "counter", "Transport retries and output repairs.", s["retries"], lab)
            f.add(f"hexis_{dim}_validation_failures_total", "counter", "Rejected model outputs / observations.",
                  s["validation_failures"], lab)
            f.add(f"hexis_{dim}_fallback_entries_total", "counter", "State visits that entered the fallback.",
                  s["fallback"]["entries"], lab)
            f.add(f"hexis_{dim}_fallback_ratio", "gauge", "Fallback entries per state visit.",
                  s["fallback"]["frequency"], lab)
            for phase in ("raised", "resolved", "outstanding"):
                f.add(f"hexis_{dim}_uncertain_effects", "gauge", "External effects whose outcome was unknown.",
                      s["uncertain_effects"][phase], {**lab, "phase": phase})
            if "human_wait_s" in s:
                hw = s["human_wait_s"]
                f.add("hexis_state_human_wait_seconds_total", "counter",
                      "Human wait (interaction opened to answered, logical clock) in seconds.", hw["total"], lab)
                f.add("hexis_state_human_wait_max_seconds", "gauge", "Maximum human wait in seconds.", hw["max"], lab)
    for rid, r in report["per_run"].items():
        for comp in ("engine", "model", "tool", "human_wait"):
            f.add("hexis_run_seconds", "gauge", "Per-run time by component: engine overhead, model, tool, human wait.",
                  r[f"{comp}_s"], {"run": rid, "component": comp})
        f.add("hexis_run_steps", "gauge", "Persisted steps per run.", r["steps"], {"run": rid})
    t = report["totals"]
    for comp in ("engine", "model", "tool", "human_wait"):
        f.add("hexis_seconds_total", "counter", "Time by component across the selected runs.", t[f"{comp}_s"],
              {"component": comp})
    f.add("hexis_runs", "gauge", "Runs included in this report.", report["runs"], {})
    return f.render()

