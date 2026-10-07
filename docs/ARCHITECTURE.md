# Architecture

## Plan and approach

The brief asks for a supervision layer on top of Zit, without replacing its isolation or integration engine. Zit 0.1.1 was published on 2026-10-07 under GPL-2.0-only, and it already ships a web view (`zit web`). That view is deliberately **read-only**: `src/web.rs` rejects every method but GET. Mutating actions (open a workspace, claim, record, check, accept, retry, discard, dispose) are only available through the CLI and MCP server.

Switchyard therefore adds a **thin local adapter**. It is a Node service that calls `zit --json <subcommand>` and returns typed results to a React UI. It does not fork or link Zit. The engine is the authority for every workspace, change, claim, status and piece of evidence. Switchyard stores only what Zit has no place for: task titles, owners and notes, command approvals, check-run history, and a journal of operations.

## Components

```
web/ (React 19, Tailwind 4, Radix, motion, TanStack Query)
  │  polls GET /api/repos/:id/state every 2.5 s while visible
  ▼
server/http.ts        loopback-only HTTP, Host/Origin/header guards, static files
server/lib/service.ts application layer: validation, approvals, jobs, journal
  ├─ zit.ts           Zit CLI adapter (execFile, no shell, --flag=value args)
  ├─ git.ts           read-only git: zit.toml at a rev, diffs, mainline log
  ├─ board.ts         pure: engine overview + annotations → lanes, actions, overlaps
  ├─ commands.ts      pure: zit.toml → commands per operation, approval keys
  ├─ redact.ts        pure: bounded, secret-masked check output
  ├─ cow.ts           copy-on-write probe (same syscalls as Zit's probe)
  └─ store.ts         versioned JSON file, atomic write-and-rename
shared/               types shared by server and UI (engine shapes, API contracts)
```

### Engine calls (verified against Zit 0.1.1 `src/main.rs`)

| Action | Command | Notes |
|---|---|---|
| Board | `zit --json status` | Workspaces with live writes, claims and overlaps; changes with status |
| Change detail | `zit --json show -- <id>` | Status, writes, evidence |
| New task | `zit --json materialise --intent=… --agent=<owner> --session=switchyard:<task>` | The session links engine objects to the task |
| Claim | `zit --json claim --workspace=<id> -- <resources…>` | Exit 1 means refused; the JSON says who holds what |
| Record | `zit --json record --workspace=<id> [--summary=…]` | |
| Check | `zit --json check [--rerun] -- <id>` | Exit 1 means a check failed |
| Accept | `zit --json accept -- <id>` | Exit 1 means rejected (stale, conflict or failed) |
| Retry | `zit --json retry -- <id>` | New workspace on current, same session |
| Discard / dispose | `zit --json discard -- <id>`, `zit --json dispose -- <ws>` | Only after typed confirmation |
| Initialise | `zit --json init` | Only on an explicit click |

Text a person typed (titles, summaries) goes into a single `--flag=value` argument. Resources go after `--`. Nothing is passed through a shell.

## Data model

Engine objects (`shared/engine-types.ts`) mirror Zit's serde output: `Change`, `ChangeRow` (change plus `Status`), `WorkspaceRow`, `Overlap`, `Evidence`, `Verdict`, `Claimed`, `Outcome`.

Switchyard's own records (`shared/api.ts`, persisted in `.switchyard/switchyard.json`, `schemaVersion: 1`):

