"""Drive the authors' released per-item runners with scripted outcomes (TEST ONLY; run with ``python -I``).

argv: <checkout> <agentic|direct> <scenarios.json> <workdir>
Each scenario is a list of scripted outcomes consumed one per provider call / CLI process:
  {"kind": "text", "text": ...}       a completed call whose response is ``text``
  {"kind": "ratelimit"}              a rate-limit signal (stderr marker / RateLimitError)
  {"kind": "error"}                  a non-zero exit (agentic) / non-rate-limit API error (direct)
  {"kind": "timeout"}                the subprocess exceeds its timeout (agentic only)
Prints one JSON line per scenario: calls made, whether a result file exists, and whether it has ``success``.
No model, network, or credential is involved: the provider call or CLI process is replaced in-process.
"""

import asyncio
import importlib.util
import json
import os
import sys
from pathlib import Path

checkout, mode, scenarios_path, workdir = Path(sys.argv[1]), sys.argv[2], Path(sys.argv[3]), Path(sys.argv[4])
os.environ["HOME"] = str(workdir / "home")
(workdir / "home").mkdir(parents=True, exist_ok=True)
sys.path.insert(0, str(checkout))
scenarios = json.loads(scenarios_path.read_text())


async def _nosleep(*_a, **_k):
    return None


asyncio.sleep = _nosleep  # reference waits (300 s / retry_after) are skipped; counts are what matter

if mode == "direct":
    import llm_judges.evaluate as ev

    for i, sc in enumerate(scenarios):
        seq, calls = list(sc), []

        async def fake(messages, model, api_key, _seq=seq, _calls=calls, **kw):
            o = _seq.pop(0)
            _calls.append(o["kind"])
            if o["kind"] == "ratelimit":
                raise ev.RateLimitError("Rate limited (429)", retry_after=0)
            if o["kind"] == "error":
                raise RuntimeError("HTTP 500")
            return o["text"], {}

        ev.call_openai_compatible = fake
        d = workdir / f"direct-{i}"
        (d / "out").mkdir(parents=True)
        pre = d / "t.json"
        pre.write_text(json.dumps({"trajectory_id": "t", "messages": []}))
        status = asyncio.run(ev.evaluate_one(pre, d / "out", "vllm", "m", "k", "a", asyncio.Semaphore(1), 1, 1, False,
                                             base_url="http://127.0.0.1:9/v1"))
        res = d / "out" / "t.json"
        saved = json.loads(res.read_text()) if res.exists() else None
        print(json.dumps({"i": i, "status": status, "calls": len(calls), "saved": saved is not None,
                          "has_success": bool(saved) and "success" in saved}))
else:
    spec = importlib.util.spec_from_file_location("ref_eval_traj", checkout / "scripts" / "evaluate_trajectories.py")
    et = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(et)
    et._load_openrouter_key = lambda: None
    et._load_openrouter_byok_key = lambda: None
    et._load_gemini_key = lambda: None

    for i, sc in enumerate(scenarios):
        seq, calls = list(sc), []

        class FakeProc:
            def __init__(self, o):
                self.o, self.returncode, self.n = o, None, 0

            async def communicate(self, input=None):
                self.n += 1
                k = self.o["kind"]
                if k == "timeout" and self.n == 1:
                    raise TimeoutError()
                if k == "timeout":
                    return b"", b""
                if k == "ratelimit":
                    self.returncode = 1
                    return b"", b"Error: rate limit exceeded, please retry"
                if k == "error":
                    self.returncode = 1
                    return b"", b"fatal: harness crashed"
                self.returncode = 0
                return json.dumps({"result": self.o["text"]}).encode(), b""

            def kill(self):
                self.returncode = -9

        async def fake_exec(*cmd, _seq=seq, _calls=calls, **kw):
            o = _seq.pop(0)
            _calls.append(o["kind"])
            return FakeProc(o)

        et.asyncio.create_subprocess_exec = fake_exec
        d = workdir / f"agentic-{i}"
        (d / "out").mkdir(parents=True)
        md = d / "t.md"
        md.write_text("# trajectory\n")
        status = asyncio.run(et.evaluate_one(md, d / "out", "Judge {{TRAJECTORY_ID}}", "m", "claude",
                                             asyncio.Semaphore(1), 1, 1, False))
        res = d / "out" / "t.json"
        saved = json.loads(res.read_text()) if res.exists() else None
        print(json.dumps({"i": i, "status": status, "calls": len(calls), "saved": saved is not None,
                          "has_success": bool(saved) and "success" in saved}))
