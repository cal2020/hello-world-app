# Third-party notices (browser build)

This folder is the in-browser build of AI Cost Inspector. Besides the web app's own
dependencies (see THIRD_PARTY_NOTICES.md in the source repository), it redistributes the
components below. License texts are in [licenses/](licenses/); Python wheels also carry
their own license metadata.

| Component | Version | License | Where |
| --- | --- | --- | --- |
| Pyodide | 314.0.7 | MPL-2.0 (source: https://github.com/pyodide/pyodide) | pyodide/ |
| CPython (inside Pyodide), with incorporated software | 3.14.2 | PSF-2.0 and the notices in CPython-3.14.2-incorporated-software.rst | pyodide/ |
| Emscripten runtime, musl, LLVM libc++/libc++abi/compiler-rt, HACL*, SQLite, bzip2, Zstandard (inside Pyodide) | emsdk 5.0.3 | MIT / NCSA; MIT; Apache-2.0 with LLVM exception; MIT; public domain; bzip2; BSD-3-Clause | pyodide/ |
| KORA Doctor | 0.1.0 | Apache-2.0 | app.zip (kora_doctor/) |
| AUDR v1.0.0 JSON Schema | 1.0.0 | Apache-2.0, with NOTICE | app.zip (cost_inspector/ingest/audr/) |
| Python package `annotated-doc` | 0.0.4 | see the wheel's metadata | pyodide/annotated_doc-0.0.4-py3-none-any.whl |
| Python package `annotated-types` | 0.7.0 | see the wheel's metadata | pyodide/annotated_types-0.7.0-py3-none-any.whl |
| Python package `anyio` | 4.13.0 | see the wheel's metadata | pyodide/anyio-4.13.0-py3-none-any.whl |
| Python package `attrs` | 26.1.0 | see the wheel's metadata | pyodide/attrs-26.1.0-py3-none-any.whl |
| Python package `fastapi` | 0.136.1 | see the wheel's metadata | pyodide/fastapi-0.136.1-py3-none-any.whl |
| Python package `httpx` | 0.28.1 | see the wheel's metadata | pyodide/httpx-0.28.1-py3-none-any.whl |
| Python package `jinja2` | 3.1.6 | see the wheel's metadata | pyodide/jinja2-3.1.6-py3-none-any.whl |
| Python package `jsonschema` | 4.26.0 | see the wheel's metadata | pyodide/jsonschema-4.26.0-py3-none-any.whl |
| Python package `jsonschema-specifications` | 2025.9.1 | see the wheel's metadata | pyodide/jsonschema_specifications-2025.9.1-py3-none-any.whl |
| Python package `markupsafe` | 3.0.3 | see the wheel's metadata | pyodide/markupsafe-3.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `pydantic` | 2.12.5 | see the wheel's metadata | pyodide/pydantic-2.12.5-py3-none-any.whl |
| Python package `pydantic-core` | 2.41.5 | see the wheel's metadata | pyodide/pydantic_core-2.41.5-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `pyrsistent` | 0.20.0 | see the wheel's metadata | pyodide/pyrsistent-0.20.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `referencing` | 0.37.0 | see the wheel's metadata | pyodide/referencing-0.37.0-py3-none-any.whl |
| Python package `rpds-py` | 0.30.0 | see the wheel's metadata | pyodide/rpds_py-0.30.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `six` | 1.17.0 | see the wheel's metadata | pyodide/six-1.17.0-py2.py3-none-any.whl |
| Python package `sniffio` | 1.3.1 | see the wheel's metadata | pyodide/sniffio-1.3.1-py3-none-any.whl |
| Python package `starlette` | 1.0.0 | see the wheel's metadata | pyodide/starlette-1.0.0-py3-none-any.whl |
| Python package `typing-extensions` | 4.15.0 | see the wheel's metadata | pyodide/typing_extensions-4.15.0-py3-none-any.whl |
| Python package `typing-inspection` | 0.4.2 | see the wheel's metadata | pyodide/typing_inspection-0.4.2-py3-none-any.whl |
