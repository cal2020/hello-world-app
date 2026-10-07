"""FastAPI application: JSON API under /api and the built frontend at /."""

from __future__ import annotations

import json
import logging
import re
import unicodedata
from pathlib import Path
from typing import Any, Literal
from urllib.parse import quote

from fastapi import FastAPI, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.middleware.trustedhost import TrustedHostMiddleware

from . import __version__, report, views
from .analysis import catalog, kora
from .compare import EQUIVALENCE_CHOICES, ComparisonError, compare_runs
from .config import Settings
from .demo import remove_demo, seed_demo
from .importer import ImportRejectedError, delete_run, import_bytes
from .ingest.normalize import DROPPED_FIELDS
from .ingest.validate import AUDR_SPEC_VERSION
from .store import DuplicateImportError, Store

log = logging.getLogger("cost_inspector")

CLIENT_HEADER = "x-requested-with"
CLIENT_HEADER_VALUE = "cost-inspector"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
APP_CSP = (
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
    "base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
)
REPORT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:"


class StrictJSONResponse(JSONResponse):
    """Serializes with the standard library and fails on Decimal or NaN, so money can
    never silently become a float on its way out."""

    def render(self, content: Any) -> bytes:
        return json.dumps(
            content, ensure_ascii=False, allow_nan=False, separators=(",", ":")
        ).encode("utf-8")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, **extra: Any) -> None:
        super().__init__(message)
        self.status, self.code, self.message, self.extra = status, code, message, extra


def error_response(status: int, code: str, message: str, **extra: Any) -> StrictJSONResponse:
    return StrictJSONResponse({"error": {"code": code, "message": message, **extra}}, status)


class DismissBody(BaseModel):
    dismissed: bool
    note: str | None = Field(default=None, max_length=2000)


class ComparisonBody(BaseModel):
    baseline_run_id: str = Field(min_length=1, max_length=80)
    candidate_run_id: str = Field(min_length=1, max_length=80)
    equivalence: Literal["equivalent", "not_equivalent", "unsure"]
    note: str | None = Field(default=None, max_length=1000)


def clean_note(text: str | None) -> str | None:
    if text is None:
        return None
    kept = "".join(ch for ch in text if ch in "\n\t" or unicodedata.category(ch)[0] != "C").strip()
    return kept or None


def content_disposition(filename: str) -> str:
    ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "-", filename).strip("-.") or "report"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(filename)}"


def report_filename(stem: str, suffix: str) -> str:
    base = re.sub(r"\.(jsonl|json|ndjson|txt)$", "", stem, flags=re.IGNORECASE)
    return f"{base}-cost-report.{suffix}"


