import { expect, test, type Locator, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

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
  await page.getByRole("button", { name: "Comment on selected text" }).click();

  const feedback = page.getByRole("textbox", { name: "Feedback" });
  await expect(feedback).toBeVisible();
  const editor = page.getByTestId("selection-annotation-editor");
  await expect(editor).toHaveAttribute("role", "dialog");
  await expect(feedback).toBeFocused();
  await waitForAnimations(page);
  const selectedBounds = await codeLine.boundingBox();
  const editorBounds = await editor.boundingBox();
  if (!selectedBounds || !editorBounds)
    throw new Error("selection and editor need visible bounds");
  // The floating editor must touch the selected line, not the response header.
  const distance = Math.min(
    Math.abs(editorBounds.y - (selectedBounds.y + selectedBounds.height)),
    Math.abs(editorBounds.y + editorBounds.height - selectedBounds.y),
  );
  expect(distance).toBeLessThanOrEqual(12);
  await expect(
    page.locator("blockquote").filter({ hasText: "const routed = threadId;" }),
  ).toBeVisible();
  await feedback.fill(FEEDBACK);
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/floating-annotations-code.png" });
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
    "Feedback on the selected content:\n\n> const routed = threadId;",
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
  await page.getByRole("button", { name: "Comment on selected text" }).click();
  const publishedFeedback = "Clarify the published conclusion.";
  await page.getByRole("textbox", { name: "Feedback" }).fill(publishedFeedback);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/floating-annotations-prose.png",
  });
  await page.getByRole("button", { name: "Send feedback" }).click();
  const publishedSent = await sentMessageCommand(page, publishedFeedback);
  expect(publishedSent.channelId).toBe(CHANNEL_ID);
  expect(publishedSent.kind).toBeNull();
  expect(publishedSent.mentionPubkeys).toEqual([AGENT_PUBKEY]);
  expect(publishedSent.parentEventId).toBe(PUBLISHED_AGENT_REPLY);
  expect(publishedSent.rootEventId).toBe(ROOT_A);
  expect(publishedSent.content).toContain(
    "Feedback on the selected content:\n\n> Published agent conclusion.",
  );
  expect(publishedSent.content).toContain(
    `Source: \`${PUBLISHED_AGENT_REPLY}\` at revision \`fnv1a64:`,
  );
  expect(publishedSent.content).not.toContain("code block");
  await expect(
    thread.getByText(publishedFeedback, { exact: true }),
  ).toBeVisible();
});

