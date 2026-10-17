import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { type Page, test } from "@playwright/test";

// Capture tooling already requires Enrich Layer Tools. Reuse its actual DOM
// audit rather than maintaining a second implementation or inventing results.
const toolsRoot = process.env.EL_TOOLS_ROOT ?? join(homedir(), ".el-cli-main");
const evidenceModule = pathToFileURL(
  join(toolsRoot, "cli/el-visual-evidence/dist/lib/dom-mechanics.js"),
).href;

function directory() {
  const info = test.info();
  return join(
    process.env.EL_VE_OUTPUT_DIR ?? "test-results/visual-evidence",
    basename(info.file, ".capture.ts"),
    info.project.name,
  );
}

/** Capture the current state with measured DOM evidence for the canonical CLI. */
export async function captureState(page: Page, state: string) {
  const { auditDomMechanics, measureEvidencePageGeometry } = await import(
    evidenceModule
  );
  await mkdir(directory(), { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  const scope = {
    kind: "whole-page" as const,
    reason: "stateful-route-spec" as const,
    fullPage: true,
    page: await measureEvidencePageGeometry(page),
  };
  const path = join(directory(), `${state}.png`);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  const domMechanics = await auditDomMechanics(page, scope);
  await writeFile(
    path.replace(/\.png$/, ".evidence.json"),
    JSON.stringify({ version: 1, scope, domMechanics }),
  );
  await test.info().attach(state, { path, contentType: "image/png" });
  // Hold only while recording, so the real video has readable terminal states.
  if (page.video()) await page.waitForTimeout(900);
}

/** Finalize the real browser recording where the CLI harvests flow evidence. */
export async function saveFlowVideo(page: Page) {
  const video = page.video();
  if (!video) return;
  await mkdir(directory(), { recursive: true });
  await page.context().close();
  await video.saveAs(join(directory(), "suggestions.webm"));
}
