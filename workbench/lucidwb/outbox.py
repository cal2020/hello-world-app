"""Transactional outbox delivery (at-least-once, ordered per project).

Events are written in the same transaction as the state change that caused them. A worker
delivers them in per-project sequence order; event N is not sent until N-1 is acknowledged.
A lost acknowledgment leads to redelivery; the consumer deduplicates by event_id.
"""
import http.client
import json
import os
import threading
import time
import urllib.parse

from .util import now

SUBSCRIBERS = [{"id": "dashboard-consumer", "url": os.environ.get("LWB_CONSUMER_URL", "http://127.0.0.1:8781") +
                "/events", "projects": ["ehm"]}]


def _post(url, body, timeout=10):
    u = urllib.parse.urlparse(url)
    conn = http.client.HTTPConnection(u.hostname, u.port, timeout=timeout)
    try:
        conn.request("POST", u.path, body=json.dumps(body), headers={"Content-Type": "application/json"})
        resp = conn.getresponse()
        return resp.status, resp.read().decode(errors="replace")[:300]
    finally:
        conn.close()


class OutboxWorker:
    def __init__(self, db, interval=0.5):
        self.db = db
        self.interval = interval
        self.paused = set()  # projects whose automatic delivery is paused (a forced pass still delivers)
        self._stop = threading.Event()
        self._lock = threading.Lock()
        self.thread = None

    def start(self):
        self.thread = threading.Thread(target=self._run, name="outbox", daemon=True)
        self.thread.start()

    def stop(self):
        self._stop.set()

    def _run(self):
        while not self._stop.is_set():
            try:
                self.deliver_pass()
            except Exception as e:  # keep the worker alive; failures are recorded per event
                print("outbox worker error:", e)
            self._stop.wait(self.interval)

    def deliver_pass(self, force=False, projects=None):
        """Deliver the next ready event of each project (only `projects`, when given). A forced pass ignores
        backoff and pauses. Returns a list of outcomes."""
        with self._lock:
            c = self.db.read()
            outcomes = []
            pending = [r["project"] for r in c.execute(
                "SELECT DISTINCT project FROM outbox_event WHERE delivered_at IS NULL")]
            for project in pending:
                if (projects is not None and project not in projects) or (not force and project in self.paused):
                    continue
                ev = c.execute("SELECT * FROM outbox_event WHERE project=? AND delivered_at IS NULL ORDER BY seq LIMIT 1",
                               (project,)).fetchone()
                if not ev or (not force and ev["next_attempt_at"] > time.time()):
                    continue
                try:
                    outcomes.append(self._deliver(ev))
                except Exception as e:  # one project's failure must not hold up the other projects' events
                    print("outbox worker error:", project, e)
                    outcomes.append({"event_id": ev["event_id"], "seq": ev["seq"], "type": ev["type"],
                                     "attempt": ev["attempts"] + 1, "outcome": "worker_error",
                                     "detail": f"{type(e).__name__}: {e}"})
            return outcomes

    def _deliver(self, ev, redelivery=False):
        subs = [s for s in SUBSCRIBERS if ev["project"] in s["projects"]]
        attempt = ev["attempts"] + 1
        body = {"event_id": ev["event_id"], "project": ev["project"], "seq": ev["seq"], "type": ev["type"],
                "payload": json.loads(ev["payload_json"]), "created_at": ev["created_at"], "attempt": attempt}
        if not subs:
            outcome, detail, ok = "no_subscriber", None, True
        else:
            try:
                st, text = _post(subs[0]["url"], body)
                ok = 200 <= st < 300
                outcome, detail = ("acknowledged" if ok else f"http_{st}"), text
            except (OSError, http.client.HTTPException) as e:
                ok, outcome, detail = False, "no_acknowledgment", f"{type(e).__name__}: {e}"
        with self.db.tx() as c:
            c.execute("INSERT OR REPLACE INTO delivery_attempt VALUES (?,?,?,?,?)",
                      (ev["event_id"], attempt, now(), outcome + (" (forced redelivery)" if redelivery else ""), detail))
            if ok:
                c.execute("UPDATE outbox_event SET attempts=?, delivered_at=COALESCE(delivered_at, ?), last_error=NULL "
                          "WHERE event_id=?", (attempt, now(), ev["event_id"]))
            else:
                backoff = min(10.0, 0.5 * 2 ** min(attempt - 1, 5))  # bounded exponent: no float overflow
                c.execute("UPDATE outbox_event SET attempts=?, last_error=?, next_attempt_at=? WHERE event_id=?",
                          (attempt, f"{outcome}: {detail}", time.time() + backoff, ev["event_id"]))
        return {"event_id": ev["event_id"], "seq": ev["seq"], "type": ev["type"], "attempt": attempt,
                "outcome": outcome, "detail": detail}

    def redeliver(self, event_id):
        """Fault-injection helper: send an already-delivered event again (duplicate delivery). A pending event
        is not sent: that would overtake earlier events of its project."""
        with self._lock:
            ev = self.db.read().execute("SELECT * FROM outbox_event WHERE event_id=? AND delivered_at IS NOT NULL",
                                        (event_id,)).fetchone()
            return self._deliver(ev, redelivery=True) if ev else None
