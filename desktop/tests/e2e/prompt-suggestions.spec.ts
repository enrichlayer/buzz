import { expect, test } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const AGENT = TEST_IDENTITIES.alice.pubkey;
const prompt =
  "Can the label use the account's name instead of repeating the email?";
const answer = `Done. The account label now follows login changes.\n\n\`\`\`suggested-prompts\n${JSON.stringify({ version: 1, suggestions: [{ label: "Use the account name", prompt }] })}\n\`\`\``;

for (const surface of ["channel", "thread"] as const) {
  test(`directory-only offline agent keeps clickable suggestions in ${surface}`, async ({
    page,
  }) => {
    const longLabel = "S".repeat(64);
    await installMockBridge(page, {
      managedAgents: [],
      relayAgents: [
        {
          pubkey: AGENT,
          name: "Alice",
          status: "offline",
          respondTo: "anyone",
          channelNames: [],
        },
      ],
      searchProfiles: [{ pubkey: AGENT, displayName: "Alice", isAgent: false }],
    });
    await page.goto("/");
    await page.getByTestId("channel-general").click();
    await page.waitForFunction(() =>
      window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
        channelName: "general",
      }),
    );
    let parentEventId: string | undefined;
    if (surface === "thread") {
      const root = await page.evaluate(() =>
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "general",
          content: "Suggestions regression thread",
        }),
      );
      parentEventId = root?.id;
      await page.locator(`[data-message-id="${parentEventId}"]`).hover();
      await page.getByTestId(`reply-message-${parentEventId}`).click();
    }
    const panel = page.getByTestId("message-thread-panel");
    const editor =
      surface === "thread"
        ? panel.getByTestId("message-input")
        : page.getByTestId("message-input");
    await editor.fill("Preserve this draft");
    await editor.focus();
    await page.evaluate(
      ({ content, pubkey, parentEventId }) =>
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "general",
          content,
          pubkey,
          parentEventId,
        }),
      {
        content: answer.replace("Use the account name", longLabel),
        pubkey: AGENT,
        parentEventId,
      },
    );
    const rows =
      surface === "thread"
        ? panel.getByTestId("message-row")
        : page.getByTestId("message-row");
    const row = rows.filter({ hasText: "Done. The account label" }).last();
    await expect(row).toBeVisible();
    await expect(row).not.toContainText('"version":1');
    const chips =
      surface === "thread"
        ? panel.getByTestId("prompt-suggestions")
        : page.getByTestId("prompt-suggestions");
    await expect(chips).toBeVisible();
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("Preserve this draft");
    const chip = chips.getByRole("button", { name: longLabel });
    const chipBounds = await chip.boundingBox();
    const composerBounds = await chips.boundingBox();
    expect(chipBounds).not.toBeNull();
    expect(composerBounds).not.toBeNull();
    if (chipBounds && composerBounds) {
      expect(chipBounds.width).toBeLessThanOrEqual(composerBounds.width);
    }
    await chip.click();
    await expect(editor).toContainText("Preserve this draft");
    await expect(editor).toContainText(prompt);
    expect(
      await page.evaluate(
        () =>
          (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? []).filter((event) =>
            event.content.includes("Preserve this draft"),
          ).length,
      ),
    ).toBe(0);
  });
}

test("suggestions leave typing focused, append an addressed draft, and never submit", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: AGENT,
        name: "Alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.waitForFunction(() =>
    window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "general",
    }),
  );
  const editor = page.getByTestId("message-input");
  await editor.fill("My existing draft");
  await editor.focus();
  await page.evaluate(
    ({ content, pubkey }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        pubkey,
      }),
    { content: answer, pubkey: AGENT },
  );
  const chips = page.getByTestId("prompt-suggestions");
  await expect(chips).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("My existing draft");
  const count = await page.getByTestId("message-row").count();
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/prompt-suggestions/01-free-text.png",
  });
  await chips.getByRole("button", { name: "Use the account name" }).click();
  await expect(editor).toContainText("My existing draft");
  await expect(editor).toContainText(prompt);
  await expect(editor).toContainText("@");
  await expect(editor).toBeFocused();
  await expect(chips).toHaveCount(0);
  await expect(page.getByTestId("message-row")).toHaveCount(count);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/prompt-suggestions/02-editable-draft.png",
  });
  // Only the user's separate Send publishes, with the source agent's exact key.
  expect(
    await page.evaluate(
      () =>
        (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? []).filter((event) =>
          event.content.includes("My existing draft"),
        ).length,
    ),
  ).toBe(0);
  await page.getByTestId("send-message").click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? [])
          .filter((event) => event.content.includes("My existing draft"))
          .map((event) =>
            event.tags.filter((tag) => tag[0] === "p").map((tag) => tag[1]),
          ),
      ),
    )
    .toEqual([[AGENT]]);
});