def meta(settings: Settings, store: Store) -> dict[str, Any]:
    imports = store.list_imports()
    return {
        "app": {"name": "AI Cost Inspector", "version": __version__},
        "analyzer": kora.ANALYZER.to_json(),
        "audr_spec_version": AUDR_SPEC_VERSION,
        "limits": {
            "max_upload_bytes": settings.max_upload_bytes,
            "max_records": settings.max_records,
        },
        "accepted_formats": ["jsonl", "json-array", "json-object"],
        "glossary": catalog.GLOSSARY,
        "categories": {
            cat: {
                "label": info["label"],
                "plural": info["plural"],
                "rule": catalog.rule_for(cat),
                "limitations": info["limitations"],
                "ratio": str(kora.SCENARIO_RATIOS[cat]),
            }
            for cat, info in catalog.CATEGORY_INFO.items()
        },
        "dropped_fields": list(DROPPED_FIELDS),
        "demo": {"loaded": any(i.source == "demo" for i in imports)},
        "counts": {"imports": len(imports)},
    }


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()
    store = Store(settings.db_path)
    app = FastAPI(
        title="AI Cost Inspector",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url="/api/openapi.json",
    )
    app.state.settings = settings
    app.state.store = store
    allowed_origins = settings.allowed_origins

    @app.middleware("http")
    async def guard(request: Request, call_next: Any) -> Response:
        if request.method not in SAFE_METHODS and request.url.path.startswith("/api/"):
            origin = request.headers.get("origin")
            if origin and origin not in allowed_origins:
                return error_response(
                    403, "forbidden_origin", "Requests from this origin are not accepted."
                )
            if request.headers.get("sec-fetch-site") == "cross-site":
                return error_response(
                    403, "forbidden_origin", "Cross-site requests are not accepted."
                )
            if request.headers.get(CLIENT_HEADER) != CLIENT_HEADER_VALUE:
                return error_response(
                    403,
                    "missing_client_header",
                    f"Changes require the header {CLIENT_HEADER.title()}: {CLIENT_HEADER_VALUE}.",
                )
        response: Response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "no-referrer")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Cross-Origin-Opener-Policy", "same-origin")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    # Added last so it runs first: reject unexpected Host headers (DNS rebinding).
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=settings.allowed_hosts)

    @app.exception_handler(ApiError)
    async def _api_error(_request: Request, exc: ApiError) -> Response:
        return error_response(exc.status, exc.code, exc.message, **exc.extra)

    @app.exception_handler(ImportRejectedError)
    async def _rejected(_request: Request, exc: ImportRejectedError) -> Response:
        return error_response(
            422,
            "invalid_file",
            exc.message,
            issues=[issue.to_json() for issue in exc.issues.in_file_order()],
            issue_count=exc.issues.total,
            truncated=exc.issues.truncated,
            records_seen=exc.records_seen,
        )

    @app.exception_handler(DuplicateImportError)
    async def _duplicate(_request: Request, exc: DuplicateImportError) -> Response:
        return error_response(
            409,
            "already_imported",
            "This exact file is already imported. Open the existing import, or delete it "
            "first to import it again.",
            import_id=exc.existing_id,
        )

    @app.exception_handler(RequestValidationError)
    async def _invalid_request(_request: Request, exc: RequestValidationError) -> Response:
        problems = []
        for err in exc.errors():
            where = ".".join(str(p) for p in err.get("loc", ()) if p not in ("body", "query"))
            problems.append(f"{where or 'request'}: {err.get('msg', 'invalid')}")
        return error_response(400, "bad_request", "The request is invalid. " + "; ".join(problems))

    @app.exception_handler(StarletteHTTPException)
    async def _http(_request: Request, exc: StarletteHTTPException) -> Response:
        code = "not_found" if exc.status_code == 404 else "http_error"
        message = "Not found." if exc.status_code == 404 else str(exc.detail)
        return error_response(exc.status_code, code, message)

    @app.exception_handler(Exception)
    async def _unexpected(_request: Request, exc: Exception) -> Response:
        log.exception("unhandled error", exc_info=exc)
        return error_response(
            500,
            "internal",
            "Something went wrong in the local analysis service. Check the server log.",
        )

    def ok(content: Any, status: int = 200) -> StrictJSONResponse:
        return StrictJSONResponse(content, status)

    # ------------------------------------------------------------------ routes

    @app.get("/api/meta")
    def get_meta() -> Response:
        return ok(meta(settings, store))

    @app.get("/api/imports")
    def get_imports() -> Response:
        return ok({"imports": views.list_imports(store)})

    @app.post("/api/imports")
    async def post_import(request: Request, filename: str | None = None) -> Response:
        limit = settings.max_upload_bytes
        declared = request.headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            raise ApiError(413, "too_large", _too_large(limit), limit_bytes=limit)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > limit:
                raise ApiError(413, "too_large", _too_large(limit), limit_bytes=limit)
        if not body:
            raise ApiError(400, "empty_upload", "The upload was empty. Choose an AUDR file.")
        log.info("import requested: %d bytes", len(body))
        summary = await run_in_threadpool(import_bytes, store, settings, bytes(body), filename)
        detail = views.import_detail(store, summary.import_id)
        return ok(detail, 201)

    @app.get("/api/imports/{import_id}")
    def get_import(import_id: str) -> Response:
        detail = views.import_detail(store, import_id)
        if detail is None:
            raise ApiError(
                404, "not_found", "That import does not exist (it may have been deleted)."
            )
        return ok(detail)

    @app.delete("/api/imports/{import_id}")
    def remove_import(import_id: str) -> Response:
        counts = store.delete_import(import_id)
        if counts is None:
            raise ApiError(404, "not_found", "That import does not exist.")
        return ok({"deleted": "import", "import_id": import_id, **counts})

    @app.get("/api/imports/{import_id}/report")
    def import_report(import_id: str, format: Literal["json", "html"] = "json") -> Response:
        data = report.import_report(store, import_id)
        imp = store.get_import(import_id)
        if data is None or imp is None:
            raise ApiError(404, "not_found", "That import does not exist.")
        return _download(data, report_filename(imp.filename, format), format)

    @app.get("/api/runs/{run_pk}")
    def get_run(run_pk: str) -> Response:
        detail = views.run_detail(store, run_pk)
        if detail is None:
            raise ApiError(404, "not_found", "That run does not exist (it may have been deleted).")
        return ok(detail)

    @app.delete("/api/runs/{run_pk}")
    def remove_run(run_pk: str) -> Response:
        result = delete_run(store, run_pk)
        if result is None:
            raise ApiError(404, "not_found", "That run does not exist.")
        return ok(result)

    @app.get("/api/findings/{finding_id}")
    def get_finding(finding_id: str) -> Response:
        detail = views.finding_detail(store, finding_id)
        if detail is None:
            raise ApiError(
                404, "not_found", "That finding does not exist (it may have been re-analyzed)."
            )
        return ok(detail)

    @app.patch("/api/findings/{finding_id}")
    def patch_finding(finding_id: str, body: DismissBody) -> Response:
        if not store.set_dismissal(finding_id, body.dismissed, clean_note(body.note)):
            raise ApiError(404, "not_found", "That finding does not exist.")
        detail = views.finding_detail(store, finding_id)
        assert detail is not None
        return ok(detail)

    def _run_summary(run_pk: str, role: str) -> dict[str, Any]:
        run = store.get_run(run_pk)
        if run is None:
            raise ApiError(404, "not_found", f"The {role} run does not exist.")
        imp = store.get_import(run.import_id)
        assert imp is not None
        return views.run_summary_json(run, imp, store.finding_counts())

    def _compare(baseline: str, candidate: str, equivalence: str) -> dict[str, Any]:
        base = _run_summary(baseline, "baseline")
        cand = _run_summary(candidate, "candidate")
        try:
            return compare_runs(
                base,
                cand,
                store.load_calls(base["import_id"], baseline),
                store.load_calls(cand["import_id"], candidate),
                equivalence,
            )
        except ComparisonError as exc:
            raise ApiError(400, "invalid_comparison", str(exc)) from exc

    @app.get("/api/compare")
    def get_compare(baseline: str, candidate: str, equivalence: str | None = None) -> Response:
        if equivalence not in EQUIVALENCE_CHOICES:
            raise ApiError(
                400,
                "equivalence_required",
                "Mark whether the two runs did equivalent work (same task and input) before "
                "comparing them.",
            )
        return ok(_compare(baseline, candidate, equivalence))

    @app.get("/api/comparisons")
    def get_comparisons() -> Response:
        items = []
        for row in store.list_comparisons():
            item = report.comparison_json(store, row)
            if item is not None:
                items.append(item)
        return ok({"comparisons": items})

    @app.post("/api/comparisons")
    def post_comparison(body: ComparisonBody) -> Response:
        _compare(body.baseline_run_id, body.candidate_run_id, body.equivalence)  # validates
        row = store.insert_comparison(
            body.baseline_run_id, body.candidate_run_id, body.equivalence, clean_note(body.note)
        )
        item = report.comparison_json(store, row)
        return ok(item, 201)

    @app.delete("/api/comparisons/{comparison_id}")
    def remove_comparison(comparison_id: str) -> Response:
        if not store.delete_comparison(comparison_id):
            raise ApiError(404, "not_found", "That comparison does not exist.")
        return ok({"deleted": "comparison", "comparison_id": comparison_id})

    @app.get("/api/comparisons/{comparison_id}/report")
    def comparison_report(comparison_id: str, format: Literal["json", "html"] = "json") -> Response:
        data = report.comparison_report(store, comparison_id)
        if data is None:
            raise ApiError(404, "not_found", "That comparison does not exist.")
        return _download(data, f"comparison-{comparison_id}-report.{format}", format)

    @app.post("/api/demo")
    def post_demo() -> Response:
        return ok(seed_demo(store, settings), 201)

    @app.delete("/api/demo")
    def delete_demo() -> Response:
        return ok({"deleted": "demo", "imports": remove_demo(store)})

    @app.api_route("/api/{rest:path}", methods=["GET", "POST", "PATCH", "PUT", "DELETE"])
    def api_not_found(rest: str) -> Response:
        raise ApiError(404, "not_found", "Unknown API endpoint.")

    _mount_frontend(app, settings.static_dir)
    return app


