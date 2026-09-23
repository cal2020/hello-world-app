"""The ONLY deletion path for operation receipts. Deletes receipts past expires_at.

After a receipt is purged, a retry with that Idempotency-Key is treated as a new request.
Never run this during a demo run. Usage: python scripts/purge_receipts.py var/workbench.db
"""
import sqlite3
import sys
import time

db = sqlite3.connect(sys.argv[1] if len(sys.argv) > 1 else "var/workbench.db")
cutoff = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
n = db.execute("DELETE FROM operation_receipt WHERE expires_at < ?", (cutoff,)).rowcount
db.commit()
print(f"purged {n} expired receipts (cutoff {cutoff})")
