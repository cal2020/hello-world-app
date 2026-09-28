"""Observability metrics (brief §15): TIMING events, latency separation, aggregates and renderers."""

from __future__ import annotations

import itertools
import json
import re

import pytest

from hexis_service import metrics as M
from hexis_service.cli.main import main
from hexis_service.demo import fakes
from hexis_service.demo.env import TASK, ManualClock, admit_initial, build_env
from hexis_service.models.base import ModelResponse
from hexis_service.replay.replay import replay
from hexis_service.runtime import service as service_mod
from hexis_service.traces.model import export_run_trace

from ..conftest import approve, run_to_approval

TICK = 0.001  # every timer read advances the fake timer by this much (engine bookkeeping)
MODEL_S = 0.5  # simulated model latency per call
TOOL_S = 0.25  # simulated connector latency per call
HUMAN_WAIT = 3600.0


class FakeTimer:
    """Deterministic monotonic timer: every read advances by TICK; ``sleep`` simulates external latency."""

    def __init__(self, start: float = 100.0):
        self.t = start
        self.reads = 0

    def __call__(self) -> float:
        self.reads += 1
        v = self.t
        self.t += TICK
        return v

    def sleep(self, s: float) -> None:
        self.t += s


class TimedModel:
    def __init__(self, inner, timer: FakeTimer, cost: float | None = None):
        self.inner, self.timer, self.cost = inner, timer, cost
        self.model_id = inner.model_id

    def generate(self, request):
        self.timer.sleep(MODEL_S)
        resp = self.inner.generate(request)
        if self.cost is not None:
            resp = ModelResponse(**{**resp.model_dump(), "cost_usd": self.cost})
        return resp


def _timed(fn, timer: FakeTimer):
    def call(args, ctx):
        timer.sleep(TOOL_S)
        return fn(args, ctx)
    return call


def make_env(tmp_path, pkg, name="state", timer=None, model=None, clock=None, cost=None):
    timer = timer or FakeTimer()
    clock = clock or ManualClock()
    env = build_env(str(tmp_path / name), clock=clock, timer=timer,
                    model=TimedModel(model or fakes.FixtureExtractionModel(), timer, cost))
    for k, fn in list(env.broker.connectors.items()):
        env.broker.connectors[k] = _timed(fn, timer)
    for k, fn in list(env.broker.reconcilers.items()):
        env.broker.reconcilers[k] = _timed(fn, timer)
    assert admit_initial(env, pkg).status == "ADMITTED"
    return env, timer, clock


def full_run(env, pkg, clock, wait=HUMAN_WAIT, task=None):
    run_id, res = run_to_approval(env, pkg, task)
    assert res.status == "WAITING_FOR_APPROVAL"
    clock.advance(wait)
    approve(env, run_id, res.interaction)
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    return run_id, out


def timings(env, run_id, tenant="acme"):
    return [e for e in env.store.events(tenant, run_id) if e["type"] == "TIMING"]


