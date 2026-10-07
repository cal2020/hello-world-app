// Deletes Lattice's local data (registered repositories, scans, baselines, backups)
// and the generated scale fixture. Repository files are never touched.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(process.env.LATTICE_DATA ?? path.join(appRoot, ".lattice-data"));
for (const target of [dataDir, ...fs.readdirSync(path.join(appRoot, "fixtures")).filter((d) => d.startsWith("generated-")).map((d) => path.join(appRoot, "fixtures", d))]) {
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`Removed ${path.relative(appRoot, target) || target}`);
  }
}
// Undo the demo toggle if it was left on.
const search = path.join(appRoot, "fixtures/storefront/src/features/search/SearchPage.tsx");
const text = fs.readFileSync(search, "utf8");
const cleaned = text.replace(/^import \{ lines \} from "\.\.\/cart\/cartStore"; \/\/ demo: forbidden cross-feature import\nvoid lines;\n/, "");
if (cleaned !== text) {
  fs.writeFileSync(search, cleaned);
  console.log("Removed the demo cross-feature import from fixtures/storefront.");
}
console.log("Reset complete. Restart the service if it is running.");
