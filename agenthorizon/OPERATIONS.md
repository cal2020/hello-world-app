# AgentHorizon workbench — operations

How to deploy, run, secure, back up and recover the workbench, and what its evidence can and cannot show.
Numbers marked *measured* come from files in `evidence/`; everything else is labelled an estimate or an
operator input.

## 1. Deployment modes

| Mode | Command | Use |
| --- | --- | --- |
| Local single-user | `agenthorizon bootstrap` then `agenthorizon dev` | One researcher on one machine. Project-local PostgreSQL on a Unix socket (`var/pg`, port 5433, no TCP). The API binds to loopback only. |
| Hosted (Compose) | `docker compose up -d --build` | Several users; per-service database roles; authentication required. `AH_MODE=hosted`. |

In local mode, `agenthorizon api` refuses non-loopback addresses. Remote access requires hosted mode, which always
authenticates every request. Put TLS in front of it: session cookies are `Secure`, `HttpOnly`, `SameSite=Strict`,
and cookie-authenticated mutations also need the `X-AH-Request: 1` header.

## 2. Services and trust boundaries (compose.yaml)

| Service | Image | Database role | Data volumes | Credentials | Network |
| --- | --- | --- | --- | --- | --- |
| `postgres` | postgres:16 (digest-pinned) | owner `agenthorizon` + 3 service roles | `pg-data` | DB passwords | internal only |
| `migrate` (one-shot) | app | owner | none | owner password | internal |
| `api` | app | `ah_api` | read-only: sources, datasets, media, runs, exports, supplemental, reports; read-write: cache | none | internal + published port (loopback by default) |
| `worker-trusted` | app | `ah_scorer` | read-write on all volumes, **including `private` (gold labels)**; read-only `imports` | none (optional `AH_HF_TOKEN`) | internal + egress |
| `worker-judge` | judge | `ah_worker` (**no access to the `private` schema**) | read-only: sources, datasets, media; read-write: runs. **No `private`, `exports`, `reports` or `supplemental` volume.** | provider keys (only here) | internal + egress |
| `admin` (profile `tools`) | app | owner + scorer | all volumes | owner password | internal + egress |
| `vllm` (profile `vllm`) | vllm/vllm-openai v0.30.0 (digest-pinned, overridable) | none | `hf-cache` | `VLLM_API_KEY`, `AH_HF_TOKEN` | internal + egress |

Hardening on every app service: read-only root filesystem with a tmpfs `/tmp`, `cap_drop: [ALL]`,
`no-new-privileges`, a non-root user (uid 10001) and `init`. No service mounts the Docker socket or runs privileged.
`tests/test_packaging.py` checks every property above against the resolved Compose model. `docker/smoke.py`
checks the running containers: the judge's label directory is empty while the trusted worker's is populated; the
judge's database role is denied on `private.gold_labels`; `CapEff` is zero; there is no Docker socket; a provider
key is present only in the judge worker.

## 3. First start (hosted)

```bash
cp .env.example .env                         # four DB passwords: openssl rand -hex 24 (hex keeps URLs valid)
docker compose up -d --build                 # postgres -> migrate -> api, worker-trusted, worker-judge
docker compose run --rm admin users add alice --role operator   # prints a token once; log in with it at the UI
for s in agenthorizon-repo agentrewardbench-repo osworld-repo; do   # pinned checkouts (prompts, scorer, adapters)
  docker compose run --rm admin sources checkout $s
done
```

Without network access to GitHub, copy an existing checkout of the same commit into the volume instead
(`docker compose run --rm -v /path/ServiceNow__agenthorizon@<commit>:/src:ro --entrypoint sh admin -c 'cp -a /src
/data/sources/ServiceNow__agenthorizon@<commit>'`). The API and the judge worker mount sources read-only and
never fetch. Until the pinned checkout exists, planning a run answers `409 source_unavailable` and names the
command to run.

Then, from the UI (Operations → Data) or the API, queue an ingestion of the official dataset:
`POST /api/admin/datasets/ingest {"source": "hf", "revision": "<pinned dataset revision>"}`. The revision is an
operator input: `agenthorizon sources lock` resolves it on a network that can reach huggingface.co. This
environment could not, so `evidence/SOURCE_LOCK.json` records the dataset as inaccessible.