for (const width of [1280, 780]) {
  test(`keyboard comments float and fit at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
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
    const source = thread.locator(
      `[data-annotation-source-id="${PUBLISHED_AGENT_REPLY}"]`,
    );
    const prose = source.getByText("Published agent conclusion.", {
      exact: true,
    });
    await selectRenderedText(page, prose);
    const before = await prose.boundingBox();
    await page.keyboard.press("ControlOrMeta+Shift+M");
    const editor = page.getByTestId("selection-annotation-editor");
    const feedback = page.getByRole("textbox", { name: "Feedback" });
    await expect(feedback).toBeFocused();
    await waitForAnimations(page);
    expect(await prose.boundingBox()).toEqual(before);
    await feedback.fill("Keep this selection.");

    // Keep this layout mounted while testing collision fitting. Crossing a
    // responsive pane breakpoint replaces the source, like thread navigation.
    await page.setViewportSize({ width, height: 600 });
    await expect
      .poll(async () => {
        const box = await editor.boundingBox();
        return (
          box !== null &&
          box.x >= 7 &&
          box.y >= 7 &&
          box.x + box.width <= width - 7 &&
          box.y + box.height <= 593
        );
      })
      .toBe(true);
    await expect(feedback).toHaveValue("Keep this selection.");
    await page.keyboard.press("Escape");
    await expect(editor).toHaveCount(0);
    await expect(source).toBeFocused();
    const commands = await page.evaluate(() =>
      (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter(
        (entry) => entry.command === "send_channel_message",
      ),
    );
    expect(commands).toHaveLength(0);
  });
}

test("Escape dismisses annotation feedback before its focus-mode thread", async ({
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
  await page
    .getByRole("button", { name: "Expand thread", exact: true })
    .click();
  const drawer = page.getByTestId("focus-thread-drawer");
  await expect(drawer).toBeVisible();
  await waitForAnimations(page);
  const source = thread.locator(
    `[data-annotation-source-id="${PUBLISHED_AGENT_REPLY}"]`,
  );
  await source.focus();
  await source
    .getByText("Published agent conclusion.", { exact: true })
    .evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(page.getByRole("textbox", { name: "Feedback" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("selection-annotation-editor")).toHaveCount(0);
  await expect(drawer).toBeVisible();
  await expect(source).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(drawer).toHaveCount(0);
});

test("an annotation captured in one thread cannot send after navigation", async ({
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
  const publishedReply = thread.locator(
    `[data-message-id="${PUBLISHED_AGENT_REPLY}"]`,
  );
  const publishedSource = publishedReply.locator(
    `[data-annotation-source-id="${PUBLISHED_AGENT_REPLY}"]`,
  );
  await selectRenderedText(
    page,
    publishedSource.getByText("Published agent conclusion.", { exact: true }),
  );
  await page.getByRole("button", { name: "Comment on selected text" }).click();

  const staleFeedback = "This must not cross thread boundaries.";
  const feedback = page.getByRole("textbox", { name: "Feedback" });
  await feedback.fill(staleFeedback);
  await page
    .getByTestId(`reply-message-${ROOT_B}`)
    .first()
    .evaluate((button) => (button as HTMLButtonElement).click());
  await expect(page.getByTestId("message-thread-head")).toContainText(
    "Unrelated sibling request",
  );

  // The selected source left the document with thread A. Its feedback control
  // must close rather than survive under thread B's current routing context.
  await expect(feedback).toHaveCount(0);
  const staleSends = await page.evaluate(
    (needle) =>
      (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter(
        (entry) =>
          entry.command === "send_channel_message" &&
          typeof (entry.payload as { content?: unknown }).content ===
            "string" &&
          (entry.payload as { content: string }).content.includes(needle),
      ).length,
    staleFeedback,
  );
  expect(staleSends).toBe(0);
});

test("human channel messages and tool output can both be annotated", async ({
  page,
}) => {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: AGENT_PUBKEY,
        name: "Charlie",
        status: "running",
        channelNames: ["general"],
        outputMode: "full",
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await seedThreadsAndObserver(page);
  await page.getByTestId("channel-general").click();
  const human = page
    .locator(
      `[data-message-id="${ROOT_B}"] [data-annotation-source-id="${ROOT_B}"]`,
    )
    .getByText("Unrelated sibling request", { exact: true });
  await selectRenderedText(page, human);
  await page.getByRole("button", { name: "Comment on selected text" }).click();
  await expect(page.getByTestId("annotation-destination")).toContainText(
    "#general",
  );
  await page
    .getByRole("textbox", { name: "Feedback" })
    .fill("Comment on a human message");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const humanComment = await sentMessageCommand(
    page,
    "Comment on a human message",
  );
  expect(humanComment.parentEventId).toBe(ROOT_B);
  expect(humanComment.channelId).toBe(CHANNEL_ID);
  expect(humanComment.content).toContain(`Source: \`${ROOT_B}\``);

  const toolEvent = sessionUpdate(5, TURN_A, {
    sessionUpdate: "tool_call",
    toolCallId: "annotation-command",
    title: "Check annotation coverage",
    kind: "execute",
    status: "failed",
    rawInput: { command: "pnpm test" },
    rawOutput: "Uncovered selection in the tool result",
  });
  await page.evaluate(
    ({ event, agentPubkey }) => {
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: [event],
      });
    },
    { event: toolEvent, agentPubkey: AGENT_PUBKEY },
  );
  const thread = await openThread(page, ROOT_A);
  const activity = thread.getByTestId("agent-thread-session-activity");
  const toolResult = activity
    .getByText("Uncovered selection in the tool result", { exact: true })
    .first();
  await activity.locator("summary").filter({ hasText: "pnpm test" }).click();
  await expect(toolResult).toBeVisible();
  await selectRenderedText(page, toolResult);
  await page.getByRole("button", { name: "Comment on selected text" }).click();
  await expect(page.getByTestId("annotation-destination")).toContainText(
    "Charlie",
  );
  await page
    .getByRole("textbox", { name: "Feedback" })
    .fill("Explain this tool output");
  await page.getByRole("button", { name: "Send feedback" }).click();
  const toolComment = await sentMessageCommand(
    page,
    "Explain this tool output",
  );
  expect(toolComment.parentEventId).toBe(ROOT_A);
  expect(toolComment.mentionPubkeys).toEqual([AGENT_PUBKEY]);
  expect(toolComment.content).toContain("annotation-command");
});
