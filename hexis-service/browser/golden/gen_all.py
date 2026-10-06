"""Regenerate every golden file by running each gen_*.py (data first)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
scripts = sorted(HERE.glob("gen_*.py"), key=lambda p: (p.name != "gen_data.py", p.name))
failed = []
for s in scripts:
    if s.name == "gen_all.py":
        continue
    print(f"== {s.name}", flush=True)
    r = subprocess.run([sys.executable, str(s)], cwd=HERE)
    if r.returncode:
        failed.append(s.name)
if failed:
    print("FAILED:", ", ".join(failed))
    sys.exit(1)
print("all golden files regenerated")
