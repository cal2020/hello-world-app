"""Import issues: errors that reject a file and notes that accompany an accepted one."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Literal

Severity = Literal["error", "warning", "info"]


@dataclass(frozen=True)
class Issue:
    code: str
    message: str
    severity: Severity = "error"
    #: 1-based line where the record (or syntax error) starts.
    line: int | None = None
    column: int | None = None
    #: 1-based position of the record in the file (blank lines are not counted).
    item: int | None = None
    #: Dotted field path inside the record, e.g. ``usage.llm.input_tokens``.
    path: str | None = None
    #: How to fix the problem.
    hint: str | None = None
    #: Other lines a grouped note refers to.
    lines: tuple[int, ...] = ()

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {
            "code": self.code,
            "severity": self.severity,
            "message": self.message,
        }
        for key in ("line", "column", "item", "path", "hint"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        if self.lines:
            out["lines"] = list(self.lines)
        return out

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Issue:
        return cls(
            code=str(data["code"]),
            message=str(data["message"]),
            severity=data.get("severity", "error"),
            line=data.get("line"),
            column=data.get("column"),
            item=data.get("item"),
            path=data.get("path"),
            hint=data.get("hint"),
            lines=tuple(data.get("lines", ())),
        )


class IssueList:
    """Collects issues up to a cap while still counting every issue seen."""

    def __init__(self, limit: int) -> None:
        self.limit = limit
        self.items: list[Issue] = []
        self.total = 0

    def add(self, issue: Issue) -> None:
        self.total += 1
        if len(self.items) < self.limit:
            self.items.append(issue)

    def in_file_order(self) -> list[Issue]:
        """Issues sorted by line (stable, so per-record ordering is kept)."""
        return sorted(self.items, key=lambda i: (i.line or 0, i.item or 0))

    @property
    def truncated(self) -> bool:
        return self.total > len(self.items)

    def __bool__(self) -> bool:
        return self.total > 0

    def __len__(self) -> int:
        return self.total
