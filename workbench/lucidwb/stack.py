"""Start the workbench and the mock consumer together (one local startup path)."""
import pathlib
import threading

from consumer_app import app as consumer
from . import outbox, release, server


class Stack:
    def __init__(self, var_dir, wb_port=8780, consumer_port=8781, start_worker=True, wb_host="127.0.0.1"):
        var = pathlib.Path(var_dir)
        var.mkdir(parents=True, exist_ok=True)
        self.wb = server.serve(str(var / "workbench.db"), host=wb_host, port=wb_port,
                               start_worker=False)
        self.cons = consumer.serve(str(var / "consumer.db"), port=consumer_port)
        self.wb_url = f"http://127.0.0.1:{self.wb.server_address[1]}"  # loopback for internal calls
        self.consumer_url = f"http://127.0.0.1:{self.cons.server_address[1]}"
        # Wire the two processes' addresses (module-level settings, read at call time).
        release.PUBLIC_URL = self.wb_url
        release.CONSUMER_URL = self.consumer_url
        outbox.SUBSCRIBERS[0]["url"] = self.consumer_url + "/events"
        consumer.WORKBENCH = self.wb_url
        self.app = server.Handler.app
        self.consumer_store = consumer.Handler.store
        self.threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in (self.wb, self.cons)]
        for t in self.threads:
            t.start()
        if start_worker:
            self.app.worker.start()

    def close(self):
        self.app.worker.stop()
        for s in (self.wb, self.cons):
            s.shutdown()
            s.server_close()
