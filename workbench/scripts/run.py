"""Start workbench + mock consumer (one local startup path, also the container entrypoint).

  python scripts/run.py [--reset] [--seed]

Environment (all optional):
  PORT / LWB_PORT          public port of the workbench (default 8780)
  LWB_HOST                 bind address (default 127.0.0.1; the container uses 0.0.0.0)
  LWB_VAR                  data directory for the SQLite files (default workbench/var)
  LWB_ACCESS_CODE          if set, every page and API call needs this code (login page / X-Access-Code)
  LWB_RESET_ON_START=1     wipe the data directory at start (clean demo on every restart)
  LWB_SEED_ON_START=1      seed projections + CMMS records if the database is empty
The consumer always binds to 127.0.0.1; its dashboard is proxied at /consumer/.
"""
import argparse
import os
import pathlib
import shutil
import signal
import sys
import threading

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from lucidwb.stack import Stack  # noqa: E402
from scripts.seed import seed  # noqa: E402

env = os.environ.get
ap = argparse.ArgumentParser()
ap.add_argument("--var", default=env("LWB_VAR", str(ROOT / "var")))
ap.add_argument("--reset", action="store_true", default=env("LWB_RESET_ON_START") == "1",
                help="delete local databases first (demo reset)")
ap.add_argument("--seed", action="store_true", default=env("LWB_SEED_ON_START") == "1",
                help="seed baseline data if the database is empty")
ap.add_argument("--host", default=env("LWB_HOST", "127.0.0.1"))
ap.add_argument("--port", type=int, default=int(env("PORT") or env("LWB_PORT") or 8780))
a = ap.parse_args()

if a.reset and pathlib.Path(a.var).exists():
    for child in pathlib.Path(a.var).iterdir():  # keep the dir itself (it may be a mounted volume)
        shutil.rmtree(child) if child.is_dir() else child.unlink()
s = Stack(a.var, wb_host=a.host, wb_port=a.port)
if a.seed:
    c = s.app.db.read()
    if not c.execute("SELECT 1 FROM projection_definition LIMIT 1").fetchone():
        seed(s.wb_url)
        print("seeded baseline (projections + CMMS records)")
print(f"Workbench:  http://{a.host}:{a.port}/   consumer dashboard: /consumer/")
print("Access gate:", "ON" if env("LWB_ACCESS_CODE") else "off (local mode)")
print("Simulated identities only (demo tokens). Synthetic data only.")
stop = threading.Event()
signal.signal(signal.SIGTERM, lambda *_: stop.set())
try:
    stop.wait()
except KeyboardInterrupt:
    pass
s.close()
