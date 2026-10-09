// End-to-end checks of the real UI against the e2e environment (synthetic fixture + fake model endpoint; TEST ONLY).
import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const info = JSON.parse(readFileSync(process.env.AH_E2E ?? "/tmp/ah-e2e/e2e.json", "utf8"));
const SHOTS = process.env.AH_SHOTS ?? "../evidence/screenshots";
mkdirSync(SHOTS, { recursive: true });
const dv = encodeURIComponent(info.dataset_version);

async function login(page: Page, role = "operator") {
  await page.goto(`/#login=${encodeURIComponent(info.tokens[role])}`);
  await expect(page.getByText("Research workbench").first()).toBeAttached();
  await expect(page).not.toHaveURL(/login=/); // the token is removed from the address bar
}

async function shot(page: Page, name: string, project: string) {
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/${name}-${project}.png`, fullPage: false });
}

test("coverage, explorer, inspection, pair views", async ({ page }, ti) => {
  await login(page);
  await expect(page.getByRole("heading", { name: "Data coverage" })).toBeVisible();
  await expect(page.getByText("Synthetic test fixture — not benchmark content").first()).toBeVisible();
  await expect(page.getByText("Exact reproduction of the paper's AH / AH-S tables is blocked")).toBeVisible();
  await shot(page, "A-coverage", ti.project.name);
  // Supplemental sources imported from the pinned AgentRewardBench / OSWorld checkouts (real annotations and
  // task definitions, no trajectories) — shown apart from the AgentHorizon dataset.
  const supp = page.getByRole("heading", { name: "Supplemental sources (kept separate)" });
  await supp.scrollIntoViewIfNeeded();
  await expect(page.getByRole("heading", { name: "AgentRewardBench" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Annotator agreement in the release/ })).toBeVisible();
  await page.evaluate(() => {
    const h = [...document.querySelectorAll("h2")].find((e) => e.textContent?.startsWith("Supplemental sources"));
    h?.scrollIntoView({ block: "start" });
  });
  await page.screenshot({ path: `${SHOTS}/A2-supplemental-${ti.project.name}.png`, fullPage: false });

  await page.goto(`/explore/${dv}?min_steps=300`);
  await expect(page.getByText(/matching examples/)).toBeVisible();
  const first = page.locator("a.result").first();
  await expect(first).toBeVisible();
  await shot(page, "B-explorer", ti.project.name);

  const t0 = Date.now();
  await first.click();
  await expect(page.locator(".step img.thumb").first()).toBeVisible();
  const firstEvidenceMs = Date.now() - t0;
  const thumbs = await page.locator(".step img.thumb").count();
  expect(thumbs).toBeLessThan(60); // a 320-step trajectory never renders every screenshot at once
  if (ti.project.name === "desktop") {
    await page.keyboard.press("End");
    await expect(page).toHaveURL(/step=319/);
    await page.keyboard.press("Home");
    await expect(page).toHaveURL(/step=0/);
    await page.keyboard.press("ArrowDown");
    await expect(page).toHaveURL(/step=1/);
    await expect(page.locator(".viewer-stage img")).toBeVisible();
  }
  await shot(page, "C-inspection", ti.project.name);
  writeFileSync(`${SHOTS}/../timing-${ti.project.name}.json`, JSON.stringify({ first_visible_thumbnail_ms: firstEvidenceMs, thumbnails_rendered: thumbs }));

  await page.getByRole("link", { name: "Pair inspection" }).click();
  await expect(page.getByText("Privileged research view — audited")).toBeVisible();
  await shot(page, "D-pair", ti.project.name);
});

test("experiment setup to monitor, score, results, export", async ({ page }, ti) => {
  test.skip(ti.project.name !== "desktop", "one full run is enough; mobile layout is covered by screenshots");
  await login(page, "researcher");
  await page.goto("/runs/new");
  await page.getByLabel("Registered configuration").selectOption("direct:qwen3.6-27b:native-512x332");
  await page.getByLabel("Smoke subset size").fill("4");
  await page.getByLabel("Self-hosted endpoint (vLLM)").fill(info.fake_llm);
  await page.getByLabel("Label").fill("e2e fixture pilot");
  // a fresh trial index gives a fresh run identity, so re-running the suite never resumes an earlier run
  await page.getByLabel("Trial index (repeats are separate runs)").fill(String(2 + Math.floor(Math.random() * 900)));
  await page.getByRole("button", { name: "Validate and forecast (dry run)" }).click();
  await expect(page.getByRole("region", { name: "Plan" })).toBeVisible();
  await expect(page.getByText("test fixture").first()).toBeVisible();
  await shot(page, "E-setup", ti.project.name);
  await page.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/run-/);
  await expect(page.getByText("completed", { exact: true }).first()).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("finalized 4 of 4")).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Score now" }).click();
  await expect(page.getByText(/balanced accuracy/).first()).toBeVisible({ timeout: 60_000 });
  await page.getByRole("button", { name: "Bundle with score" }).click();
  await expect(page.getByRole("link", { name: /export #\d+/ }).first()).toBeVisible({ timeout: 60_000 });
  await shot(page, "F-monitor", ti.project.name);
  await page.locator(".table-wrap tbody tr").first().click();
  await expect(page.getByText("Attempt history")).toBeVisible();

  const runId = page.url().split("/runs/")[1].split("?")[0];
  await page.goto(`/results?runs=${runId}`);
  await expect(page.getByText("Balanced accuracy").first()).toBeVisible();
  await expect(page.getByText(/Selection subset score/)).toBeVisible();
  await shot(page, "G-results", ti.project.name);
});

test("blind review then audited reveal", async ({ page }, ti) => {
  await login(page, "reviewer");
  await page.goto("/review");
  await expect(page.getByRole("heading", { name: "Your queue" })).toBeVisible();
  const item = page.locator("tbody tr").first();
  await item.click();
  await expect(page.getByText("Blind phase")).toBeVisible();
  await expect(page.getByText("Gold label", { exact: true })).toHaveCount(0); // no gold value before the blind verdict
  await expect(page.getByText(/gold: (positive|negative)/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Reveal gold label and pair evidence" })).toBeDisabled();
  await page.getByLabel("Failure").check();
  await page.getByLabel("Failure category (rubric)").selectOption("Critical Mistake");
  await page.getByLabel("Rationale (cite evidence)").fill("The final screenshot does not show the requested result.");
  await page.getByRole("button", { name: /Cite current step/ }).click();
  await shot(page, "H-review-blind", ti.project.name);
  await page.getByRole("button", { name: "Save annotation" }).click();
  await page.getByRole("button", { name: "Reveal gold label and pair evidence" }).click();
  await expect(page.getByText("Gold label")).toBeVisible();
  await shot(page, "H-review-revealed", ti.project.name);
});

test("roles gate navigation and privileged views", async ({ page }, ti) => {
  test.skip(ti.project.name !== "desktop", "role checks are viewport independent");
  await login(page, "viewer");
  await expect(page.getByRole("link", { name: "Experiment setup" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Human review" })).toHaveCount(0);
  const r = await page.request.get(`/api/research/datasets/${dv}/labelled`);
  expect(r.status()).toBe(403);
  const csrf = await page.request.post("/api/runs/plan", { data: {} });
  expect(csrf.status()).toBe(403);
});

test("operations console", async ({ page }, ti) => {
  await login(page);
  await page.goto("/admin");
  // the capability probe is a judge-queue job: the worker that executes runs measures itself
  await page.getByRole("button", { name: "Refresh capability report" }).click();
  await expect(page.getByText(/measured by judge@e2e/)).toBeVisible({ timeout: 90_000 });
  await page.getByRole("tab", { name: "Workers" }).click();
  await expect(page.getByText("judge@e2e")).toBeVisible();
  await page.getByRole("tab", { name: "Jobs" }).click();
  await shot(page, "admin-jobs", ti.project.name);
  await page.getByRole("tab", { name: "Audit log" }).click();
  await expect(page.getByText("run.create").first()).toBeVisible();
});
