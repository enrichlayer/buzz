import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

for (const theme of ["buzz", "buzz-dark"]) {
  test(`code blocks highlight in ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 1440 });
    await page.addInitScript((themeName) => {
      localStorage.setItem("buzz-theme", themeName);
      localStorage.setItem("buzz-follow-system", "false");
    }, theme);
    await installMockBridge(page);
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.waitForFunction(() =>
      window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
        channelName: "general",
      }),
    );
    const fixtures = [
      ["js", 'const greeting = "Hello, Buzz";'],
      ["TypeScript", 'const greeting: string = "Hello, Buzz";'],
      ["", '{"greeting": "Hello, Buzz", "count": 42}'],
      ["", 'def greet(name):\n    return "Hello, " + name'],
      [
        "typescript",
        Array.from({ length: 160 }, (_, i) => `const value${i} = ${i};`).join(
          "\n",
        ),
      ],
      ["text", 'const greeting = "Keep this plain";'],
      ["unknown-language", "Unrecognized content stays readable."],
    ];
    const root = await page.evaluate((fixtures) => {
      return window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content:
          "Syntax highlighting fixture\n\n" +
          fixtures
            .map(([language, code]) => `\`\`\`${language}\n${code}\n\`\`\``)
            .join("\n\n"),
      })?.id;
    }, fixtures);
    const message = page
      .getByTestId("message-timeline")
      .locator(`[data-message-id="${root}"]`);
    const blocks = message.locator("[data-code-block] code");
    await expect(blocks).toHaveCount(fixtures.length);
    for (let i = 0; i < 5; i++) {
      await expect
        .poll(() => blocks.nth(i).locator("span[style]").count())
        .toBeGreaterThan(0);
      const colors = await blocks
        .nth(i)
        .locator("span[style]")
        .evaluateAll((tokens) => [
          ...new Set(tokens.map((token) => getComputedStyle(token).color)),
        ]);
      expect(colors.length).toBeGreaterThan(1);
      expect(
        await blocks.nth(i).locator("[data-line]").allTextContents(),
      ).toEqual(fixtures[i][1].split("\n"));
    }
    for (const i of [5, 6]) {
      await expect(blocks.nth(i)).toHaveText(fixtures[i][1]);
      await expect(blocks.nth(i).locator("span[style]")).toHaveCount(0);
    }
    await page.evaluate(() => {
      Object.defineProperty(navigator.clipboard, "write", {
        configurable: true,
        value: async (items: ClipboardItem[]) => {
          document.documentElement.dataset.copiedCode = await (
            await items[0].getType("text/plain")
          ).text();
        },
      });
    });
    const typedBlock = message.locator("[data-code-block]").nth(1);
    await typedBlock.hover();
    await typedBlock.getByRole("button", { name: "Copy code block" }).click();
    await expect(page.locator("html")).toHaveAttribute(
      "data-copied-code",
      fixtures[1][1],
    );
    await waitForAnimations(page);
    await message
      .locator("[data-code-block]")
      .nth(1)
      .screenshot({ path: testInfo.outputPath(`${theme}.png`) });
  });
}

test("agent tool code highlights in the thread activity", async ({
  page,
}, testInfo) => {
  const agentPubkey = TEST_IDENTITIES.charlie.pubkey;
  const root = "a".repeat(64);
  const channelId = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: agentPubkey,
        name: "Charlie",
        status: "running",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.waitForFunction(() =>
    window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "general",
    }),
  );
  await page.evaluate(
    ({ agentPubkey, root, channelId }) => {
      const updates = [
        {
          sessionUpdate: "user_message_chunk",
          messageId: root,
          content: { type: "text", text: "Inspect syntax highlighting" },
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "highlight-shell",
          title: "Run shell",
          kind: "execute",
          status: "completed",
          rawInput: { command: 'echo "$HOME"' },
          rawOutput: '{"ok": true}',
        },
        {
          sessionUpdate: "tool_call",
          toolCallId: "highlight-read",
          title: "Read source",
          kind: "read",
          status: "completed",
          rawInput: { path: "src/example.ts" },
          rawOutput: 'const greeting: string = "Hello, Buzz";',
        },
      ];
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        id: root,
        content: "Inspect syntax highlighting",
        mentionPubkeys: [agentPubkey],
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        id: "b".repeat(64),
        parentEventId: root,
        pubkey: agentPubkey,
        content: "Code inspection complete.",
      });
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey,
        events: updates.map((update, index) => ({
          seq: index + 1,
          timestamp: new Date(1780000000000 + index * 1000).toISOString(),
          kind: "acp_read",
          agentIndex: 0,
          channelId,
          sessionId: "highlight-session",
          turnId: "highlight-turn",
          payload: {
            method: "session/update",
            params: { sessionId: "highlight-session", update },
          },
        })),
      });
    },
    { agentPubkey, root, channelId },
  );
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${root}"]`,
    )
    .click();
  const thread = page.getByTestId("message-thread-panel");
  await thread.locator("summary").filter({ hasText: 'echo "$HOME"' }).click();
  const shell = thread.getByTestId("transcript-shell-command");
  await expect(shell).toBeVisible();
  await expect
    .poll(() => shell.locator("span[style]").count())
    .toBeGreaterThan(1);
  await thread.locator("summary").filter({ hasText: "src/example.ts" }).click();
  const file = thread
    .locator("pre")
    .filter({ hasText: 'const greeting: string = "Hello, Buzz";' });
  await expect(file).toBeVisible();
  await expect
    .poll(() => file.locator("span[style]").count())
    .toBeGreaterThan(1);
  await waitForAnimations(page);
  await file.screenshot({ path: testInfo.outputPath("agent-file-code.png") });
});
