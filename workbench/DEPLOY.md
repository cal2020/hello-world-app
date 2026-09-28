# Deploying the workbench demo

The deployable unit is **one container** running one Python process. The workbench serves the UI, `/api` and `/manage` on `$PORT` (8080 in the image). The mock consumer is a second HTTP server in the same process, bound to 127.0.0.1 only, and its dashboard is proxied at `/consumer/`. State lives in SQLite under `/data`. The image declares no `VOLUME`, so mount a volume at `/data` (a platform volume, or `docker run -v`) to keep state across redeploys.

## Before exposing it anywhere

* **Set `LWB_ACCESS_CODE`** as a platform secret, never in a file. Without it, anyone with the URL can use the demo tokens in this repo (`demo-carol`, `demo-admin`, …) to import data, activate releases and change grants.
  * With the code set, every page and API call needs the login cookie (from `/login`, valid for 12 hours) or an `X-Access-Code` header. Only `/healthz` and the login page are open.
  * Wrong codes wait for their turn, one answer per second across all connections, and at most 8 wait at once. A wrong code beyond that gets 429 at once, so wrong codes cannot tie up the server. A correct code, or a request with no code, is never delayed. The throttle slows a guesser who waits for answers, but the 429 also says the code was wrong, so a client sending in parallel can test codes as fast as the server responds. The code's length is what protects it.
  * The server keeps at most 256 connections open. When it is full, it closes the connection that has waited longest on its client (idle, or sending its request slowly) to make room, so idle or slow clients cannot lock others out. It refuses a new connection only when all 256 are busy serving requests that passed the gate (or wrong codes waiting their turn).
  * The gate is a shared code in front of a demo. It is not user authentication. The server (`scripts/run.py`, the container's entrypoint) refuses to start with a code shorter than 16 characters. It cannot check that the code is random, so generate one.
* **Run exactly one instance.** SQLite and the in-process outbox worker assume a single process. Do not enable horizontal scaling.
* **Serve it over HTTPS.** The login cookie is `Secure` by default. The platforms below terminate TLS for you. For plain-HTTP local testing only, set `LWB_COOKIE_SECURE=0`.
* **Synthetic data only.** Do not load real system-model or customer data. Nothing here has been assessed for FedRAMP, NIST or ATO purposes.

## Environment variables

| Variable | Default in image | Purpose |
|---|---|---|
| `LWB_ACCESS_CODE` | unset | Access gate (required for any shared URL). At least 16 characters |
| `PORT` | `8080` | Workbench listen port. Platforms such as Railway set it |
| `LWB_HOST` | `0.0.0.0` | Workbench bind address. The consumer always binds to 127.0.0.1 |
| `LWB_CONSUMER_PORT` | unset (8781) | Internal consumer port; `0` means any free port. If it equals the workbench port, the consumer moves to a free port |
| `LWB_VAR` | `/data` | SQLite directory (mount a volume here to keep state) |
| `LWB_SEED_ON_START` | `1` | Seed projections and CMMS records when the DB is empty |
| `LWB_RESET_ON_START` | unset | `1` wipes `/data` on every start, so each restart gives a clean demo |
| `LWB_COOKIE_SECURE` | unset (on) | Set `0` only for plain-HTTP local testing |
| `LWB_CODE_VERSION` | empty (build argument) | Code version written into release manifests. The image has no `.git`, so pass it at build time: `docker build --build-arg LWB_CODE_VERSION=$(git rev-parse --short=12 HEAD) …`. Empty counts as unset |
| `RAILWAY_GIT_COMMIT_SHA` | set by Railway | Used (first 12 characters) as the code version when `LWB_CODE_VERSION` is empty. With neither, manifests say `unknown` |
| `LWB_QUIET` | `1` | Suppresses per-request logs. Set `0` to see them |
| `ANTHROPIC_API_KEY`, `LWB_MODEL` | unset | Optional live proposals. The image does not include the `anthropic` package; add `requirements-live.txt` to the build if you want it |

A database written by an earlier version of the code (for example on an existing volume) is upgraded in place at start. There is no downgrade, so if you roll the code back, reset the data too.

## Verified in the build sandbox

None of this was run on Railway or any other platform. On a normal network, the committed Dockerfile installs its pinned dependencies from PyPI.

**2026-09-27, the image at this commit.** The sandbox's HTTPS proxy re-signs TLS, so the verification build added the proxy's CA certificate for the `pip install` step only. Everything else was the committed Dockerfile.

* **Build** with `--build-arg LWB_CODE_VERSION=$(git rev-parse --short=12 HEAD)`. The image declares no volume.
* **Container run** with `LWB_ACCESS_CODE` set, a root-owned host directory mounted at `/data`, and `-p 127.0.0.1::8080`:
  * `/healthz` returned 200, and `/` redirected to `/login`.
  * The API returned 401 without the code. A wrong code got 401 after about one second. The right code in `X-Access-Code` got 200, and `/consumer/` answered through the gate.
  * Posting the right code to `/login` set an `HttpOnly; SameSite=Strict; Secure` cookie with a 12-hour lifetime.
  * The entrypoint changed ownership of `/data`, and the server ran as uid 10001 (`app`), which owned the data files. Only the workbench port was published.
* **The full `scripts/demo.py` flow** passed through the gate, including the lost-ack retry. The release manifest's `code_version` was the build argument.
* **State** survived `docker restart`, and the restart did not seed again. With `LWB_RESET_ON_START=1`, a restart gave a clean, re-seeded start.
* **`PORT=8781`:** the consumer moved to a free internal port, and `/consumer/` still worked.

**2026-09-25, preparing for Railway.**

* **Root-owned volume.** The image started with a root-owned directory mounted at `/data`, as Railway mounts volumes. `scripts/entrypoint.sh` changed ownership of the directory, then dropped to the unprivileged `app` user (uid 10001). The data files were written by that user.
* **Platform port.** With `PORT=5555` set by the "platform", `/healthz` returned 200 on that port.
* **Full demo.** The complete `scripts/demo.py` flow passed through the access gate.

**2026-09-24, the first image** (then built with `USER app`, `VOLUME ["/data"]` and no entrypoint script):

* **Image build.** `docker build` produced a 208 MB image with base `python:3.11-slim`, pulled through `mirror.gcr.io` because Docker Hub rate-limited the sandbox. The sandbox's HTTPS proxy blocked `pip` inside builds, so that build installed the same pinned wheels offline.
* **Container run** with `LWB_ACCESS_CODE` set and a named volume:
  * `/healthz` returned 200, and `/` redirected to `/login`.
  * The API returned 401 without the code, and a wrong code got 401.
  * The right code set an HttpOnly cookie and the UI loaded (checked in headless Chromium).
  * `/consumer/` was proxied, port 8781 was not exposed, and the container ran as non-root user `app`.
* **The full `scripts/demo.py` flow** ran against the container through the gate, including the lost-ack retry.
* **State** survived `docker restart`. `LWB_RESET_ON_START=1` gave a clean, re-seeded start.

**Tests.** `tests/test_deploy.py` covers the gate. `tests/test_fix_consumer_deploy.py` checks the Dockerfile (no `VOLUME`, the code-version build argument) and the consumer port. `tests/test_fix_server_links_outbox.py` covers HTTP framing, the guess throttle and connection limits, and `tests/test_fix_repairs.py` checks that neither idle connections nor a flood of wrong codes locks out `/healthz` or users with the right code, and that `scripts/run.py` refuses a code shorter than 16 characters.

**Not verified here:** any live deployment. The sandbox cannot reach Railway, Fly.io or Render, so the platform steps below have not been run from it, and `railway.json` could not be checked against Railway's schema. After deploying, check the result against step 8 below.

## Already live: browser build on GitHub Pages

`browser/build_web.py` produces a static site that runs the workbench in the visitor's browser (see README). It is published on the repository's `gh-pages` branch at `/integration-workbench/app/`, next to the recorded walkthrough (`/integration-workbench/`) and the guide (`/integration-workbench/guide/`). No server, secrets or access code are involved: each visitor gets a private copy in their own tab, seeded with the synthetic baseline, and a reload resets it. Unlisted but public: anyone with the URL can open it. The Railway container below remains the option for one shared, persistent instance.

## Option A: Railway

The repo contains `workbench/railway.json`, which sets a Dockerfile build, the `/healthz` health check and restart-on-failure. Everything else is set in the Railway dashboard. Dashboard labels may differ slightly from the names below.

1. **Create the service.** New Project → *Deploy from GitHub repo* → `cal2020/hello-world-app`. In the service's *Source* settings, choose the branch `claude/kbr-interview-prep-s59ic7`, or `master` if you merge it there.
2. **Root directory.** Service *Settings* → *Root Directory* = `workbench`.
3. **Config file.** Set *Config-as-code / Railway config file* = `/workbench/railway.json`. Railway may not look for the config file inside the root directory by itself, so set the path explicitly. If it isn't picked up, set the health check path to `/healthz` in the dashboard instead.
4. **Variables.** Add `LWB_ACCESS_CODE` with a long random value (at least 16 characters, or the service will not start), for example from `python3 -c "import secrets; print(secrets.token_urlsafe(18))"`. Do **not** set `PORT`; Railway provides it and the app listens on it. Release manifests take their code version from `RAILWAY_GIT_COMMIT_SHA`, which Railway provides for GitHub deploys. This could not be checked from the sandbox; if a manifest says `unknown`, set `LWB_CODE_VERSION` as a variable.
5. **Volume.** Attach a volume to the service with mount path **`/data`**. The image has no `VOLUME` instruction, because Railway's builder rejects it. Without a volume the app still runs, but its data is lost on every redeploy.
6. **Replicas.** Keep the replica count at **1**. SQLite and the in-process event worker require a single instance.
7. **Public URL.** *Networking* → *Generate Domain*. Railway serves it over HTTPS.
8. **Deploy.** The deploy logs should show `seeded baseline (projections + CMMS records)` on the first start, then `Access gate: ON` and `Consumer (internal): http://127.0.0.1:8781/` (another free port if Railway's `PORT` is 8781). The domain should open the login page; enter the code to get the workbench. The consumer dashboard is at `/consumer/`.

To reset between demo sessions, add `LWB_RESET_ON_START=1`, restart the service, then remove the variable. Railway bills by usage and for volume storage, so check its current pricing.

## Option B: Fly.io (`fly.toml` included)

```sh
cd workbench
fly launch --no-deploy --copy-config        # pick a unique app name; keeps fly.toml
fly volumes create lwb_data --size 1        # same region as primary_region
fly secrets set LWB_ACCESS_CODE='<choose a long random code>'
fly deploy
fly scale count 1                           # single instance (SQLite)
```

## Option C: Render (`render.yaml` at the repository root)

Create a Blueprint from the repo, or a Docker web service with root directory `workbench`. Then:

1. Attach a 1 GB disk at `/data`.
2. Set `LWB_ACCESS_CODE` in the dashboard.
3. Keep the instance count at 1.

## Option D: any Docker host (VM, Lightsail instance, internal server)

```sh
docker build --build-arg LWB_CODE_VERSION=$(git rev-parse --short=12 HEAD) -t lucid-workbench ./workbench
docker run -d --restart unless-stopped --name lwb -p 127.0.0.1:8080:8080 \
  -e LWB_ACCESS_CODE='<long random code>' -v lwbdata:/data lucid-workbench
```

`-p 127.0.0.1:8080:8080` publishes the plain-HTTP port on the host's loopback interface only. Do not use `-p 8080:8080`: that listens on every interface, and Docker's port rules bypass host firewalls such as ufw. The only ways in are then either of these:

* a TLS-terminating reverse proxy on the same host, such as Caddy or nginx with a certificate, forwarding to `127.0.0.1:8080`
* an SSH tunnel, for private use: `ssh -L 8080:localhost:8080 host`

## Resetting between demo sessions

To reset between sessions, do either of these:

* restart with `LWB_RESET_ON_START=1`
* delete the volume and restart

The UI has no reset button, on purpose: wiping data is an operator action.
