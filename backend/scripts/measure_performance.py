"""Measure import and API latency against a running server, over HTTP.

    uv run python scripts/generate_large_fixture.py /tmp/large.jsonl
    ACI_DB_PATH=/tmp/perf.sqlite3 uv run cost-inspector serve --port 8770 &
    uv run python scripts/measure_performance.py /tmp/large.jsonl --base http://127.0.0.1:8770

Each import is deleted afterwards, so the target database ends as it started.
Prints the machine, the fixture and a Markdown table of medians.
"""

from __future__ import annotations

import argparse
import json
import os
import platform
import statistics
import time
import urllib.request
from pathlib import Path
from typing import Any

HEADERS = {"X-Requested-With": "cost-inspector"}


def request(base: str, method: str, path: str, data: bytes | None = None) -> tuple[float, bytes]:
    # main() only accepts http(s) base URLs.
    req = urllib.request.Request(base + path, data=data, method=method, headers=HEADERS)  # noqa: S310
    start = time.perf_counter()
    with urllib.request.urlopen(req, timeout=600) as response:  # noqa: S310
        body = response.read()
    return time.perf_counter() - start, body


def machine() -> str:
    cpu = platform.processor() or platform.machine()
    cpuinfo = Path("/proc/cpuinfo")
    if cpuinfo.exists():
        for line in cpuinfo.read_text().splitlines():
            if line.startswith("model name"):
                cpu = line.split(":", 1)[1].strip()
                break
    memory = ""
    meminfo = Path("/proc/meminfo")
    if meminfo.exists():
        kib = int(meminfo.read_text().split()[1])
        memory = f", {kib / 1024 / 1024:.1f} GiB RAM"
    return (
        f"{cpu}, {os.cpu_count()} logical CPUs{memory}; {platform.system()} "
        f"{platform.release()}; Python {platform.python_version()}"
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("fixture", type=Path)
    parser.add_argument("--base", default="http://127.0.0.1:8765")
    parser.add_argument("--imports", type=int, default=3, help="import repetitions")
    parser.add_argument("--reads", type=int, default=7, help="repetitions per read endpoint")
    args = parser.parse_args()
    if not args.base.startswith(("http://", "https://")):
        parser.error("--base must be an http(s) URL")
    data = args.fixture.read_bytes()
    records = sum(1 for line in data.splitlines() if line.strip())
    rows: list[tuple[str, list[float], int]] = []

    import_times: list[float] = []
    detail: dict[str, Any] = {}
    for attempt in range(args.imports):
        elapsed, body = request(
            args.base, "POST", f"/api/imports?filename={args.fixture.name}", data
        )
        import_times.append(elapsed)
        detail = json.loads(body)
        if attempt < args.imports - 1:
            request(args.base, "DELETE", f"/api/imports/{detail['id']}")
    rows.append(
        (f"Import (upload, validate, analyze, store; {records:,} records)", import_times, len(body))
    )

    try:
        rows += measure_reads(args.base, detail, args.reads)
    finally:
        request(args.base, "DELETE", f"/api/imports/{detail['id']}")

    print(f"Machine: {machine()}")
    print(f"Fixture: {args.fixture.name}, {len(data):,} bytes, {records:,} records")
    print("Method: wall-clock HTTP round trip from a local client (urllib, loopback).\n")
    print("| Operation | Median | Min | Max | Response |")
    print("| --- | ---: | ---: | ---: | ---: |")
    for label, times, size in rows:
        print(
            f"| {label} | {statistics.median(times) * 1000:,.0f} ms | {min(times) * 1000:,.0f} ms "
            f"| {max(times) * 1000:,.0f} ms | {size / 1024:,.0f} KiB |"
        )


def plural(calls: int) -> str:
    return f"{calls:,} call" + ("" if calls == 1 else "s")


def measure_reads(
    base: str, detail: dict[str, Any], repeat: int
) -> list[tuple[str, list[float], int]]:
    findings = sorted(detail["findings"], key=lambda f: f["affected_count"])
    middle = findings[len(findings) // 2]
    run = max(detail["runs"], key=lambda r: r["calls"])
    reads = [
        ("List imports", "/api/imports"),
        (f"Import detail ({len(findings):,} findings)", f"/api/imports/{detail['id']}"),
        (f"Run detail ({run['calls']:,} calls)", f"/api/runs/{run['id']}"),
        (
            f"Finding detail, median size ({plural(middle['affected_count'])})",
            f"/api/findings/{middle['id']}",
        ),
        (
            f"Finding detail, largest ({plural(findings[-1]['affected_count'])})",
            f"/api/findings/{findings[-1]['id']}",
        ),
        ("JSON report", f"/api/imports/{detail['id']}/report?format=json"),
    ]
    rows = []
    for label, path in reads:
        times, size = [], 0
        for _ in range(repeat):
            elapsed, body = request(base, "GET", path)
            times.append(elapsed)
            size = len(body)
        rows.append((label, times, size))
    return rows


if __name__ == "__main__":
    main()
