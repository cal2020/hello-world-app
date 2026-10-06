# Deliberate deviations from the Python reference

Every entry must be conservative (the JS port is never more permissive than Python), have a reason, and
be covered by a test. Anything not listed here must match Python exactly (see README "Tests").

| Area | Python | JS port | Why | Test |
|---|---|---|---|---|
| Numbers in `strict_loads` / `check_value` | accepts integral floats (`1.0`, `-0.0`, `1e2`) and integers up to 12288 bits | rejects integral float literals and integers outside ±(2^53−1) | JS has one number type: `1.0` would silently become `1`, and big integers lose precision, changing canonical digests | `10_canonical.test.js` "documented deviations…" |
| Canonical number output | `1.0` → `1.0` | integral numbers always print as integers | consequence of the above; engine data never contains integral floats (golden `_common.write` enforces this) | `10_canonical.test.js` |
