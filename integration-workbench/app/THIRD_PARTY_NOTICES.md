# Third-party components in this static build

License texts are in [licenses/](licenses/). Wheels also carry their own license metadata.

| Component | Version | License | Where |
|---|---|---|---|
| Pyodide | 314.0.7 | MPL-2.0 | pyodide/ |
| CPython (inside Pyodide) with incorporated software | 3.14.2 | PSF-2.0 and notices in CPython-*-incorporated-software.rst | pyodide/ |
| Emscripten runtime, musl, LLVM libc++/libc++abi/compiler-rt, HACL*, SQLite, bzip2, Zstandard (inside Pyodide) | emsdk 5.0.3 | MIT / NCSA; MIT; Apache-2.0 with LLVM exception; MIT; public domain; bzip2; BSD-3-Clause | pyodide/ |
| Python package `attrs` | 26.1.0 | see the wheel's metadata | pyodide/attrs-26.1.0-py3-none-any.whl |
| Python package `certifi` | 2026.4.22 | see the wheel's metadata | pyodide/certifi-2026.4.22-py3-none-any.whl |
| Python package `charset-normalizer` | 3.4.7 | see the wheel's metadata | pyodide/charset_normalizer-3.4.7-py3-none-any.whl |
| Python package `idna` | 3.11 | see the wheel's metadata | pyodide/idna-3.11-py3-none-any.whl |
| Python package `jsonschema` | 4.26.0 | see the wheel's metadata | pyodide/jsonschema-4.26.0-py3-none-any.whl |
| Python package `jsonschema-specifications` | 2025.9.1 | see the wheel's metadata | pyodide/jsonschema_specifications-2025.9.1-py3-none-any.whl |
| Python package `lazy-object-proxy` | 1.12.0 | see the wheel's metadata | pyodide/lazy_object_proxy-1.12.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `pyrsistent` | 0.20.0 | see the wheel's metadata | pyodide/pyrsistent-0.20.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `pyyaml` | 6.0.3 | see the wheel's metadata | pyodide/pyyaml-6.0.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `referencing` | 0.37.0 | see the wheel's metadata | pyodide/referencing-0.37.0-py3-none-any.whl |
| Python package `requests` | 2.33.1 | see the wheel's metadata | pyodide/requests-2.33.1-py3-none-any.whl |
| Python package `rpds-py` | 0.30.0 | see the wheel's metadata | pyodide/rpds_py-0.30.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `six` | 1.17.0 | see the wheel's metadata | pyodide/six-1.17.0-py2.py3-none-any.whl |
| Python package `typing-extensions` | 4.15.0 | see the wheel's metadata | pyodide/typing_extensions-4.15.0-py3-none-any.whl |
| Python package `urllib3` | 2.6.3 | see the wheel's metadata | pyodide/urllib3-2.6.3-py3-none-any.whl |
| Python package `jsonschema_path` | 0.3.4 | see licenses/ and the wheel's metadata | wheels/jsonschema_path-0.3.4-py3-none-any.whl |
| Python package `pathable` | 0.4.4 | see licenses/ and the wheel's metadata | wheels/pathable-0.4.4-py3-none-any.whl |
| Python package `rfc3339_validator` | 0.1.4 | see licenses/ and the wheel's metadata | wheels/rfc3339_validator-0.1.4-py2.py3-none-any.whl |
| Python package `openapi_schema_validator` | 0.6.3 | see licenses/ and the wheel's metadata | wheels/openapi_schema_validator-0.6.3-py3-none-any.whl |
| Python package `openapi_spec_validator` | 0.7.1 | see licenses/ and the wheel's metadata | wheels/openapi_spec_validator-0.7.1-py3-none-any.whl |