To ingest an offline mirror of the released layout, copy it into the `imports` volume, then ingest with
`source: local`:

```bash
docker compose run --rm -v /path/to/mirror:/mirror:ro --entrypoint sh admin \
  -c 'mkdir -p /data/imports/ah-mirror && cp -a /mirror/. /data/imports/ah-mirror/'
# then: POST /api/admin/datasets/ingest {"source": "local", "local_dir": "/data/imports/ah-mirror", "media": "none"}
```

Supplemental sources (AgentRewardBench annotations, OSWorld task definitions) are imported with
`docker compose run --rm admin supplemental import agentrewardbench` (or `osworld`), then
`supplemental audit`. Reports land in the `reports` volume, and the API shows them in place of the copies
committed in `evidence/`.

Capability report: Operations → Data → "Refresh capability report" queues a probe on a judge worker. It reports the
harness installs, the per-task sandbox and credential *names* of the process that will execute runs. The API's own
environment holds none of these, so a run plan takes its harness identity (version, path, digest) from the judge
workers' reports.

Harness versions: each adapter names the release its invocation flags were verified against (Claude Code 2.1.295,
Codex 0.162.1, Gemini CLI 0.63.0, OpenCode 1.18.35, OpenHands 1.16.0; `evidence/harness_cli/`), and the judge image
installs exactly those. A harness reporting any other version (for example one found on `PATH` on a development host)
still runs, but the capability report flags it, every attempt's lineage records it, and the run is extension-class,
never paper-compatible.

## 4. Judge isolation inside containers

Each agentic attempt and each Codex direct attempt runs in a fresh namespace sandbox (`judging/isolation/`):

- new user, mount, network, PID, IPC and UTS namespaces;
- a tmpfs root that holds only read-only `/usr` and system directories, the read-only harness tools, the task's
  own staged inputs (read-only), and a private home, `/tmp` and output directory;
- `pivot_root`, then every capability is dropped and `no_new_privs` is set.

The network namespace has only loopback. The only way out is a per-task egress proxy, reachable through a Unix
socket, that allows `CONNECT :443` to the route's hosts. An operator-configured self-hosted endpoint (`base_url`,
e.g. `http://vllm:8000/v1`) is reachable only at its exact host and port. Labels, other tasks, the database and
the API are never mounted or reachable.

Running that sandbox inside the judge container needs two container settings:

| Container setting | Result of the in-container probe (`isolation_available()`) |
| --- | --- |
| Docker's default seccomp profile | fails: `unshare: unshare failed: Operation not permitted` |
| `seccomp=docker/seccomp-judge.json` only | fails: `mount proc ... Operation not permitted` (Docker masks `/proc` paths, so the kernel refuses a fresh procfs) |
| `seccomp=docker/seccomp-judge.json` + `systempaths=unconfined` | works: user+mount+net+pid namespaces, pivot_root, capability drop |

`docker/seccomp-judge.json` is Docker's default profile plus one rule that allows `unshare`, `mount`, `umount2`,
`pivot_root` and `sethostname`. `docker/make_seccomp.py` regenerates it, and a test pins the base digest. The
container itself keeps zero capabilities. Without capabilities in its own namespaces these syscalls only succeed
inside the user namespace the sandbox creates.

`systempaths=unconfined` removes Docker's masking of `/proc` paths for the judge container. Its processes run as
uid 10001 with no capabilities, so they cannot read root-only procfs files or write `/proc/sys`. Judge harnesses
never see the container's `/proc`: they get a fresh procfs for their own PID namespace.

On hosts that confine containers with AppArmor (Ubuntu's default `docker-default` profile denies `mount`; recent
Ubuntu kernels also restrict unprivileged user namespaces), add `apparmor=unconfined` to the judge worker's
`security_opt`, or load a profile that allows `userns` and `mount`. The worker publishes its isolation status. If
the probe fails, agentic runs are **planned and blocked**: they are never run without the boundary.

## 5. Credentials

