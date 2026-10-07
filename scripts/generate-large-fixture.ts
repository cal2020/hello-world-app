// Generates a deterministic synthetic project for scale testing (default: 1,000 modules).
// Usage: npm run fixtures:large [-- <moduleCount>]
// Output: fixtures/generated-<count>/ (git-ignored). Contents are synthetic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const total = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(total) || total < 100 || total > 20000) {
  console.error("Module count must be an integer between 100 and 20000.");
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", `generated-${total}`);

// Mulberry32: deterministic so every run produces the same graph.
let seed = 0x5eed;
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const sharedCount = Math.round(total * 0.1);
const uiCount = Math.round(total * 0.06);
const appCount = Math.round(total * 0.04);
const featureNames = Array.from({ length: Math.max(4, Math.round(total / 50)) }, (_, i) => `feature-${String(i + 1).padStart(2, "0")}`);
const perFeature = Math.floor((total - sharedCount - uiCount - appCount) / featureNames.length);

type Mod = { file: string; imports: string[] };
const mods: Mod[] = [];
const shared = Array.from({ length: sharedCount }, (_, i) => `src/shared/${["util", "model", "net", "format"][i % 4]}/m${i}.ts`);
const ui = Array.from({ length: uiCount }, (_, i) => `src/ui/${["form", "layout", "data"][i % 3]}/C${i}.tsx`);
const features = featureNames.map((f) => Array.from({ length: perFeature }, (_, i) => `src/features/${f}/${["model", "view", "state"][i % 3]}/f${i}.ts${i % 3 === 1 ? "x" : ""}`));
const app = Array.from({ length: appCount }, (_, i) => `src/app/a${i}.ts`);

shared.forEach((f, i) => mods.push({ file: f, imports: i > 2 ? [shared[Math.floor(rand() * i)], shared[Math.floor(rand() * i)]] : [] }));
ui.forEach((f, i) => mods.push({ file: f, imports: [pick(shared), ...(i > 0 ? [ui[Math.floor(rand() * i)]] : [])] }));
features.forEach((fs_) =>
  fs_.forEach((f, i) => {
    const own = i > 0 ? Array.from({ length: 1 + Math.floor(rand() * 3) }, () => fs_[Math.floor(rand() * i)]) : [];
    mods.push({ file: f, imports: [...own, pick(shared), ...(f.endsWith("x") ? [pick(ui)] : [])] });
  }),
);
app.forEach((f) => mods.push({ file: f, imports: [pick(features)[0], pick(features)[1], pick(shared)] }));

// Deliberate findings: cross-feature imports, cycles, one unresolved import.
const byFile = new Map(mods.map((m) => [m.file, m]));
for (let k = 0; k < 6; k++) byFile.get(features[k][5])!.imports.push(features[k + 1][7]);
for (let k = 0; k < 3; k++) byFile.get(features[k * 2][2])!.imports.push(features[k * 2][9]);
byFile.get(shared[10])!.imports.push("./does-not-exist");

const rel = (from: string, to: string) => {
  if (to.startsWith("./")) return to;
  let r = path.posix.relative(path.posix.dirname(from), to).replace(/\.tsx?$/, "");
  if (!r.startsWith(".")) r = `./${r}`;
  return r;
};

fs.rmSync(root, { recursive: true, force: true });
for (const m of mods) {
  const abs = path.join(root, m.file);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const unique = [...new Set(m.imports.filter((x) => x !== m.file))];
  const lines = unique.map((t, i) => `import * as d${i} from "${rel(m.file, t)}";`);
  lines.push(`export const id = ${JSON.stringify(m.file)};`, `export const deps = [${unique.map((_, i) => `d${i}`).join(", ")}];`);
  fs.writeFileSync(abs, lines.join("\n") + "\n");
}
fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: `generated-${total}`, private: true, type: "module", description: `Synthetic fixture — generated ${mods.length}-module project for scale testing` }, null, 2) + "\n");
fs.writeFileSync(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "ESNext", moduleResolution: "bundler", jsx: "react-jsx", noEmit: true }, include: ["src"] }, null, 2) + "\n");
fs.writeFileSync(
  path.join(root, "detangle.toml"),
  `# Generated rules for the scale fixture.

[[forbidden]]
name = "no-circular"
severity = "warn"
to = { circular = true }

[[forbidden]]
name = "not-to-unresolvable"
severity = "error"
to = { could_not_resolve = true }

[[forbidden]]
name = "no-cross-feature"
severity = "error"
from = { path = '^src/features/([^/]+)/' }
to = { path = '^src/features/', path_not = '^src/features/$1/' }
`,
);
console.log(`Wrote ${mods.length} modules to ${path.relative(process.cwd(), root)}`);