| Record | Holds |
|---|---|
| `Repo` | id, name, absolute path, `demo` flag |
| `Task` | title, owner, notes, and the change ids Zit reported for it (needed to recognise them once accepted, when they leave Zit's speculative list) |
| `ApprovedCommand` | sha256 of kind + name + exact command text |
| `CheckRun` | verdicts with redacted output, status, message |
| `Operation` | journal entry: pending → done, failed, cancelled or interrupted |

`TaskView` is derived on every request by `board.ts`. Nothing about lanes or eligibility is stored.

### Lanes

`laneFor()` reads, in this order:

1. A workspace with unrecorded edits, or a retry workspace → **Editing**.
2. Otherwise the newest pending change: `invalid/failed` → **Check failed**; `invalid/stale` or `invalid/conflict` → **Conflict**; `speculative` or `verified` → **Waiting**; `invalid/error` → **Engine error**.
3. Otherwise a recorded change that Zit reports as accepted → **Accepted**.
4. Otherwise an open workspace with nothing recorded → **Editing**; with nothing at all → **Closed**.

Actions are enabled from the same facts. For example, Accept requires a `speculative` or `verified` change with no unrecorded edits on top of it.

### Overlaps vs engine verdicts

`computeOverlaps()` pairs unaccepted tasks whose writes or claims share a file. It uses Zit's `held_with` rule (mirrored in `shared/resource.ts`) to separate **same symbol / whole file** from **same file, different symbols**. This is a review signal. Zit's actual refusals (`stale`, `conflict`) are attached separately as `engineVerdict`, and the UI never merges the two. A test shows that a same-file overlap composes cleanly, while a same-symbol overlap becomes a Zit conflict after the other side lands.

## Concurrency and recovery

- **No double acceptance.** `startAccept` claims the change synchronously, before any `await`, so two simultaneous clicks start one job and the other gets `409 busy`. Accepts in a repository run one at a time behind a per-repository mutex. Inside the lock, the request's `expectedCurrent` (the `current` the person reviewed against) is re-checked: if another accept landed meanwhile, the job is refused as a stale review, and the person reviews again. Zit's own atomic ref transaction (`update refs/zit/current <new> <old>` together with deleting the speculative ref) is the final guard, and a repeated accept returns `already-accepted`.
- **Cancellation.** Jobs run Zit in its own process group. Cancelling sends SIGTERM to the group (and SIGKILL after 3 s), which also stops the check commands. A cancelled check stores no evidence. An accept moves `current` only in its final atomic step.
- **Journal.** Each mutation writes a `pending` entry before calling Zit. On start, leftover `pending` entries become `interrupted`, with recovery text for that kind of operation. The board also warns about a leftover `refs/zit/current.lock`.
- **Store writes** are serialised and atomic (temp file plus rename), so a crash leaves the old or new file, never half of one.

## Security model

- The server binds to `127.0.0.1` and refuses to start on a non-loopback host without an explicit override.
- Every request must carry a loopback `Host` header, which defeats DNS rebinding. Mutations must be JSON, carry `X-Switchyard: 1`, and have a same-origin `Origin` if one is present. A cross-site page cannot add that header without a CORS preflight, and the server grants none.
- Static UI responses use a strict CSP (`script-src 'self'`, no inline scripts, no `data:` fonts), `X-Frame-Options: DENY` and `nosniff`.
- Repository paths must be absolute, existing working trees. They cannot be inside `ZIT_HOME` or Switchyard's data directory, and must be under `SWITCHYARD_ALLOWED_ROOTS` if that is set. Resources for claims are validated: relative, no `..`, no leading `-`, single line.
- **Commands:** Switchyard never builds a shell command. Every `[[check]]`, `[prepare]` and `[[derive]]` command that an operation may run is read from `zit.toml` at the relevant revisions and shown verbatim. The server refuses with `428` until each exact command text is approved. Approval requests are only accepted for keys the named states currently declare. A change that adds or edits a command needs a new approval.
- Check output is reduced to its tail (4,000 characters / 160 lines), stripped of terminal escapes, and masked for common token shapes and the values of secret-looking environment variables, both before display and in history.
- No credentials are read, stored or needed.

## Hardest uncertainty

The weakest assumption is how much of a task's history can be recovered once Zit drops a change from its speculative list after acceptance. Switchyard handles this by remembering the change ids Zit reported for each task. It sees them both from its own `record` calls and from session-tagged changes in `zit status`. It then asks `zit show` for their status, which Zit derives from the graph, including linear composes, via the `Zit-Change` trailer. A change recorded from the CLI and accepted before Switchyard ever polled would not be attributed to its task. It would still appear on the mainline.

## Versions

- Zit 0.1.1 from crates.io (crate checksum `ff1402ff1df538b25b7b53ddd6b09207c14c332d66ddc84c1b7c156a56957126`; repository `github.com/autohandai/getzit`, which was not reachable from the build environment; the crate source was read instead).
- git 2.43.0, Node 22.22.0, Rust 1.97.0 (used to build Zit).
- npm dependencies are pinned exactly in `package.json` and locked in `package-lock.json`.
