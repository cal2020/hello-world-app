"""Local fake LLM HTTP endpoints for transport tests (TEST ONLY; no model is involved).

Captures every request body so tests can verify the payload that actually went over the wire, and serves
scripted responses (including 429/5xx/413) for OpenAI-compatible, Anthropic Messages, and Gemini routes.
"""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class FakeLLMServer:
    def __init__(self) -> None:
        self.requests: list[dict] = []
        self.script: list[tuple[int, dict, dict]] = []  # (status, headers, json body) consumed in order
        self.default: tuple[int, dict, dict] | None = None
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *a):  # quiet
                pass

            def do_POST(self):
                n = int(self.headers.get("content-length") or 0)
                body = self.rfile.read(n)
                try:
                    parsed = json.loads(body)
                except ValueError:
                    parsed = None
                server.requests.append({"path": self.path, "headers": dict(self.headers), "body": parsed, "raw": body})
                status, headers, payload = server.script.pop(0) if server.script else (server.default or (500, {}, {"error": "unscripted"}))
                data = json.dumps(payload).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                for k, v in headers.items():
                    self.send_header(k, v)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def __enter__(self) -> FakeLLMServer:
        self.thread.start()
        return self

    def __exit__(self, *exc) -> None:
        self.httpd.shutdown()


def anthropic_message(text: str, model: str = "claude-opus-4-7") -> dict:
    return {"id": "msg_test", "type": "message", "role": "assistant", "model": model,
            "content": [{"type": "text", "text": text}], "stop_reason": "end_turn", "stop_sequence": None,
            "usage": {"input_tokens": 1500, "output_tokens": 40}}


def gemini_response(text: str) -> dict:
    return {"candidates": [{"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}],
            "usageMetadata": {"promptTokenCount": 2000, "candidatesTokenCount": 30, "totalTokenCount": 2030},
            "modelVersion": "gemini-test"}


def openai_response(text: str, model: str = "test-model") -> dict:
    return {"id": "x", "model": model, "choices": [{"index": 0, "message": {"role": "assistant", "content": text},
                                                    "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 1800, "completion_tokens": 35}}