# ------------------------------------------------------------------------------------------- #
def test_engine_model_tool_human_wait_separation(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, out = full_run(env, pkg, clock)
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    tev = timings(env, run_id)
    assert tev and all(e["schema"] == "hexis-timing/1" for e in tev)
    n_model = sum(len(e["model_calls"]) for e in tev)
    n_tool = sum(len(e["tool_calls"]) for e in tev)
    assert n_model >= 2 and n_tool >= 5
    # each external call: its simulated latency plus exactly one timer tick between the two reads
    for e in tev:
        for c in e["model_calls"]:
            assert c["latency_s"] == pytest.approx(MODEL_S + TICK)
        for c in e["tool_calls"]:
            assert c["latency_s"] == pytest.approx(TOOL_S + TICK)
        assert e["model_s"] == pytest.approx(len(e["model_calls"]) * (MODEL_S + TICK))
        assert e["tool_s"] == pytest.approx(len(e["tool_calls"]) * (TOOL_S + TICK))
        # engine overhead excludes every external call: only bookkeeping ticks remain
        assert 0 < e["engine_s"] < 0.05
        assert e["total_s"] == pytest.approx(e["engine_s"] + e["model_s"] + e["tool_s"])
    user = [e for e in tev if e["kind"] == "user"]
    assert [e["human_wait_s"] for e in user] == [None, HUMAN_WAIT]  # paused step, then the answered step
    assert all(e["human_wait_s"] is None for e in tev if e["kind"] != "user")

    rep = M.collect(env.store, "acme")
    r = rep["per_run"][run_id]
    assert r["model_s"] == pytest.approx(n_model * (MODEL_S + TICK))
    assert r["tool_s"] == pytest.approx(n_tool * (TOOL_S + TICK))
    assert r["human_wait_s"] == HUMAN_WAIT  # logical clock advance between open and answer, exactly
    assert 0 < r["engine_s"] < 0.05 * r["steps"]
    # human wait is not part of any latency (the timer never saw it)
    assert sum(e["total_s"] for e in tev) < HUMAN_WAIT
    ustate = user[0]["state"]
    assert rep["by_state"][ustate]["human_wait_s"]["total"] == HUMAN_WAIT
    assert rep["by_state"][ustate]["human_wait_s"]["max"] == HUMAN_WAIT
    mid = fakes.FixtureExtractionModel.model_id
    assert set(rep["by_model"]) == {mid}
    bm = rep["by_model"][mid]
    assert bm["count"] == n_model and bm["latency_s"]["p50"] == pytest.approx(MODEL_S + TICK)
    assert bm["latency_s"]["total"] == pytest.approx(n_model * (MODEL_S + TICK))
    assert bm["tokens"]["total"] == sum(e["tokens"]["input"] + e["tokens"]["output"] for e in tev) > 0
    assert rep["by_tool"]["erp.create_draft"]["count"] == 1
    assert rep["by_tool"]["erp.read_draft"]["count"] >= 2  # READ_BACK + terminal freshness check
    assert rep["totals"]["human_wait_s"] == HUMAN_WAIT


def test_retries_validation_failures_and_uncertain_effects(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg, model=fakes.FixtureExtractionModel(invalid_outputs=1))
    run_id, res = run_to_approval(env, pkg)
    env.erp.inject("timeout_after_commit")
    clock.advance(60)
    approve(env, run_id, res.interaction)
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
    assert env.erp.count("acme") == 1
    rep = M.collect(env.store, "acme", run_id=run_id)
    mid = fakes.FixtureExtractionModel.model_id
    assert rep["by_model"][mid]["validation_failures"] == 1
    assert rep["by_model"][mid]["retries"] == 1  # the one structured-output repair
    ext = rep["by_state"]["EXTRACT_DRAFT"]
    assert ext["validation_failures"] == 1 and ext["retries"] == 1
    assert ext["fallback"] == {"visits": 1, "entries": 0, "frequency": 0.0}
    ce = rep["by_tool"]["erp.create_draft"]
    assert ce["uncertain_effects"] == {"raised": 1, "resolved": 1, "outstanding": 0}
    persist = [e for e in timings(env, run_id) if e["state"] == "PERSIST_DRAFT"]
    assert len(persist) == 1
    ops = [(c["tool"], c["op"], c["outcome"]) for c in persist[0]["tool_calls"]]
    assert ops == [("erp.create_draft", "dispatch", "timeout"), ("erp.create_draft", "reconcile", "ok")]
    assert persist[0]["uncertain_effects"]["raised"] == persist[0]["uncertain_effects"]["resolved"] != []
    assert rep["by_state"]["PERSIST_DRAFT"]["uncertain_effects"]["outstanding"] == 0


def test_outstanding_uncertain_effect(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, res = run_to_approval(env, pkg)
    env.erp.inject("timeout_after_commit")
    env.broker.reconcilers.clear()  # no business-reference lookup: effect stays unknown
    env.catalog.get("erp.create_draft").effect = "non_idempotent_write"
    approve(env, run_id, res.interaction)
    out = env.service.run_until_blocked(run_id, env.principal("user:alice"))
    assert out.status == "RECONCILING"
    ue = M.collect(env.store, "acme")["by_tool"]["erp.create_draft"]["uncertain_effects"]
    assert ue == {"raised": 1, "resolved": 0, "outstanding": 1}


def test_fallback_frequency(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    full_run(env, pkg, clock)
    env2 = env.restart(model=TimedModel(fakes.FixtureExtractionModel(invalid_outputs=5), timer))
    p = env2.principal("user:alice")
    h = env2.service.start_run(pkg.artifact_hash, TASK, p)
    out = env2.service.run_until_blocked(h.run_id, p)
    assert out.checkpoint.outcome["category"] == "fallback"
    rep = M.collect(env2.store, "acme")
    assert rep["runs"] == 2
    assert rep["by_state"]["EXTRACT_DRAFT"]["fallback"] == {"visits": 2, "entries": 1, "frequency": 0.5}
    only = M.collect(env2.store, "acme", run_id=h.run_id)
    assert only["by_state"]["EXTRACT_DRAFT"]["fallback"]["frequency"] == 1.0
    assert only["by_state"]["EXTRACT_DRAFT"]["validation_failures"] == 2  # rejected, repaired, rejected again
    assert only["by_model"][fakes.FixtureExtractionModel.model_id]["fallback"]["frequency"] == 1.0


def test_model_transport_retries_counted(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg, model=fakes.FixtureExtractionModel(unavailable=True))
    p = env.principal("user:alice")
    h = env.service.start_run(pkg.artifact_hash, TASK, p)
    env.service.run_until_blocked(h.run_id, p)
    st = M.collect(env.store, "acme")["by_state"]["EXTRACT_DRAFT"]
    assert st["retries"] == pkg.execution_policy.transport_retries
    assert st["fallback"]["entries"] == 1


def test_cost_is_null_not_zero_when_unknown(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, _ = full_run(env, pkg, clock)
    rep = M.collect(env.store, "acme")
    mid = fakes.FixtureExtractionModel.model_id
    assert rep["by_model"][mid]["cost_usd"] is None
    assert rep["totals"]["cost_usd"] is None and rep["per_run"][run_id]["model_cost_usd"] is None
    assert all(e["cost_usd"] is None for e in timings(env, run_id))
    assert '"cost_usd": null' in json.dumps(M.render_json(rep))
    prom = M.render_prometheus(rep)
    assert f'hexis_model_cost_known{{model="{mid}"}} 0' in prom
    assert "hexis_model_cost_usd_total" not in prom  # unknown is omitted, never exported as 0
    # a model that reports its cost yields a known sum
    env2, _, clock2 = make_env(tmp_path, pkg, name="priced", cost=0.01)
    full_run(env2, pkg, clock2)
    bm = M.collect(env2.store, "acme")["by_model"][mid]
    assert bm["cost_usd"] == pytest.approx(0.01 * bm["count"])


# ---- Prometheus exposition grammar ------------------------------------------------------------ #
_NAME = r"[a-zA-Z_:][a-zA-Z0-9_:]*"
_LVAL = r'"(?:[^"\\\n]|\\\\|\\"|\\n)*"'
_SAMPLE = re.compile(rf"^({_NAME})(\{{(?:[a-zA-Z_][a-zA-Z0-9_]*={_LVAL})(?:,[a-zA-Z_][a-zA-Z0-9_]*={_LVAL})*\}})?"
                     r" ([-+]?(?:[0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?|Inf|NaN))$")
_HELP = re.compile(rf"^# HELP ({_NAME}) (.*)$")
_TYPE = re.compile(rf"^# TYPE ({_NAME}) (counter|gauge|summary|histogram|untyped)$")


def parse_prometheus(text: str) -> dict[str, list[tuple[str, str, float]]]:
    assert text.endswith("\n")
    types: dict[str, str] = {}
    samples: dict[str, list] = {}
    for line in text.splitlines():
        if not line:
            continue
        if line.startswith("# HELP"):
            assert _HELP.match(line), line
            continue
        m = _TYPE.match(line)
        if m:
            assert m.group(1) not in types, f"duplicate TYPE {line}"
            types[m.group(1)] = m.group(2)
            continue
        assert not line.startswith("#"), line
        m = _SAMPLE.match(line)
        assert m, f"bad sample line: {line!r}"
        name = m.group(1)
        fam = name
        if fam not in types:
            for suf in ("_sum", "_count", "_bucket"):
                if name.endswith(suf) and name[: -len(suf)] in types:
                    fam = name[: -len(suf)]
        assert fam in types, f"sample before TYPE: {line}"
        samples.setdefault(name, []).append((m.group(2) or "", line, float(m.group(3))))
    return samples


def test_prometheus_output_parses_and_escapes(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, _ = full_run(env, pkg, clock)
    rep = M.collect(env.store, "acme")
    s = parse_prometheus(M.render_prometheus(rep))
    assert any(f'run="{run_id}"' in lab and 'component="human_wait"' in lab and v == HUMAN_WAIT
               for lab, _, v in s["hexis_run_seconds"])
    assert "hexis_model_latency_seconds_sum" in s and "hexis_model_latency_seconds_count" in s
    assert any('quantile="0.95"' in lab for lab, _, _ in s["hexis_tool_latency_seconds"])
    # hostile label values are escaped and still parse
    rep["by_tool"]['we"ird\\tool\nx'] = rep["by_tool"]["erp.create_draft"]
    text = M.render_prometheus(rep)
    parse_prometheus(text)
    assert 'tool="we\\"ird\\\\tool\\nx"' in text


# ---- tenant isolation ------------------------------------------------------------------------ #
def test_metrics_never_cross_tenants(tmp_path, pkg):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, _ = full_run(env, pkg, clock)
    assert M.collect(env.store, "acme")["runs"] == 1
    g = M.collect(env.store, "globex")
    assert g["runs"] == 0 and g["by_model"] == {} and g["by_state"] == {} and g["per_run"] == {}
    assert M.collect(env.store, "globex", run_id=run_id)["runs"] == 0
    state = str(tmp_path / "state")
    assert main(["metrics", "--state", state, "--as", "user:mallory", "--run", run_id]) == 2
    assert main(["metrics", "--state", state, "--as", "user:alice", "--run", run_id]) == 0


def test_cli_metrics_formats(tmp_path, pkg, capsys):
    env, timer, clock = make_env(tmp_path, pkg)
    run_id, _ = full_run(env, pkg, clock)
    state = str(tmp_path / "state")
    capsys.readouterr()
    assert main(["metrics", "--state", state, "--as", "user:alice"]) == 0
    data = json.loads(capsys.readouterr().out)
    assert data["tenant_id"] == "acme" and run_id in data["per_run"]
    assert main(["metrics", "--state", state, "--as", "user:mallory", "--format", "json"]) == 0
    assert json.loads(capsys.readouterr().out)["per_run"] == {}
    assert main(["metrics", "--state", state, "--run", run_id, "--format", "prometheus"]) == 0
    parse_prometheus(capsys.readouterr().out)


# ---- replay and checkpoints unaffected ----------------------------------------------------------- #
class _SeqUUID:
    def __init__(self):
        self._n = itertools.count(1)

    def uuid4(self):
        class U:
            hex = f"{next(self._n):032x}"
        return U()


def test_timing_never_enters_checkpoints_or_observations(tmp_path, pkg, monkeypatch):
    runs = []
    for name, timer in (("a", FakeTimer(100.0)), ("b", FakeTimer(9_999.0))):
        monkeypatch.setattr(service_mod, "uuid", _SeqUUID())
        env, _, clock = make_env(tmp_path, pkg, name=name, timer=timer)
        if name == "b":  # a genuinely different timer: slower connectors too
            for k, fn in list(env.broker.connectors.items()):
                env.broker.connectors[k] = _timed(fn, timer)
        run_id, out = full_run(env, pkg, clock)
        assert out.checkpoint.outcome["terminal"] == "END_VERIFIED_DRAFT"
        cps = env.store.checkpoints("acme", run_id)
        obs = [e["observation"] for e in env.store.events("acme", run_id) if e["type"] == "OBSERVATION"]
        tev = timings(env, run_id)
        assert tev
        for c in cps:
            assert "timing" not in json.dumps(c).lower() and "latency" not in json.dumps(c)
        for o in obs:
            assert "latency" not in json.dumps(o)
        trace = export_run_trace(env.service, run_id, env.principal("user:alice"), "accepted")
        assert replay(pkg, trace, "recorded").status == "PASS"
        runs.append((run_id, [service_mod.digest(c) for c in cps], obs, [e["total_s"] for e in tev]))
    (ra, da, oa, ta), (rb, db, ob, tb) = runs
    assert ra == rb
    assert da == db  # checkpoint digests identical regardless of the timer
    assert oa == ob
    assert ta != tb  # while the recorded timings did differ
