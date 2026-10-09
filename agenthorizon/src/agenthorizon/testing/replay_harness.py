"""Replay stand-in for a harness CLI (TEST ONLY). Runs inside the sandbox in place of claude/codex/gemini/
opencode/openhands, reads the staged trajectory exactly as a judge would, and prints output in that CLI's
native format. It never makes model calls; verdicts are a deterministic function of the staged text."""
import json, os, re, sys, glob, socket

kind = os.environ.get("AH_REPLAY_KIND", "claude")
args = sys.argv[1:]
stdin = sys.stdin.read() if not sys.stdin.isatty() else ""
blob = " ".join(args) + "\n" + stdin
m = re.search(r"Trajectory ID: `([0-9a-f-]{36})`", blob)
tid = m.group(1) if m else ""
md = open(f"agenthorizon_md/{tid}.md").read() if tid else ""
shots = re.findall(r"\]\((\./data/media/images/[^)]+)\)", md)
img_ok = bool(shots) and open(shots[-1], "rb").read(8).startswith(b"\x89PNG")
# try (and fail) to reach a non-allowlisted host through the proxy, to exercise the audit trail
try:
    s = socket.create_connection(("127.0.0.1", 3128), timeout=3)
    s.sendall(b"CONNECT example.com:443 HTTP/1.1\r\n\r\n"); s.recv(64); s.close()
except OSError:
    pass
fail = "gamma" in md or "email it" in md or "Desktop" in md or "November 11" in md
verdict = {"success": not fail, "reasoning": f"replay: read {len(md)} chars and {'a' if img_ok else 'no'} screenshot",
           "confidence": "low", "mistake_type": None if not fail else "Critical Mistake"}
text = "Checked the trajectory.\n```json\n" + json.dumps(verdict) + "\n```"
home = os.environ["HOME"]
if kind == "claude":
    sid = args[args.index("--session-id") + 1]
    d = os.path.join(home, ".claude", "projects", "-workspace"); os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, sid + ".jsonl"), "w") as f:
        for name, inp in (("Read", {"file_path": f"agenthorizon_md/{tid}.md"}), ("Read", {"file_path": shots[-1] if shots else ""})):
            f.write(json.dumps({"type": "assistant", "message": {"content": [{"type": "tool_use", "name": name, "input": inp}]}}) + "\n")
    print(json.dumps({"type": "result", "result": text, "total_cost_usd": None, "num_turns": 3,
                      "usage": {"input_tokens": 1234, "output_tokens": 56}, "modelUsage": {"replay-model": {}}}))
elif kind == "codex":
    print(json.dumps({"type": "item.completed", "item": {"type": "command_execution", "name": "shell"}}))
    print(json.dumps({"type": "item.completed", "item": {"type": "function_call", "name": "view_image"}}))
    print(json.dumps({"type": "item.completed", "item": {"type": "agent_message", "text": text}}))
    print(json.dumps({"type": "turn.completed", "usage": {"input_tokens": 999, "output_tokens": 77}}))
elif kind == "gemini":
    print(json.dumps({"response": text, "session_id": "abcd1234-0000", "stats": {"models": {"replay": {"tokens": {"prompt": 500, "candidates": 40, "thoughts": 10}, "api": {"totalRequests": 2}}}, "tools": {"totalCalls": 2}}}))
elif kind == "opencode":
    print(json.dumps({"type": "tool_use", "part": {"tool": "read", "state": {"input": {"filePath": shots[-1] if shots else ""}}}}))
    print(json.dumps({"type": "text", "part": {"text": text}}))
    print(json.dumps({"type": "step_finish", "part": {"cost": 0.0012, "tokens": {"input": 800, "output": 60}}}))
elif kind == "openhands":
    print("--JSON Event--\n" + json.dumps({"source": "agent", "action": {"kind": "ExecuteBashAction"}, "tool_name": "terminal"}))
    print("--JSON Event--\n" + json.dumps({"source": "agent", "action": {"kind": "FinishAction", "message": text}}))