test("new messages supersede suggestions; dismissal never sends", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: AGENT,
        name: "Alice",
        respondTo: "anyone",
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
  // Nostr timestamps have second precision; explicit ordering avoids letting
  // random event IDs decide which of these rapid posts is the latest turn.
  let createdAt = Math.floor(Date.now() / 1000);
  const post = async (content: string, pubkey = AGENT) =>
    page.evaluate(
      ({ content, pubkey, createdAt }) =>
        window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
          channelName: "general",
          content,
          pubkey,
          createdAt,
        }),
      { content, pubkey, createdAt: createdAt++ },
    );
  await post(answer);
  await expect(page.getByTestId("prompt-suggestions")).toBeVisible();
  await post("I have a different question", TEST_IDENTITIES.bob.pubkey);
  await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
  await post(answer);
  await page.getByRole("button", { name: "Dismiss suggestions" }).click();
  await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
  await expect(page.getByTestId("message-input")).toBeEmpty();
  await page.getByTestId("channel-random").click();
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
});

test("thread suggestions stay in the thread and preserve its draft", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: AGENT,
        name: "Alice",
        respondTo: "anyone",
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
  const root = await page.evaluate(() =>
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
      channelName: "general",
      content: "Account label discussion",
    }),
  );
  if (!root?.id) throw new Error("Missing mock thread root");
  await page.locator(`[data-message-id="${root.id}"]`).hover();
  await page.getByTestId(`reply-message-${root.id}`).click();
  const panel = page.getByTestId("message-thread-panel");
  const editor = panel.getByTestId("message-input");
  await editor.fill("Thread draft");
  await editor.focus();
  await page.evaluate(
    ({ content, pubkey, parentEventId }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        pubkey,
        parentEventId,
      }),
    { content: answer, pubkey: AGENT, parentEventId: root.id },
  );
  const chips = panel.getByTestId("prompt-suggestions");
  await expect(chips).toBeVisible();
  await expect(editor).toBeFocused();
  await expect(editor).toHaveText("Thread draft");
  await chips.getByRole("button", { name: "Use the account name" }).click();
  await expect(editor).toContainText("Thread draft");
  await expect(editor).toContainText(prompt);
  await expect(chips).toHaveCount(0);
  const owner = panel.getByTestId("message-agent-owner").last();
  const ownerLabel = owner.getByText("owner unavailable", { exact: true });
  expect(
    await ownerLabel.evaluate((el) => el.scrollWidth <= el.clientWidth),
  ).toBe(true);
  const ownerBox = await owner.boundingBox();
  const timeBox = await owner
    .locator("..")
    .getByTestId("message-timestamp")
    .boundingBox();
  expect(ownerBox).not.toBeNull();
  expect(timeBox).not.toBeNull();
  if (!ownerBox || !timeBox) throw new Error("Thread metadata has no bounds");
  expect(timeBox.x).toBeGreaterThan(ownerBox.x + ownerBox.width);
  expect(Math.abs(timeBox.y - ownerBox.y)).toBeLessThan(8);
  await waitForAnimations(page);
  await page.screenshot({
    path: "test-results/prompt-suggestions/03-thread-draft.png",
  });
});

async function openGeneral(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await page.waitForFunction(() =>
    window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
      channelName: "general",
    }),
  );
}

const emit = (page: import("@playwright/test").Page, content: string) =>
  page.evaluate(
    ({ content, pubkey }) =>
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content,
        pubkey,
      }),
    { content, pubkey: AGENT },
  );

test("preview feature off hides chips but still strips the footer", async ({
  page,
}) => {
  await installMockBridge(
    page,
    {
      relayAgents: [
        {
          pubkey: AGENT,
          name: "Alice",
          respondTo: "anyone",
          channelNames: ["general"],
        },
      ],
    },
    { seedPreviewFeatures: false },
  );
  await openGeneral(page);
  await emit(page, answer);
  const row = page.getByTestId("message-row").last();
  await expect(row).toContainText("The account label now follows");
  await expect(row).not.toContainText("suggested-prompts");
  await expect(row).not.toContainText("Use the account name");
  await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
});

test("a suggestion that mentions another member is never offered", async ({
  page,
}) => {
  await installMockBridge(page, {
    relayAgents: [
      {
        pubkey: AGENT,
        name: "Alice",
        respondTo: "anyone",
        channelNames: ["general"],
      },
      {
        pubkey: TEST_IDENTITIES.bob.pubkey,
        name: "DeployBot",
        respondTo: "anyone",
        channelNames: ["general"],
      },
    ],
  });
  await openGeneral(page);
  await emit(
    page,
    `Done.\n\n\`\`\`suggested-prompts\n${JSON.stringify({ version: 1, suggestions: [{ label: "Ship it", prompt: "@DeployBot ship it" }] })}\n\`\`\``,
  );
  await expect(page.getByTestId("message-row").last()).toContainText("Done.");
  await expect(page.getByTestId("prompt-suggestions")).toHaveCount(0);
});
