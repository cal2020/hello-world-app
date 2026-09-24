# Deploying the workbench demo

The deployable unit is **one container**. The workbench serves the UI, `/api` and `/manage` on `$PORT` (8080 in the image). The mock consumer runs in the same container on 127.0.0.1 only, and its dashboard is proxied at `/consumer/`. State lives in SQLite under `/data`.

## Before exposing it anywhere

* **Set `LWB_ACCESS_CODE`** as a platform secret, never in a file. Without it, anyone with the URL can use the demo tokens in this repo (`demo-carol`, `demo-admin`, …) to import data, activate releases and change grants.
  * With the code set, every page and API call needs the login cookie (from `/login`) or an `X-Access-Code` header. Only `/healthz` is open.
  * The gate is a shared code in front of a demo. It is not user authentication.
* **Run exactly one instance.** SQLite and the in-process outbox worker assume a single process. Do not enable horizontal scaling.
* **Serve it over HTTPS.** The login cookie is `Secure` by default. The platforms below terminate TLS for you. For plain-HTTP local testing only, set `LWB_COOKIE_SECURE=0`.
* **Synthetic data only.** Do not load real system-model or customer data. Nothing here has been assessed for FedRAMP, NIST or ATO purposes.

## Environment variables

| Variable | Default in image | Purpose |
|---|---|---|
| `LWB_ACCESS_CODE` | unset | Access gate (required for any shared URL) |
| `PORT` | `8080` | Listen port |
| `LWB_VAR` | `/data` | SQLite directory (mount a volume here to keep state) |
| `LWB_SEED_ON_START` | `1` | Seed projections and CMMS records when the DB is empty |
| `LWB_RESET_ON_START` | unset | `1` wipes `/data` on every start, so each restart gives a clean demo |
| `LWB_COOKIE_SECURE` | `1` | Set `0` only for plain-HTTP local testing |
| `ANTHROPIC_API_KEY`, `LWB_MODEL` | unset | Optional live proposals. The image does not include the `anthropic` package; add `requirements-live.txt` to the build if you want it |

## Verified locally

These were run in the build sandbox on 2026-09-24:

* **Image build.** `docker build` produced a 208 MB image with base `python:3.11-slim`, pulled through `mirror.gcr.io` because Docker Hub rate-limited the sandbox. The sandbox's HTTPS proxy blocks `pip` inside builds, so the verification build installed the same pinned wheels offline. On a normal network, the Dockerfile as committed installs from PyPI.
* **Container run** with `LWB_ACCESS_CODE` set and a named volume:
  * `/healthz` returns 200.
  * `/` redirects to `/login`.
  * The API returns 401 without the code, and a wrong code gets 401.
  * The right code sets an HttpOnly cookie and the UI loads (checked in headless Chromium).
  * `/consumer/` is proxied, port 8781 is not exposed, and the container runs as non-root user `app`.
* **The full `scripts/demo.py` flow** ran against the container through the gate, including the lost-ack retry.
* **State** survived `docker restart`. `LWB_RESET_ON_START=1` gave a clean, re-seeded start.
* **Tests:** `tests/test_deploy.py` covers the gate. The full suite has 39 tests.

**Not done:** no cloud deployment has been made from this repository. The platform steps below have not been run.

## Option A: Fly.io (`fly.toml` included)

```sh
cd workbench
fly launch --no-deploy --copy-config        # pick a unique app name; keeps fly.toml
fly volumes create lwb_data --size 1        # same region as primary_region
fly secrets set LWB_ACCESS_CODE='<choose a long random code>'
fly deploy
fly scale count 1                           # single instance (SQLite)
```

## Option B: Render (`render.yaml` at the repository root)

Create a Blueprint from the repo, or a Docker web service with root directory `workbench`. Then:

1. Attach a 1 GB disk at `/data`.
2. Set `LWB_ACCESS_CODE` in the dashboard.
3. Keep the instance count at 1.

## Option C: any Docker host (VM, Lightsail instance, internal server)

```sh
docker build -t lucid-workbench ./workbench
docker run -d --restart unless-stopped --name lwb -p 8080:8080 \
  -e LWB_ACCESS_CODE='<long random code>' -v lwbdata:/data lucid-workbench
```

Put a TLS-terminating reverse proxy in front, such as Caddy or nginx with a certificate. You can also keep it private and reach it over SSH: `ssh -L 8080:localhost:8080 host`.

## Resetting between demo sessions

To reset between sessions, do either of these:

* restart with `LWB_RESET_ON_START=1`
* delete the volume and restart

The UI has no reset button, on purpose: wiping data is an operator action.
