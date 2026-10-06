// The bundled engine loads under the strict CSP and computes Python-identical digests in a real browser.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const matrix = "single";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default async function (t) {
  await t.open();
  const g = JSON.parse(fs.readFileSync(path.join(ROOT, "golden", "canonical.json"), "utf8"));
  const mismatches = await t.page.evaluate((cases) => {
    const bad = [];
    for (const c of cases.canonical) if (HX.canonical.digest(c.value) !== c.digest) bad.push(c.canonical);
    for (const c of cases.floats) if (HX.canonical.py_float_repr(c.value) !== c.repr) bad.push(c.repr);
    for (const c of cases.sha256) if (HX.canonical.sha256_hex(c.text) !== c.sha256) bad.push(c.text);
    return bad;
  }, g);
  t.assert.deepEqual(mismatches, [], "browser digests differ from Python");
  t.assert.equal(await t.page.evaluate(() => HX.VERSION), "hexis-browser/1");
}
