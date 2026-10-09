"""Command line: run the service and manage local data.

cost-inspector serve [--host 127.0.0.1] [--port 8765]
cost-inspector seed-demo        # add the synthetic demo imports (idempotent)
cost-inspector reset-demo       # remove demo imports (and their comparisons), then re-seed
cost-inspector reset --yes      # delete every import and comparison
cost-inspector import FILE      # import an AUDR file or a Claude Code transcript from disk
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

from .config import LOOPBACK_HOSTS, Settings
from .demo import remove_demo, seed_demo
from .importer import ImportRejectedError, import_bytes
from .ingest import claude_code
from .store import DuplicateImportError, Store

#: Claude Code transcripts are mostly conversation text that the import discards, so
#: they may be much larger than an AUDR file.
MAX_TRANSCRIPT_BYTES = 1024**3


def _serve(args: argparse.Namespace) -> int:
    import uvicorn

    host = args.host or os.environ.get("ACI_HOST", "127.0.0.1")
    if host not in LOOPBACK_HOSTS and not args.allow_remote:
        print(
            f"Refusing to listen on {host}: the service has no authentication, so it binds to "
            "loopback only. Pass --allow-remote if you really mean to expose it.",
            file=sys.stderr,
        )
        return 2
    os.environ["ACI_HOST"] = host
    if args.port:
        os.environ["ACI_PORT"] = str(args.port)
    settings = Settings.from_env()
    if settings.static_dir and not (settings.static_dir / "index.html").is_file():
        print("Note: frontend/dist not built; only the API is served. Run `make build`.")
    print(f"AI Cost Inspector on http://{host}:{settings.port}  (data: {settings.db_path})")
    uvicorn.run(
        "cost_inspector.app:create_app",
        factory=True,
        host=host,
        port=settings.port,
        reload=args.reload,
        log_level="info",
    )
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="cost-inspector",
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    sub = parser.add_subparsers(dest="command", required=True)
    serve = sub.add_parser("serve", help="run the API and the built frontend")
    serve.add_argument("--host")
    serve.add_argument("--port", type=int)
    serve.add_argument("--reload", action="store_true", help="auto-reload on code changes")
    serve.add_argument(
        "--allow-remote",
        action="store_true",
        help="permit a non-loopback --host (no authentication!)",
    )
    sub.add_parser("seed-demo", help="add the synthetic demo imports")
    sub.add_parser("reset-demo", help="remove demo imports and seed them again")
    reset = sub.add_parser("reset", help="delete all imports and comparisons")
    reset.add_argument("--yes", action="store_true", help="confirm deletion")
    imp = sub.add_parser("import", help="import an AUDR file or a Claude Code transcript")
    imp.add_argument("path", type=Path)
    args = parser.parse_args(argv)

    if args.command == "serve":
        return _serve(args)

    settings = Settings.from_env()
    store = Store(settings.db_path)
    if args.command == "seed-demo":
        result = seed_demo(store, settings)
        print(
            f"Demo ready: {len(result['created'])} import(s) added, "
            f"{len(result['imports'])} present. ({settings.db_path})"
        )
        return 0
    if args.command == "reset-demo":
        removed = remove_demo(store)
        result = seed_demo(store, settings)
        print(f"Removed {removed} demo import(s); seeded {len(result['created'])}.")
        return 0
    if args.command == "reset":
        if not args.yes:
            print(
                "This deletes every import and comparison in "
                f"{settings.db_path}. Re-run with --yes to confirm.",
                file=sys.stderr,
            )
            return 2
        print(f"Deleted {store.delete_all()} import(s).")
        return 0
    if args.command == "import":
        path: Path = args.path
        if not path.is_file():
            print(f"Not a file: {path}", file=sys.stderr)
            return 2
        with path.open("rb") as fh:
            head = fh.read(64 * 1024)
        limit = settings.max_upload_bytes
        if claude_code.looks_like_transcript(head):
            limit = MAX_TRANSCRIPT_BYTES
        if path.stat().st_size > limit:
            print(f"{path} is larger than the {limit} byte limit.", file=sys.stderr)
            return 2
        try:
            summary = import_bytes(store, settings, path.read_bytes(), path.name)
        except DuplicateImportError as exc:
            print(f"Already imported as {exc.existing_id}.", file=sys.stderr)
            return 1
        except ImportRejectedError as exc:
            print(exc.message, file=sys.stderr)
            for issue in exc.issues.in_file_order():
                where = f"line {issue.line}" if issue.line else "file"
                print(f"  {where}: {issue.message}", file=sys.stderr)
                if issue.hint:
                    print(f"    → {issue.hint}", file=sys.stderr)
            if exc.issues.truncated:
                print(f"  …{exc.issues.total - len(exc.issues.items)} more", file=sys.stderr)
            return 1
        print(f"Imported {summary.accepted_count} record(s) as {summary.import_id}.")
        for note in summary.notes:
            print(f"  {note.severity}: {note.message}")
        return 0
    parser.error("unknown command")


if __name__ == "__main__":
    raise SystemExit(main())
