"""Tiny HTTP client used by the seed/demo/eval scripts and tests."""
import json
import os
import pathlib
import urllib.error
import urllib.request

FIX = pathlib.Path(__file__).resolve().parent.parent / "fixtures"


class Client:
    def __init__(self, base, token="demo-carol"):
        self.base = base.rstrip("/")
        self.token = token

    def as_(self, token):
        return Client(self.base, token)

    def req(self, method, path, body=None, raw=None, headers=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        r = urllib.request.Request(self.base + path, data=data, method=method)
        r.add_header("Content-Type", "application/json")
        if self.token:
            r.add_header("Authorization", f"Bearer {self.token}")
        if os.environ.get("LWB_ACCESS_CODE"):
            r.add_header("X-Access-Code", os.environ["LWB_ACCESS_CODE"])
        for k, v in (headers or {}).items():
            r.add_header(k, v)
        try:
            with urllib.request.urlopen(r, timeout=60) as resp:
                return resp.status, json.loads(resp.read() or b"null"), dict(resp.headers)
        except urllib.error.HTTPError as e:
            txt = e.read()
            try:
                return e.code, json.loads(txt), dict(e.headers)
            except ValueError:
                return e.code, {"raw": txt.decode(errors="replace")}, dict(e.headers)

    def get(self, path, **kw):
        return self.req("GET", path, **kw)

    def post(self, path, body=None, **kw):
        return self.req("POST", path, body=body, **kw)

    def import_fixture(self, rel, project="ehm", key=None):
        raw = (FIX / rel).read_bytes()
        return self.post(f"/manage/projects/{project}/imports", raw=raw,
                         headers={"Idempotency-Key": key} if key else None)

    def projection(self, rel):
        return json.loads((FIX / "projections" / rel).read_text())
