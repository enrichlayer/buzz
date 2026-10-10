import { waitForAnimations } from "../helpers/animations";
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { openSettings } from "../helpers/settings";

const manifest = JSON.parse(
  readFileSync(
    new URL(
      "../../../docs/examples/runtime-plugins/review-card.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const payload = {
  title: "Endpoint review",
  summary: "Choose how to handle authorization.",
  file: "auth.ts",
  diff: "--- a/auth.ts\n+++ b/auth.ts\n@@ -1 +1 @@\n-const auth = false;\n+const auth = true;",
};
const fence = `\`\`\`buzz-review-card\n${JSON.stringify(payload)}\n\`\`\``;

async function settings(page: Page) {
  await openSettings(page);
  await page.getByTestId("settings-nav-plugins").click();
  await expect(page.getByTestId("runtime-plugin-manifest-input")).toBeVisible();
}

async function seedThread(page: Page) {
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );
  return page.evaluate((content) => {
    const root = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Runtime plugin integration thread",
    });
    if (!root) throw new Error("Missing bridge");
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content,
      parentEventId: root.id,
    });
    return root.id;
  }, fence);
}

async function openThread(page: Page, root: string) {
  const back = page.getByRole("button", { name: "Back to app", exact: true });
  if (await back.isVisible()) await back.click();
  await page.getByTestId("channel-general").click();
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${root}"]`,
    )
    .click();
  return page.getByTestId("message-thread-panel");
}

async function sentMessageCount(page: Page) {
  return page.evaluate(
    () =>
      (window.__BUZZ_E2E_COMMAND_LOG__ ?? []).filter(
        (entry) => entry.command === "send_channel_message",
      ).length,
  );
}

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
  await page.goto("/");
});

test("install, render, update, disable, and remove a plugin without rebuilding", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify(manifest));
  await page.getByTestId("runtime-plugin-install").click();
  await expect(
    page.getByTestId("runtime-plugin-row-example.review-card"),
  ).toContainText(`v${manifest.version}`);

  // Navigate without reloading the app: live registration must reach Markdown.
  const root = await seedThread(page);
  const thread = await openThread(page, root);
  const card = thread.getByRole("region", {
    name: "Review card plugin content",
  });
  await expect(card).toContainText("Endpoint review");
  const accordion = card.locator("details");
  await expect(accordion).not.toHaveAttribute("open", "");
  await accordion.locator("summary").click();
  await expect(accordion).toHaveAttribute("open", "");
  await expect(accordion).toContainText("const auth = true");

  const before = await sentMessageCount(page);
  const decision = card.getByRole("group", { name: "Decision", exact: true });
  await expect(decision).toBeVisible();
  await decision.getByRole("button", { name: "Approve", exact: true }).focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    decision.getByRole("button", { name: "Needs changes" }),
  ).toBeFocused();
  await expect(
    decision.getByRole("button", { name: "Needs changes" }),
  ).toHaveAttribute("aria-pressed", "true");
  expect(await sentMessageCount(page)).toBe(before);
  await card
    .getByLabel("Feedback", { exact: true })
    .fill("Keep the OAuth path");
  await card.getByRole("button", { name: "Add to composer" }).click();
  await expect(thread.getByTestId("message-input")).toContainText(
    "Needs changes: Keep the OAuth path",
  );
  expect(await sentMessageCount(page)).toBe(before);
  await waitForAnimations(page);
  await thread.screenshot({
    path: "test-results/runtime-session-plugins/installed.png",
  });

  await settings(page);
  const updated = {
    ...manifest,
    version: "1.2.0",
    blocks: [{ type: "heading", text: "Updated live" }],
  };
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify(updated));
  await page.getByTestId("runtime-plugin-update").click();
  await openThread(page, root);
  await expect(card).toContainText("Updated live");

  await settings(page);
  await page.getByTestId("runtime-plugin-toggle-example.review-card").click();
  await openThread(page, root);
  await expect(card).toHaveCount(0);
  await expect(thread.locator("[data-code-block]")).toContainText(
    "Endpoint review",
  );

  await settings(page);
  await page
    .getByRole("button", { name: "Remove Review card", exact: true })
    .click();
  await expect(
    page.getByTestId("runtime-plugin-row-example.review-card"),
  ).toHaveCount(0);
});

test("unsupported manifests are rejected and malformed payloads retain readable source", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify({ ...manifest, schemaVersion: 2 }));
  await expect(page.getByTestId("runtime-plugin-install")).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText(
    "schemaVersion must be 1",
  );
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify(manifest));
  await page.getByTestId("runtime-plugin-install").click();
  const root = await seedThread(page);
  await page.evaluate((root) => {
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "```buzz-review-card\n{invalid json}\n```",
      parentEventId: root,
    });
  }, root);
  const thread = await openThread(page, root);
  await expect(thread.locator("[data-code-block]")).toContainText(
    "{invalid json}",
  );
});

test("segmented plugin choices retain values across narrow and enlarged-text layouts", async ({
  page,
}) => {
  await settings(page);
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify(manifest));
  await page.getByTestId("runtime-plugin-install").click();
  const root = await seedThread(page);
  const thread = await openThread(page, root);
  const card = thread.getByRole("region", {
    name: "Review card plugin content",
  });
  const group = card.getByRole("group", { name: "Decision", exact: true });
  await expect(group).toBeVisible();
  await group.getByRole("button", { name: "Needs changes" }).click();
  const before = await sentMessageCount(page);
  // Constrain the real card within the thread, representing a narrow plugin host.
  await card.evaluate((element) => {
    element.style.width = "180px";
    element.style.maxWidth = "100%";
  });
  await expect(card.getByLabel("Decision", { exact: true })).toHaveValue(
    "Needs changes",
  );
  await expect(group).toHaveCount(0);
  await waitForAnimations(page);
  await card.screenshot({
    path: "test-results/segmented-choices/plugin-narrow.png",
  });
  await card.evaluate((element) => {
    element.style.width = "";
  });
  await expect(group).toBeVisible();
  await expect(
    group.getByRole("button", { name: "Needs changes" }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  await expect
    .poll(() =>
      card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    )
    .toBe(true);
  await waitForAnimations(page);
  await card.screenshot({
    path: "test-results/segmented-choices/plugin-enlarged-text.png",
  });
  expect(await sentMessageCount(page)).toBe(before);
  await card.getByRole("button", { name: "Add to composer" }).click();
  await expect(thread.getByTestId("message-input")).toContainText(
    "Needs changes:",
  );
  expect(await sentMessageCount(page)).toBe(before);
});
