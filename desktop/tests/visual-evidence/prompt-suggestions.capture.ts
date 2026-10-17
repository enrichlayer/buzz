// @flow-steps: 01-free-text, 02-editable-draft, 03-dismissed, 04-thread-suggestions, 05-thread-draft, 06-inbox-preview, 07-search-preview
// @flow-motion
import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";
import {
  SUGGESTION_AGENT,
  SUGGESTION_ANSWER,
  SUGGESTION_PROMPT,
} from "../helpers/promptSuggestions";
import { captureState, saveFlowVideo } from "./capture";

// Real desktop React renderer with the same mocked Tauri/relay bridge as the
// existing regression suite. This proves UI behavior, not relay delivery.
test.afterEach(async ({ page }) => {
  await saveFlowVideo(page);
});

test("optional prompts preserve free text in channel and thread composers", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: SUGGESTION_AGENT,
        name: "Alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  // Open the existing fixture channel directly; sidebar animation/focus traps
  // are outside this composer workflow, especially at narrow viewports.
  await page.goto("/#/channels/9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50");
  await page.waitForFunction(() =>
    window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "general",
    }),
  );
  let createdAt = Math.floor(Date.now() / 1000);
  const post = (parentEventId?: string) =>
    page.evaluate(
      ({ parentEventId, content, pubkey, createdAt }) =>
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "general",
          content,
          pubkey,
          parentEventId,
          createdAt,
        }),
      {
        parentEventId,
        content: SUGGESTION_ANSWER,
        pubkey: SUGGESTION_AGENT,
        createdAt: createdAt++,
      },
    );
  const editor = page.getByTestId("message-input");
  await editor.fill("My existing draft");
  await editor.focus();
  const root = await post();
  if (!root?.id) throw new Error("Mock agent response did not arrive");
  const chips = page.getByTestId("prompt-suggestions");
  await expect(chips).toBeVisible();
  await expect(editor).toHaveText("My existing draft");
  await expect(editor).toBeFocused();
  await waitForAnimations(page);
  await captureState(page, "01-free-text");
  await chips.getByRole("button", { name: "Use the account name" }).click();
  await expect(editor).toContainText("My existing draft");
  await expect(editor).toContainText(SUGGESTION_PROMPT);
  await expect(editor).toBeFocused();
  await expect(chips).toHaveCount(0);
  await captureState(page, "02-editable-draft");
  await post();
  await expect(chips).toBeVisible();
  await chips.getByRole("button", { name: "Dismiss suggestions" }).click();
  await expect(chips).toHaveCount(0);
  await expect(editor).toContainText("My existing draft");
  await captureState(page, "03-dismissed");
  await page.locator(`[data-message-id="${root.id}"]`).hover();
  await page.getByTestId(`reply-message-${root.id}`).click();
  const panel = page.getByTestId("message-thread-panel");
  const threadEditor = panel.getByTestId("message-input");
  await threadEditor.fill("Thread draft");
  await threadEditor.focus();
  await post(root.id);
  const threadChips = panel.getByTestId("prompt-suggestions");
  await expect(threadChips).toBeVisible();
  await expect(threadEditor).toBeFocused();
  await captureState(page, "04-thread-suggestions");
  await threadChips
    .getByRole("button", { name: "Use the account name" })
    .click();
  await expect(threadEditor).toContainText("Thread draft");
  await expect(threadEditor).toContainText(SUGGESTION_PROMPT);
  await expect(threadChips).toHaveCount(0);
  await waitForAnimations(page);
  await captureState(page, "05-thread-draft");
  expect(
    await page.evaluate(
      () =>
        (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? []).filter(
          (event) =>
            event.content.includes("My existing draft") ||
            event.content.includes("Thread draft"),
        ).length,
    ),
  ).toBe(0);
  // Exercise the actual preview consumers using the existing feed bridge.
  await page.goto("/");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );
  const previewId = await page.evaluate(
    ({ content, pubkey, recipient }) => {
      const event = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        pubkey,
        mentionPubkeys: [recipient],
      });
      if (!event) throw new Error("Preview event missing");
      const push = (
        window as Window & {
          __BUZZ_E2E_PUSH_MOCK_FEED_ITEM__?: (
            item: Record<string, unknown>,
          ) => unknown;
        }
      ).__BUZZ_E2E_PUSH_MOCK_FEED_ITEM__;
      if (!push) throw new Error("Feed bridge missing");
      push({
        ...event,
        channel_id: "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50",
        channel_name: "general",
        category: "mention",
      });
      return event.id;
    },
    {
      content: SUGGESTION_ANSWER,
      pubkey: SUGGESTION_AGENT,
      recipient: TEST_IDENTITIES.tyler.pubkey,
    },
  );
  const preview = page.getByTestId(`home-inbox-item-${previewId}`);
  await expect(preview).toContainText(
    "The account label now follows login changes",
  );
  await expect(preview).not.toContainText("suggested-prompts");
  await captureState(page, "06-inbox-preview");
  const searchTrigger = page.getByRole("button", {
    name: "Search everything",
    exact: true,
  });
  if (!(await searchTrigger.isVisible())) {
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
  }
  await searchTrigger.click();
  await page.getByTestId("search-dialog-input").fill("account label");
  const search = page.getByTestId("search-results");
  await expect(search).toContainText(
    "The account label now follows login changes",
  );
  await expect(search).not.toContainText("suggested-prompts");
  await captureState(page, "07-search-preview");
  expect(errors).toEqual([]);
});
