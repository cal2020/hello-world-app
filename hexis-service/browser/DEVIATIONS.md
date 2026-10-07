# Deliberate deviations from the Python reference

Every entry must be conservative (the JS port is never more permissive than Python), have a reason, and
be covered by a test. Anything not listed here must match Python exactly (see README "Tests").

| Area | Python | JS port | Why | Test |
|---|---|---|---|---|
| Numbers in `strict_loads` / `check_value` | accepts integral floats (`1.0`, `-0.0`, `1e2`) and integers up to 12288 bits | rejects integral float literals and integers outside ±(2^53−1) | JS has one number type: `1.0` would silently become `1`, and big integers lose precision, changing canonical digests | `10_canonical.test.js` "documented deviations…" |
| Canonical number output | `1.0` → `1.0` | integral numbers always print as integers | consequence of the above. Engine data that goes through `strict_loads` never carries an integral float, but Python can produce some itself: integral TIMING values, stored timestamps and an approval's `expires_at` (stored as `1`; the scope digest hashes `expires_at` as a float, see `deviations/runtime.md` #2), integral-float disjointness counterexamples (`deviations/static.md` #5), and `Any`-typed values such as a counter's `Variable.init` (`0.0` fails `COUNTER_INIT` in Python but is `0` after a plain `JSON.parse`, `static.md` #6). Golden files store none (`_common.write` enforces this) | `10_canonical.test.js` |
