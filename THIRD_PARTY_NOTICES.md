# Third-party notices

AI Cost Inspector uses the software and data listed below. Each remains under its
own license. Versions are the ones pinned in `backend/uv.lock` and
`frontend/package-lock.json`.

## KORA Doctor

- Source: <https://github.com/Krako-Labs/kora-doctor>, v0.1.0, commit
  `7c54af8f1ddf891bfd05125fd1c345186c9cd62a`
- Author: Krako Labs
- License: Apache License 2.0

Used unmodified. uv installs it from the pinned commit as a dependency of the
backend (`backend/pyproject.toml`). The sample traces in
`backend/tests/fixtures/kora-doctor/` are copied from its `samples/` and
`tests/fixtures/` directories without modification; the license text is in that
directory. KORA Doctor ships no NOTICE file.

## AUDR (Agent Usage Detail Record)

- Source: <https://github.com/openaudr/audr>, commit
  `95213e30568d4ffcdb4b6861358676778d9d8fd1`
- License: Apache License 2.0

`backend/src/cost_inspector/ingest/audr/audr.schema.json` is the official AUDR
v1.0.0 JSON Schema, copied without modification. The conformance cases and the
multi-emitter example in `backend/tests/fixtures/audr/` are copied from the same
commit. Both directories contain the license and the NOTICE, which reads:

```
Agent Usage Detail Record (AUDR)
Copyright 2026 Chargebee, Inc. and the AUDR contributors

This product includes software developed at Chargebee, Inc.
(https://www.chargebee.com/).
```

## Shipped in the web app (`frontend/dist`)

| Package | Version | License | Copyright |
| --- | --- | --- | --- |
| react, react-dom, scheduler | 19.3.0, 19.3.0, 0.28.0 | MIT | Meta Platforms, Inc. and affiliates |
| radix-ui and the `@radix-ui/*` primitives it uses | 1.7.0 | MIT | WorkOS |
| @floating-ui/core, dom, react-dom, utils | 1.8.0, 1.8.0, 2.1.9, 0.2.12 | MIT | Floating UI contributors |
| @tanstack/react-query, @tanstack/query-core | 5.104.1 | MIT | Tanner Linsley |
| cmdk | 1.1.1 | MIT | Paco Coursey |
| sonner | 2.0.8 | MIT | Emil Kowalski |
| lucide-react | 1.52.0 | ISC | Lucide Icons and Contributors |
| clsx | 2.1.1 | MIT | Luke Edwards |
| tailwind-merge | 3.7.0 | MIT | Dany Castillo |
| Tailwind CSS (generated styles) | 4.3.3 | MIT | Tailwind Labs, Inc. |
| aria-hidden, get-nonce, react-remove-scroll, react-remove-scroll-bar, react-style-singleton, use-callback-ref, use-sidecar | 1.2.6, 1.0.1, 2.7.2, 2.3.8, 2.2.3, 1.3.3, 1.1.3 | MIT | Anton Korzunov |
| tslib | 2.8.1 | 0BSD | Microsoft Corporation |
| Geist and Geist Mono fonts (via @fontsource-variable/geist, geist-mono) | 5.3.0 | SIL Open Font License 1.1 | The Geist Project Authors |

The complete license texts are in each package under `frontend/node_modules/` after
`npm ci`.

## Backend runtime dependencies

| Package | License |
| --- | --- |
| fastapi, pydantic, pydantic-core, annotated-types, annotated-doc, typing-inspection, anyio, h11 | MIT |
| starlette, uvicorn, click, idna, jinja2, markupsafe | BSD-3-Clause |
| jsonschema, jsonschema-specifications, referencing, rpds-py, attrs | MIT |
| typing-extensions | PSF-2.0 |
| opentelemetry-api (a dependency of FastAPI; no exporter is installed and nothing is sent) | Apache-2.0 |

## Development and test tools (not shipped)

pytest, ruff, mypy, httpx2, TypeScript, Vite, Vitest, ESLint, typescript-eslint,
Testing Library, jsdom and Playwright are used to build and test the project.
axe-core (MPL-2.0) runs only inside the end-to-end accessibility test.
