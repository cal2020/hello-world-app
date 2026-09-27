# Third-party components in this static build

License texts are in [licenses/](licenses/) (sources and checksums: [licenses/SOURCES.md](licenses/SOURCES.md)).

| Component | Version | License | Where it is |
|---|---|---|---|
| Pyodide | 314.0.7 | MPL-2.0 | pyodide/ |
| CPython (inside Pyodide), with incorporated expat, libffi, zlib, libmpdec, mimalloc, zstd bindings | 3.14.2 | PSF-2.0 and notices in CPython-*-incorporated-software.rst | pyodide/pyodide.asm.wasm, python_stdlib.zip |
| HACL* (CPython's hash implementations, inside Pyodide) | — | MIT (HACL-star-MIT-LICENSE.txt) | pyodide/pyodide.asm.wasm |
| Emscripten runtime and system libraries: musl libc, libc++abi, compiler-rt (inside Pyodide) | emsdk 5.0.3 | MIT / University of Illinois NCSA; musl MIT; LLVM Apache-2.0 with LLVM exception | pyodide/pyodide.asm.mjs, pyodide.asm.wasm |
| SQLite (inside Pyodide) | — | Public domain | pyodide/pyodide.asm.wasm |
| bzip2, Zstandard (inside Pyodide) | — | bzip2 license; BSD-3-Clause | pyodide/pyodide.asm.wasm |
| Open Policy Agent Wasm runtime (compiled into each policy module) | 1.20.0 | Apache-2.0 | opa/*.wasm |
| RE2, libmpdec, LLVM libc++ (inside OPA's Wasm runtime; libc++ also inside Pyodide) | — | BSD-3-Clause; BSD-2-Clause (see CPython incorporated software); Apache-2.0 with LLVM exception | opa/*.wasm, pyodide/pyodide.asm.wasm |
| @open-policy-agent/opa-wasm | 1.10.0 | Apache-2.0 | vendor/opa-wasm-browser.esm.js |
| sprintf-js, yaml (bundled inside opa-wasm) | 1.1.3, 1.10.3 | BSD-3-Clause; ISC | vendor/opa-wasm-browser.esm.js |
| Python package `attrs` | 26.1.0 | see the wheel's metadata | pyodide/attrs-26.1.0-py3-none-any.whl |
| Python package `jsonschema` | 4.26.0 | see the wheel's metadata | pyodide/jsonschema-4.26.0-py3-none-any.whl |
| Python package `jsonschema-specifications` | 2025.9.1 | see the wheel's metadata | pyodide/jsonschema_specifications-2025.9.1-py3-none-any.whl |
| Python package `pyrsistent` | 0.20.0 | see the wheel's metadata | pyodide/pyrsistent-0.20.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `referencing` | 0.37.0 | see the wheel's metadata | pyodide/referencing-0.37.0-py3-none-any.whl |
| Python package `regex` | 2026.3.32 | see the wheel's metadata | pyodide/regex-2026.3.32-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `rpds-py` | 0.30.0 | see the wheel's metadata | pyodide/rpds_py-0.30.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl |
| Python package `six` | 1.17.0 | see the wheel's metadata | pyodide/six-1.17.0-py2.py3-none-any.whl |
| Python package `typing-extensions` | 4.15.0 | see the wheel's metadata | pyodide/typing_extensions-4.15.0-py3-none-any.whl |
| NIST OSCAL component-definition JSON Schema | 1.2.3 | Public domain (NIST) | app.zip |
| NIST SP 800-53 Rev 5.2.0 catalog excerpt (OSCAL) | 5.2.0 | Public domain (NIST) | app.zip |