| Route | Variable (judge worker only) | Used by |
| --- | --- | --- |
| anthropic | `ANTHROPIC_API_KEY` | Claude Code configurations |
| google | `GEMINI_API_KEY` (alias `GOOGLE_GENERATIVE_AI_API_KEY`) | Gemini CLI, Gemini direct, harnesses on Gemini routes |
| openai | `OPENAI_API_KEY` | OpenAI routes |
| openrouter | `OPENROUTER_API_KEY` | OpenRouter routes |
| chatgpt_subscription | `CODEX_AUTH_JSON` (contents of `~/.codex/auth.json`, or a path to it) | Codex configurations |
| vllm | `VLLM_API_KEY` (optional; the vLLM profile requires one) | self-hosted endpoints |

Each harness receives only its route's variables, inside the sandbox environment or its private home. Credentials
are never sent to the browser, never written to exports (bundles are redacted and checked against the secret
values present), never logged, and never given to the API or the trusted worker. Rotate a key by editing `.env`
and running `docker compose up -d worker-judge`.

## 6. Cost policy

- A live run needs the route's credentials **and** an explicit budget (`--budget-usd` or `budget_usd`). Without
  them the run is planned and reported as blocked; nothing is sent. API keys alone never start the experiment matrix.
- Start with `--dry-run` (forecast with its stated assumptions), then a pilot (`--max-tasks N` or `--smoke N`).
- The budget is reserved before each attempt and reconciled to billed amounts. The run pauses when the next
  reservation would exceed it; resume it with a higher budget.
- Billed and estimated amounts are stored separately, with currency, price source and retrieval date. Unknown
  usage stays unknown, never zero.
- Prices: Anthropic Opus 4.7 at $5/$25 per million input/output tokens and Haiku 4.5 at $1/$5, from the official
  price page retrieved 2026-10-09. The Gemini prices are the authors' rough table and are flagged as such. Operators
  can override any price, with a source (`--price-input/--price-output/--price-source`).
- `vllm` and `chatgpt_subscription` have no marginal API charge, but GPU time and subscription cost are real, and
  this system does not estimate them.

## 7. Disk, network and GPU

