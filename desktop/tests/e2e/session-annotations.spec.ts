import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

test.setTimeout(60_000);

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const AGENT_PUBKEY = TEST_IDENTITIES.charlie.pubkey;
const ROOT_A = "1".repeat(64);
const ROOT_B = "2".repeat(64);
const PUBLISHED_AGENT_REPLY = "3".repeat(64);
const SESSION_ID = "shared-annotation-session";
const TURN_A = "annotation-turn-a";
const TURN_B = "annotation-turn-b";
const ASSISTANT_MESSAGE_ID = "assistant-answer-a";
const ASSISTANT_SOURCE_ID = `assistant:${CHANNEL_ID}:${ASSISTANT_MESSAGE_ID}`;
const ASSISTANT_TEXT = [
  "Use the thread-local result:",
  "",
  "```ts",
  "const stable = true;",
  "const routed = threadId;",
  "```",
  "",
  "Then publish it.",
].join("\n");
const FEEDBACK = "Keep this tied to the current thread.";

type ObserverEvent = {
  seq: number;
  timestamp: string;
  kind: string;
  agentIndex: number | null;
  channelId: string | null;
  sessionId: string | null;
  turnId: string | null;
  payload: unknown;
};

function sessionUpdate(
  seq: number,
  turnId: string,
  update: Record<string, unknown>,
): ObserverEvent {
  return {
    seq,
    timestamp: new Date(1_780_000_000_000 + seq * 1_000).toISOString(),
    kind: "acp_read",
    agentIndex: 0,
    channelId: CHANNEL_ID,
    sessionId: SESSION_ID,
    turnId,
    payload: {
      method: "session/update",
      params: { sessionId: SESSION_ID, update },
    },
  };
}

async function seedThreadsAndObserver(page: Page) {
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
      typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  const events = [
    sessionUpdate(1, TURN_A, {
      sessionUpdate: "user_message_chunk",
      messageId: ROOT_A,
      content: { type: "text", text: "Review the thread-local result" },
    }),
    sessionUpdate(2, TURN_A, {
      sessionUpdate: "agent_message_chunk",
      messageId: ASSISTANT_MESSAGE_ID,
      content: { type: "text", text: ASSISTANT_TEXT },
    }),
    sessionUpdate(3, TURN_B, {
      sessionUpdate: "user_message_chunk",
      messageId: ROOT_B,
      content: { type: "text", text: "Unrelated sibling request" },
    }),
    sessionUpdate(4, TURN_B, {
      sessionUpdate: "agent_message_chunk",
      messageId: "assistant-answer-b",
      content: {
        type: "text",
        text: "Sibling thread activity must stay isolated.",
      },
    }),
  ];
  await page.evaluate(
    ({ agentPubkey, rootA, rootB, publishedAgentReply, events }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Review the thread-local result",
        id: rootA,
        mentionPubkeys: [agentPubkey],
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Unrelated sibling request",
        id: rootB,
        mentionPubkeys: [agentPubkey],
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Published agent conclusion.",
        id: publishedAgentReply,
        parentEventId: rootA,
        pubkey: agentPubkey,
      });
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events,
      });
    },
    {
      agentPubkey: AGENT_PUBKEY,
      rootA: ROOT_A,
      rootB: ROOT_B,
      publishedAgentReply: PUBLISHED_AGENT_REPLY,
      events,
    },
  );
}

async function openThread(page: Page, rootId: string) {
  await page.getByTestId("channel-general").click();
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${rootId}"]`,
    )
    .click();
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  return panel;
}

async function selectRenderedText(page: Page, locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) throw new Error("selection target has no browser bounds");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + Math.min(box.width - 2, 260), y, {
    steps: 12,
  });
  await page.mouse.up();
}

async function sentMessageCommand(page: Page, comment: string) {
  await expect
    .poll(() =>
      page.evaluate(
        (needle) =>
          (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).find(
            (entry) =>
              entry.command === "send_channel_message" &&
              typeof (entry.payload as { content?: unknown }).content ===
                "string" &&
              (entry.payload as { content: string }).content.includes(needle),
          )?.payload ?? null,
        comment,
      ),
    )
    .not.toBeNull();

  return page.evaluate((needle) => {
    const payload = (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).find(
      (entry) =>
        entry.command === "send_channel_message" &&
        typeof (entry.payload as { content?: unknown }).content === "string" &&
        (entry.payload as { content: string }).content.includes(needle),
    )?.payload as
      | {
          channelId: string;
          content: string;
          kind: number | null;
          mentionPubkeys: string[];
          parentEventId: string;
          rootEventId: string;
        }
      | undefined;
    if (!payload) throw new Error("annotation send command was not captured");
    return payload;
  }, comment);
}