def _too_large(limit: int) -> str:
    return (
        f"The file is larger than {limit / (1024 * 1024):.0f} MiB, the limit for one import. "
        "Split it by run, or raise ACI_MAX_UPLOAD_BYTES for this local service."
    )


def _download(data: dict[str, Any], filename: str, fmt: str) -> Response:
    if fmt == "html":
        body = report.render_html(data).encode("utf-8")
        media = "text/html; charset=utf-8"
        csp = REPORT_CSP
    else:
        body = json.dumps(data, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
        media = "application/json"
        csp = "default-src 'none'"
    return Response(
        body,
        media_type=media,
        headers={
            "Content-Disposition": content_disposition(filename),
            "Content-Security-Policy": csp,
        },
    )


def _mount_frontend(app: FastAPI, static_dir: Path | None) -> None:
    if static_dir is None or not (static_dir / "index.html").is_file():

        @app.get("/", include_in_schema=False)
        def no_frontend() -> Response:
            return Response(
                "AI Cost Inspector API is running. Build the frontend (make build) to serve the "
                "app here, or use the Vite dev server (make dev).",
                media_type="text/plain",
            )

        return

    root = static_dir.resolve()
    if (root / "assets").is_dir():
        app.mount("/assets", StaticFiles(directory=root / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str) -> Response:
        candidate = (root / path).resolve()
        if path and candidate.is_file() and root in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(root / "index.html", headers={"Content-Security-Policy": APP_CSP})
