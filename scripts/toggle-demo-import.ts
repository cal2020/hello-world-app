// Demo helper: adds (or removes) one cross-feature import in the storefront fixture.
// Adding it creates a `no-cross-feature` violation; removing it resolves the finding.
// Usage: npm run demo:toggle [-- add|remove]   (no argument = toggle)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures/storefront/src/features/search/SearchPage.tsx");
const LINE = 'import { lines } from "../cart/cartStore"; // demo: forbidden cross-feature import';
const text = fs.readFileSync(file, "utf8");
const has = text.includes(LINE);
const want = process.argv[2] === "add" ? true : process.argv[2] === "remove" ? false : !has;
if (want === has) {
  console.log(`Import already ${has ? "present" : "absent"}; nothing to do.`);
} else {
  fs.writeFileSync(file, want ? `${LINE}\nvoid lines;\n${text}` : text.replace(`${LINE}\nvoid lines;\n`, ""));
  console.log(want ? "Added: search → cart import (expect 1 new no-cross-feature violation after rescanning)." : "Removed the search → cart import (the violation resolves after rescanning).");
}
