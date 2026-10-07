import { expect, test, type Page } from "@playwright/test";

import { installMockBridge } from "../helpers/bridge";

const SHOTS = "test-results/code-fence-plugins";

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: "http://127.0.0.1:4173",
  });
});

async function sendFromClipboard(page: Page, text: string) {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.evaluate((value) => navigator.clipboard.writeText(value), text);
  await page.getByTestId("message-input").click();
  await page.keyboard.press("ControlOrMeta+V");
  await page.getByTestId("send-message").click();
}

test("a mermaid fence renders as a diagram", async ({ page }) => {
  await sendFromClipboard(
    page,
    "```mermaid\nflowchart LR\n  Start --> Review --> Ship\n```",
  );

  const row = page.getByTestId("message-row").last();
  const diagram = row.getByRole("img", { name: "Diagram" });
  await expect(diagram.locator("svg")).toBeVisible();
  await expect(diagram).toContainText("Review");
  await expect(row.locator("[data-code-block]")).toHaveCount(0);
  await diagram.screenshot({ path: `${SHOTS}/01-flowchart.png` });
});

test("an invalid mermaid fence falls back to its source", async ({ page }) => {
  await sendFromClipboard(page, "```mermaid\nnot a diagram ->\n```");

  const row = page.getByTestId("message-row").last();
  await expect(row.getByText("Could not draw this diagram")).toBeVisible();
  // The fallback is the normal code block, copy button included.
  await expect(row.locator("[data-code-block]")).toContainText(
    "not a diagram ->",
  );
});
