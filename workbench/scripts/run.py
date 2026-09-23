"""Start workbench (:8780) + mock consumer (:8781).  Usage: python scripts/run.py [--reset]"""
import argparse
import pathlib
import shutil
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lucidwb.stack import Stack  # noqa: E402

ap = argparse.ArgumentParser()
ap.add_argument("--var", default=str(ROOT / "var"))
ap.add_argument("--reset", action="store_true", help="delete local databases first (demo reset)")
a = ap.parse_args()
if a.reset and pathlib.Path(a.var).exists():
    shutil.rmtree(a.var)
s = Stack(a.var)
print(f"Workbench UI:   {s.wb_url}/")
print(f"Consumer view:  {s.consumer_url}/")
print("Simulated identities only (demo tokens). Ctrl+C to stop.")
try:
    while True:
        time.sleep(3600)
except KeyboardInterrupt:
    s.close()
