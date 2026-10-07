import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

const FIXTURES = path.resolve(import.meta.dirname, "../../fixtures");
const shots = path.resolve(import.meta.dirname, "../../.e2e-screens");
fs.mkdirSync(shots, { recursive: true });

function copyFixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-e2e-repo-"));
  const dest = path.join(dir, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return fs.realpathSync(dest);
}

async function register(page: Page, root: string, name: string) {
  await page.goto("/");
  const nav = page.getByRole("button", { name: "Open navigation" });
  if (await nav.isVisible()) await nav.click();
  await page.getByRole("button", { name: /Register (a )?repository/ }).first().click();
  await page.locator("#reg-path").fill(root);
  await page.locator("#reg-name").fill(name);
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

async function scan(page: Page) {
  await page.getByRole("button", { name: /^(Scan|Rescan)$/ }).click();
  await expect(page.getByRole("button", { name: /^Rescan$/ })).toBeVisible({ timeout: 30_000 });
}

test("invalid paths produce actionable errors", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /Register a repository/ }).first().click();
  await page.locator("#reg-path").fill("relative/path");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Use an absolute path/)).toBeVisible();
  await page.locator("#reg-path").fill("/");
  await page.getByRole("button", { name: "Register", exact: true }).click();
  await expect(page.getByText(/Refusing to scan a filesystem root/)).toBeVisible();
});

test("inspect, explain, design a rule, baseline and compare", async ({ page }) => {
  const root = copyFixture("storefront");
  await register(page, root, "storefront-e2e");
  await scan(page);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.screenshot({ path: `${shots}/graph.png` });

  // Violations list -> explanation with the offending import
  await page.getByRole("tab", { name: /Violations/ }).click();
  await page.getByRole("button", { name: /submitOrder\.ts.*cartStore\.ts/ }).click();
  const details = page.getByRole("complementary", { name: "Details" });
  await expect(details.getByText("Forbidden import across a boundary")).toBeVisible();
  await expect(details.getByText("“../cart/cartStore”", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: /cartStore\.ts.*pricing\.ts/ }).click();
  await expect(details.getByText("2-module import cycle")).toBeVisible();
  await expect(details.getByText(/type-only imports are ignored/)).toBeVisible();
  await page.screenshot({ path: `${shots}/violations.png` });

  // Graph and list identify the same modules
  await details.getByRole("button", { name: "Show in graph" }).click();
  await expect(page.getByText(/1-hop neighborhood/)).toBeVisible();
  await page.getByRole("tab", { name: /Modules/ }).click();
  await page.getByRole("switch").first().click(); // "With violations"
  // submitOrder, cartStore, pricing, ProductCard and the unresolved ./analytics
  await expect(page.locator("tbody tr[aria-selected]")).toHaveCount(5);

  // Baseline before the change
  await page.getByRole("tab", { name: /Baseline/ }).click();
  await page.getByLabel("Baseline name").fill("before search change");
  await page.getByRole("button", { name: "Save current scan" }).click();
  await expect(page.getByText("No changes since this baseline.")).toBeVisible();

  // Introduce one forbidden import, rescan, compare
  const f = path.join(root, "src/features/search/SearchPage.tsx");
  fs.writeFileSync(f, `import { lines } from "../cart/cartStore";\nvoid lines;\n${fs.readFileSync(f, "utf8")}`);
  await scan(page);
  await expect(page.getByRole("button", { name: /New\s*1/ })).toBeVisible();
  await expect(page.getByText(/src\/features\/search\/SearchPage\.tsx/).first()).toBeVisible();
  await page.screenshot({ path: `${shots}/compare.png` });

  // Design a rule visually, preview with the engine, save
  await page.getByRole("tab", { name: /Rules/ }).click();
  await page.getByRole("button", { name: "New rule" }).first().click();
  await page.getByRole("radio", { name: /Forbid imports between paths/ }).click();
  await page.locator("#rule-name").fill("features-not-to-api");
  await page.locator("#from-path").fill("^src/features/");
  await page.locator("#to-path").fill("^src/api/");
  await page.locator("#rule-comment").fill("Features fetch through shared hooks.");
  await expect(page.getByRole("button", { name: /Save to detangle.toml/ })).toBeDisabled();
  await page.getByRole("button", { name: "Preview with engine" }).click();
  await expect(page.getByText("New violations")).toBeVisible();
  await expect(page.getByText("+name = 'features-not-to-api'")).toBeVisible();
  await page.screenshot({ path: `${shots}/rule-preview.png` });
  // Editing after preview invalidates it
  await page.locator("#rule-comment").fill("Changed.");
  await expect(page.getByRole("button", { name: /Save to detangle.toml/ })).toBeDisabled();
  await page.getByRole("button", { name: "Preview with engine" }).click();
  await page.getByRole("button", { name: /Save to detangle.toml/ }).click();
  await expect(page.getByText(/Saved\. Previous file backed up/)).toBeVisible();
  const saved = fs.readFileSync(path.join(root, "detangle.toml"), "utf8");
  expect(saved).toContain("name = 'features-not-to-api'");
  expect(saved).toContain("# The design system must stay app-agnostic.");
  await expect(page.getByRole("button", { name: /^Rescan$/ })).toBeVisible({ timeout: 30_000 });

  // After reload, state persists
  await page.reload();
  await expect(page.getByRole("heading", { name: "storefront-e2e", level: 1 })).toBeVisible();
  await page.getByRole("tab", { name: /Violations/ }).click();
  await expect(page.getByText("features-not-to-api").first()).toBeVisible();
});

test("narrow viewport keeps essential actions available", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const root = copyFixture("boundary-app");
  await register(page, root, "boundary-mobile");
  await scan(page);
  await page.getByRole("tab", { name: /Violations/ }).click();
  await page.getByRole("button", { name: /view\.ts.*store\.ts/ }).click();
  await expect(page.getByText("Forbidden import across a boundary")).toBeVisible();
  await page.screenshot({ path: `${shots}/mobile.png` });
  await page.getByRole("button", { name: "Close details" }).click();
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(page.getByRole("navigation", { name: "Repositories" })).toBeInViewport();
});

test("1,000-module graph stays navigable", async ({ page }) => {
  const big = path.join(FIXTURES, "generated-1000");
  test.skip(!fs.existsSync(big), "run npm run fixtures:large first");
  await register(page, big, "generated-1000");
  let t = Date.now();
  await scan(page);
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  const scanToGraph = Date.now() - t;

  t = Date.now();
  await page.getByRole("button", { name: "Expand src/features" }).click();
  await expect(page.locator(".react-flow__node").filter({ hasText: "feature-01/" })).toBeVisible();
  const expand = Date.now() - t;

  t = Date.now();
  await page.getByRole("button", { name: /Search modules/ }).click();
  await page.getByRole("textbox", { name: "Search" }).fill("feature-03/view/f7.tsx");
  await page.keyboard.press("Enter");
  await page.getByRole("switch", { name: "Neighborhood" }).click();
  await expect(page.getByText(/hop neighborhood/)).toBeVisible();
  const neighborhood = Date.now() - t;

  await page.waitForTimeout(600); // let the fit animation settle before measuring/screenshotting
  const rendered = await page.locator(".react-flow__edge").count();
  await page.screenshot({ path: `${shots}/large.png` });
  console.log(`[measure] scan→graph ${scanToGraph} ms · expand folder ${expand} ms · search+neighborhood ${neighborhood} ms · edges in DOM ${rendered}`);
  expect(rendered).toBeLessThan(700);
});