| Item | Size | Basis |
| --- | --- | --- |
| Pinned source checkouts (authors' repo, AgentRewardBench, OSWorld) | ~38 MB | measured (`var/sources`) |
| AgentHorizon screenshots | ~43 GB | advertised by the release (S3/MP §3); **not verified here** (host unreachable) |
| Thumbnail cache (480 px JPEG, on demand) | a small fraction of the screenshots | grows with use; safe to delete |
| PostgreSQL catalogue at release scale (1,373 examples, ~129k steps) | see `database_size_bytes` | measured on a synthetic catalogue (`evidence/PERFORMANCE.json`) |
| Images | app 526 MB, judge 3.99 GB | measured (`docker images`) |
| Run artifacts | raw responses, transcripts, sandbox logs per attempt | grows with runs; see `evidence/STACK_SMOKE.json` |

Network egress: the trusted worker reaches huggingface.co (datasets) and github.com (pinned sources). The judge
worker reaches only the configured routes: api.anthropic.com, generativelanguage.googleapis.com, api.openai.com,
chatgpt.com/auth.openai.com, openrouter.ai, or a self-hosted endpoint. Inside the sandbox each attempt sees only its
own route. `AH_EGRESS_PROXY` chains the workers through an outbound proxy.

GPU (optional, `--profile vllm`): self-hosted models need an NVIDIA host with the container toolkit. Weights alone
are about 2 bytes per parameter in bf16, *before* KV cache. That is roughly 54 GB for Qwen 3.6 27B, 70 GB for 35B-A3B,
62 GB for Gemma 4 31B, 52 GB for 26B-A4B, 18 GB for Qwen 3.5 9B, and ~245 GB for the 122B-A10B splitter, which needs
several GPUs. These are estimates. The authors' serving flags are not released, so `VLLM_MODEL` and
`VLLM_EXTRA_ARGS` are operator inputs, and runs record the endpoint and model as served.

## 8. Licensing

From `evidence/SOURCE_LOCK.json → material_licenses`:

- AgentHorizon code and prompts: **no licence file** at the pinned commit; treated as all rights reserved. They
  are not vendored: they are read from the pinned checkout at runtime and recorded by digest. Run definitions
  store prompt IDs and digests, not the text.
- AgentHorizon labels, trajectories and screenshots: **unverified** (dataset card unreadable here).
- AgentRewardBench code and annotations: no licence file; its trajectories and screenshots are unverified.
- OSWorld code and task definitions: Apache-2.0.

Export bundles never include raw media. Check the dataset card's terms before redistributing any imported
material.

## 9. Backup and restore

The database and the volumes form one state; back them up together while the workers are stopped.

```bash
docker compose stop worker-judge worker-trusted
docker compose exec -T postgres pg_dump -U agenthorizon -Fc agenthorizon > backup/agenthorizon.pgdump
for v in sources datasets media runs exports supplemental reports private imports; do
  docker run --rm -v agenthorizon_$v:/v:ro -v "$PWD/backup":/b ubuntu:24.04 tar -C /v -czf /b/$v.tgz .
done
docker compose start worker-judge worker-trusted
```

Restore into a fresh stack: create the volumes (`docker compose up -d postgres`), restore with `pg_restore -U
agenthorizon -d agenthorizon --clean`, extract each archive into its volume, then start the rest. The `private`
archive holds gold labels: store it as access-controlled. Official evaluation data is never edited in place.
Review corrections live in the separate annotation layer, so a restore never mixes the two.

## 10. Job and run recovery

- **Jobs** are durable rows with leases and heartbeats. When a worker dies, its lease expires, another worker
  reclaims the job, and `attempts` counts the takeover (`max_attempts` bounds it).
- **Runs** have a content-derived identity. A restarted run resumes only an identical definition. Attempts left
  running by a crash are recorded as `interrupted` (an infrastructure class that does not count toward the attempt
  limit). Finalized tasks are never redone or duplicated; killing a worker mid-run is a tested case.
- **Pause** stops dispatch and lets running attempts finish. **Cancel** also stops running attempts and keeps their
  evidence. **Resume** continues from the stored state. A `blocked` outcome (missing credential, unreachable route)
  pauses the whole run instead of producing a column of missing results.
- `agenthorizon runs retry-errors <run>` (or the UI) reopens, once and with an audit event, only the tasks that
  ended with no response. A valid judgment is never re-run until it "succeeds".
- Health: `GET /api/health` (liveness) and `GET /api/ready` (database, migration head, data directories). Worker
  presence and isolation status are under Operations → Workers. Every privileged action is in the audit log.

Upgrades: rebuild the images, then `docker compose up -d`. `migrate` runs first and the API reports the migration
head in `/api/ready`.

## 11. What screenshot/action evidence can and cannot show

- In the released standard, a screenshot is a **pre-action** observation. The effect of step *n* is visible only in
  a later screenshot, if one exists. The last action's effect may never be shown.
- Actions are low-level events (coordinates, keys, text) without semantic targets. A judge infers what was clicked
  from pixels. Off-screen effects (a file written, an email actually delivered, a background sync) are invisible
  unless the recording shows them.
- No video or system-state logs are released, so timing beyond `timestamp_us` and any non-visual outcome cannot be
  verified.
- Shared recordings: matched and crossed instruction pairs deliberately reuse one recording. Per-item results are
  therefore not independent, and the bootstrap extension resamples recording groups.
- Supplemental sources differ: OSWorld traces use **post-action** screenshots, and evaluator scores are machine
  labels. These are flagged, kept in separate datasets and never pooled with AgentHorizon denominators.

## 12. Known limitations of this build environment

The environment that produced this repository could not reach arxiv.org, huggingface.co, the Dataverse,
openai.com, chatgpt.com or openrouter.ai (see `evidence/SOURCE_LOCK.json` and `evidence/MODEL_CAPABILITIES.json`). It
had no provider credentials and no budget. Consequently:

- no official AgentHorizon trajectory was ingested;
- no live judge was run;
- every score in `evidence/` is computed on synthetic test data and labelled as such;
- the revised AH-D/AH/AH-S membership was not located.

Run the same commands on a network that reaches those hosts to lift each block. The open items are listed in
`evidence/PAPER_SPEC.json → unresolved` and `evidence/REPRODUCTION_REPORT.md`.