test("selected assistant code sends immutable feedback to the exact agent thread", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Charlie",
        status: "running",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await seedThreadsAndObserver(page);

  const thread = await openThread(page, ROOT_A);
  const activity = thread.getByTestId("agent-thread-session-activity");
  await expect(activity).toBeVisible();
  await expect(activity).toContainText("const routed = threadId;");
  await expect(activity).not.toContainText(
    "Sibling thread activity must stay isolated.",
  );

  const codeLine = activity.locator('[data-code-line="2"]');
  await expect(codeLine).toHaveText("const routed = threadId;");
  await selectRenderedText(page, codeLine);
  await activity
    .getByRole("button", { name: "Comment on selected text" })
    .click();

  const feedback = page.getByRole("textbox", { name: "Feedback" });
  await expect(feedback).toBeVisible();
  await expect(
    page.locator("blockquote").filter({ hasText: "const routed = threadId;" }),
  ).toBeVisible();
  await feedback.fill(FEEDBACK);
  await page.getByRole("button", { name: "Send feedback" }).click();
  const sent = await sentMessageCommand(page, FEEDBACK);

  expect(sent.channelId).toBe(CHANNEL_ID);
  // The native command interprets a null kind as the channel-message default,
  // kind 9. Thread replies intentionally use this acknowledged REST boundary.
  expect(sent.kind).toBeNull();
  expect(sent.mentionPubkeys).toEqual([AGENT_PUBKEY]);
  expect(sent.parentEventId).toBe(ROOT_A);
  expect(sent.rootEventId).toBe(ROOT_A);
  expect(sent.content).toContain(
    "Feedback on the selected part of your response:\n\n> const routed = threadId;",
  );
  expect(sent.content).toContain(`Source: \`${ASSISTANT_SOURCE_ID}\``);
  expect(sent.content).toMatch(/at revision `fnv1a64:[0-9a-f]{16}`/);
  expect(sent.content).toContain(
    `code block \`${ASSISTANT_SOURCE_ID}:code:1\` lines 2-2`,
  );
  expect(sent.content.endsWith(FEEDBACK)).toBe(true);
  await expect(thread.getByText(FEEDBACK, { exact: true })).toBeVisible();

  const publishedReply = thread.locator(
    `[data-message-id="${PUBLISHED_AGENT_REPLY}"]`,
  );
  await expect(publishedReply).toContainText("Published agent conclusion.");
  const publishedSource = publishedReply.locator(
    `[data-annotation-source-id="${PUBLISHED_AGENT_REPLY}"]`,
  );
  await selectRenderedText(
    page,
    publishedSource.getByText("Published agent conclusion.", { exact: true }),
  );
  await publishedSource
    .getByRole("button", { name: "Comment on selected text" })
    .click();
  const publishedFeedback = "Clarify the published conclusion.";
  await page.getByRole("textbox", { name: "Feedback" }).fill(publishedFeedback);
  await page.getByRole("button", { name: "Send feedback" }).click();
  const publishedSent = await sentMessageCommand(page, publishedFeedback);
  expect(publishedSent.channelId).toBe(CHANNEL_ID);
  expect(publishedSent.kind).toBeNull();
  expect(publishedSent.mentionPubkeys).toEqual([AGENT_PUBKEY]);
  expect(publishedSent.parentEventId).toBe(PUBLISHED_AGENT_REPLY);
  expect(publishedSent.rootEventId).toBe(ROOT_A);
  expect(publishedSent.content).toContain(
    "Feedback on the selected part of your response:\n\n> Published agent conclusion.",
  );
  expect(publishedSent.content).toContain(
    `Source: \`${PUBLISHED_AGENT_REPLY}\` at revision \`fnv1a64:`,
  );
  expect(publishedSent.content).not.toContain("code block");
  await expect(
    thread.getByText(publishedFeedback, { exact: true }),
  ).toBeVisible();
});
