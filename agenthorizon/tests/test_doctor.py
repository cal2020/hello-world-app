"""Capability report: one ``--version`` per harness binary per report, and the comparison with the verified release."""

from __future__ import annotations

from agenthorizon.judging import doctor as doctor_mod
from agenthorizon.judging import harnesses
from agenthorizon.judging.harnesses import ADAPTERS


def test_version_match_is_exact_on_release_boundaries():
    a = ADAPTERS["claude_code"]
    assert a.version_matches("2.1.295 (Claude Code)") and a.version_matches("v2.1.295")
    assert a.version_matches("2.1.296 (Claude Code)") is False
    assert a.version_matches("2.1.2950") is False and a.version_matches("12.1.295") is False
    assert a.version_matches(None) is None
    assert {k: x.verified_version for k, x in ADAPTERS.items()} == {
        "claude_code": "2.1.295", "codex": "0.162.1", "gemini_cli": "0.63.0", "opencode": "1.18.35", "openhands": "1.16.0"}


def test_report_runs_each_version_once_and_flags_a_harness_off_the_verified_release(monkeypatch):
    reported = {"claude": "2.1.296 (Claude Code)", "codex": "codex-cli 0.162.1", "gemini": "0.63.0",
                "opencode": "1.18.35", "openhands": "OpenHands CLI 1.16.0"}
    calls: list[str] = []

    def fake_version(argv: list[str]) -> str:
        calls.append(argv[0])
        return reported[argv[0].rsplit("/", 1)[-1]]

    for a in ADAPTERS.values():
        monkeypatch.setattr(a, "binary_path", lambda b=a.binary: f"/opt/fake/{b}")
    monkeypatch.setattr(harnesses, "_version", fake_version)
    rep = doctor_mod.doctor(environ={}, probe_network=False)
    assert sorted(calls) == sorted(f"/opt/fake/{b}" for b in reported)  # 23 configurations, 5 binaries, 5 launches
    by_id = {c["config_id"]: c for c in rep["configurations"]}
    claude = by_id["claude_code:claude-opus-4.7"]
    assert claude["checks"]["installation"]["matches_verified"] is False
    assert any("not the verified release 2.1.295" in r for r in claude["reasons"])
    codex = by_id["codex:gpt-5.5"]
    assert codex["checks"]["installation"]["matches_verified"] is True
    assert not any("verified release" in r for r in codex["reasons"])
