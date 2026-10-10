import { expect, test, type Page } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const SHOTS = "test-results/question-card";
const AGENT = TEST_IDENTITIES.alice.pubkey;
const ARTIFACT_D = "04737c81-e5e8-4412-bb47-f446813cfeba";

const PROMPT = {
  version: 1,
  kind: "question",
  state: "open",
  questions: [
    {
      id: "question_0",
      header: "Auth method",
      question: "Which auth method should the endpoint use?",
      multiSelect: false,
      allowOther: true,
      options: [
        { label: "API key (Recommended)", description: "Matches v2" },
        {
          label: "OAuth",
          description: "Third-party apps",
          preview: "GET /v3/people\nAuthorization: Bearer <token>",
        },
      ],
    },
    {
      id: "question_1",
      header: "Clients",
      question: "Which clients need access?",
      multiSelect: true,
      allowOther: true,
      options: [
        { label: "Web", description: "The browser app" },
        { label: "CLI" },
        { label: "Mobile" },
      ],
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await installMockBridge(page);
});

/** Post an agent message with a prompt artifact anchored to it. */
async function postPrompt(
  page: Page,
  content: string = JSON.stringify(PROMPT),
) {
  await page.goto("/");
  await page.getByTestId("channel-general").click();
  await expect(page.getByTestId("chat-title")).toHaveText("general");
  await page.waitForFunction(
    () => typeof window.__BUZZ_E2E_EMIT_MOCK_ARTIFACT__ === "function",
  );
  return page.evaluate(
    ({ agent, content, d }) => {
      const root = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "I need one decision before I continue.",
        pubkey: agent,
      });
      if (!root) throw new Error("mock message bridge missing");
      const artifact = window.__BUZZ_E2E_EMIT_MOCK_ARTIFACT__?.({
        channelName: "general",
        content,
        pubkey: agent,
        tags: [
          ["ar", "1"],
          ["d", d],
          ["type", "buzz.agent_prompt"],
          ["title", "Which auth method should the endpoint use?"],
          ["op", "create"],
          ["root", root.id],
        ],
      });
      if (!artifact) throw new Error("mock artifact bridge missing");
      return { root, artifact };
    },
    { agent: AGENT, content, d: ARTIFACT_D },
  );
}

function promptRow(page: Page) {
  return page
    .getByTestId("message-row")
    .filter({ hasText: "I need one decision before I continue." });
}

test("an agent prompt renders under its message and submits by keyboard", async ({
  page,
}) => {
  const { artifact } = await postPrompt(page);
  const card = promptRow(page).getByTestId("agent-prompt-card");
  await expect(card).toHaveAttribute("data-state", "open");
  await expect(card.getByTestId("agent-prompt-tab")).toHaveText([
    "Auth method",
    "Clients",
  ]);
  await expect(card.getByRole("radio")).toHaveCount(3);
  await expect(card.getByTestId("agent-prompt-submit")).toBeDisabled();

  const oauth = card.getByRole("radio", { name: /OAuth/ });
  await oauth.hover();
  await expect(card.getByTestId("agent-prompt-preview")).toContainText(
    "Authorization: Bearer <token>",
  );
  await card.screenshot({ path: `${SHOTS}/01-open.png` });

  // "2" picks OAuth and, being single-select, moves on to the next question.
  await card.getByRole("radio", { name: /API key/ }).focus();
  await page.keyboard.press("ArrowDown");
  await expect(oauth).toBeFocused();
  await page.keyboard.press("2");
  await expect(card.getByRole("tab", { name: /Clients/ })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.keyboard.press("1");
  await page.keyboard.press("3");
  // Plain Enter on an option toggles it, like a click, instead of submitting.
  const cli = card.getByRole("checkbox", { name: /CLI/ });
  await cli.focus();
  await page.keyboard.press("Enter");
  await expect(cli).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("Enter");
  await expect(cli).toHaveAttribute("aria-checked", "false");
  await expect(card.getByRole("checkbox", { name: /Web/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  await page.keyboard.press("4");
  await expect(card.getByTestId("agent-prompt-other-input")).toBeFocused();
  // Digits typed in the Other field are text, not option shortcuts.
  await page.keyboard.type("Desktop 2");
  await expect(cli).toHaveAttribute("aria-checked", "false");
  // Shift+Tab returns to the first question with its answer intact.
  await page.keyboard.press("Shift+Tab");
  await expect(oauth).toHaveAttribute("aria-checked", "true");
  await page.keyboard.press("ControlOrMeta+Enter");

  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card.getByTestId("agent-prompt-answered-by")).toHaveText(
    "Answered by You",
  );
  // The submitter's focus moves to the announced result.
  await expect(card.getByTestId("agent-prompt-answered-by")).toBeFocused();
  for (const choice of ["OAuth", "Web", "Mobile", "Other: Desktop 2"]) {
    await expect(card.getByText(choice, { exact: true })).toBeVisible();
  }

  const published = await page.evaluate(() =>
    window.__BUZZ_E2E_SIGNED_EVENTS__?.filter((event) => event.kind === 45010),
  );
  expect(published).toHaveLength(1);
  const [answer] = published ?? [];
  expect(answer.tags).toContainEqual(["op", "update"]);
  expect(answer.tags).toContainEqual(["prev", artifact.id]);
  expect(answer.tags).toContainEqual(["d", ARTIFACT_D]);
  expect(JSON.parse(answer.content)).toMatchObject({
    state: "answered",
    answer: {
      question_0: ["OAuth"],
      question_1: ["Web", "Mobile", "Desktop 2"],
    },
  });
  await card.screenshot({ path: `${SHOTS}/02-answered.png` });
});

test("a losing answer shows the answer that won", async ({ page }) => {
  const { artifact, root } = await postPrompt(page);
  const card = promptRow(page).getByTestId("agent-prompt-card");
  await card.getByRole("radio", { name: /OAuth/ }).click();
  await card.getByRole("checkbox", { name: /Web/ }).click();

  // Another viewer answers first; this client has not seen it yet.
  await page.evaluate(
    ({ agent, d, prev, root, content }) => {
      window.__BUZZ_E2E_EMIT_MOCK_ARTIFACT__?.({
        channelName: "general",
        content,
        live: false,
        pubkey: agent,
        tags: [
          ["ar", "1"],
          ["d", d],
          ["type", "buzz.agent_prompt"],
          ["title", "Which auth method should the endpoint use?"],
          ["op", "update"],
          ["prev", prev],
          ["root", root],
        ],
      });
    },
    {
      agent: AGENT,
      d: ARTIFACT_D,
      prev: artifact.id,
      root: root.id,
      content: JSON.stringify({
        ...PROMPT,
        state: "answered",
        answer: {
          question_0: ["API key (Recommended)"],
          question_1: ["CLI"],
        },
        answeredBy: AGENT,
      }),
    },
  );
  await card.getByTestId("agent-prompt-submit").click();

  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card.getByTestId("agent-prompt-answered-by")).toHaveText(
    /^Already answered by (?!You)/,
  );
  await expect(card.getByText("Your answer was not sent.")).toBeVisible();
  await expect(
    card.getByText("API key (Recommended)", { exact: true }),
  ).toBeVisible();
  await expect(card.getByText("CLI", { exact: true })).toBeVisible();
  await card.screenshot({ path: `${SHOTS}/03-conflict.png` });
});

test("a live answer from someone else closes the card for this viewer", async ({
  page,
}) => {
  const { artifact, root } = await postPrompt(page);
  const card = promptRow(page).getByTestId("agent-prompt-card");
  await expect(card).toHaveAttribute("data-state", "open");
  await page.evaluate(
    ({ agent, d, prev, root, content }) => {
      window.__BUZZ_E2E_EMIT_MOCK_ARTIFACT__?.({
        channelName: "general",
        content,
        pubkey: agent,
        tags: [
          ["ar", "1"],
          ["d", d],
          ["type", "buzz.agent_prompt"],
          ["title", "Which auth method should the endpoint use?"],
          ["op", "update"],
          ["prev", prev],
          ["root", root],
        ],
      });
    },
    {
      agent: AGENT,
      d: ARTIFACT_D,
      prev: artifact.id,
      root: root.id,
      content: JSON.stringify({
        ...PROMPT,
        state: "answered",
        answer: { question_0: ["OAuth"], question_1: ["Web"] },
        answeredBy: AGENT,
      }),
    },
  );
  await expect(card).toHaveAttribute("data-state", "answered");
  await expect(card.getByTestId("agent-prompt-answered-by")).toHaveText(
    /^Answered by (?!You)/,
  );
});

test("malformed prompt content falls back to the title", async ({ page }) => {
  await postPrompt(page, JSON.stringify({ version: 1, kind: "question" }));
  const card = promptRow(page).getByTestId("agent-prompt-card");
  await expect(card).toHaveAttribute("data-state", "fallback");
  await expect(card).toContainText(
    "Which auth method should the endpoint use?",
  );
  await expect(card.getByRole("radio")).toHaveCount(0);
});

test("a withdrawn prompt shows as cancelled without a form", async ({
  page,
}) => {
  await postPrompt(page, JSON.stringify({ ...PROMPT, state: "cancelled" }));
  const card = promptRow(page).getByTestId("agent-prompt-card");
  await expect(card).toHaveAttribute("data-state", "cancelled");
  await expect(card.getByTestId("agent-prompt-cancelled")).toHaveText(
    "Question cancelled",
  );
  await expect(card.getByRole("radio")).toHaveCount(0);
  await expect(card.getByTestId("agent-prompt-submit")).toHaveCount(0);
});

function permissionPrompt(owner = "deadbeef".repeat(8)) {
  return JSON.stringify({
    version: 1,
    kind: "question",
    state: "open",
    permission: {
      version: 1,
      ownerPubkey: owner,
      agentPubkey: AGENT,
      cwd: "/tmp/buzz-permission-test",
      command: "pwd",
      toolCall: {
        title: "Inspect the working directory",
        rawInput: { command: "pwd" },
      },
    },
    questions: [
      {
        id: "permission",
        header: "Permission",
        question: "Allow this agent action?",
        multiSelect: false,
        allowOther: false,
        options: [{ label: "Allow once" }, { label: "Deny" }],
      },
    ],
  });
}

for (const decision of ["Allow once", "Deny"]) {
  test(`permission card sends owner decision: ${decision}`, async ({
    page,
  }) => {
    await postPrompt(page, permissionPrompt());
    const card = page.getByTestId("permission-card");
    await expect(card.getByTestId("permission-command")).toHaveText("pwd");
    await expect(card).toContainText("/tmp/buzz-permission-test");
    await card.getByRole("button", { name: decision, exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(card).toHaveAttribute("data-state", "answered");
    await expect(card).toContainText(
      decision === "Deny" ? "Denial sent" : "Approval sent",
    );
    await expect(card).toContainText("Tool completion will appear separately");
  });
}

test("permission card is read-only for other channel members", async ({
  page,
}) => {
  await postPrompt(page, permissionPrompt(TEST_IDENTITIES.bob.pubkey));
  const card = page.getByTestId("permission-card");
  await expect(
    card.getByRole("button", { name: "Allow once", exact: true }),
  ).toBeDisabled();
  await expect(
    card.getByRole("button", { name: "Deny", exact: true }),
  ).toBeDisabled();
  await card.getByText("Handle this in a terminal", { exact: true }).click();
  await expect(
    card.getByRole("button", { name: "Open local terminal" }),
  ).toBeDisabled();
  await expect(card).toContainText("Waiting for the agent’s owner");
});

test("manual handoff attributes the actual command and rejects oversized output", async ({
  page,
}) => {
  await postPrompt(page, permissionPrompt());
  const card = page.getByTestId("permission-card");
  await card.getByRole("button", { name: "Deny", exact: true }).click();
  await expect(card).toContainText("Denial sent");
  await card.getByText("Handle this in a terminal", { exact: true }).click();
  const share = card.getByRole("button", { name: "Share result with agent" });
  await card
    .getByLabel("Manual command executed")
    .fill("printf 'manual proof'");
  await card.getByLabel("Manual command exit status").fill("256");
  await expect(share).toBeDisabled();
  await card.getByLabel("Manual command exit status").fill("0");
  await card.getByLabel("Manual command output").fill("🙂".repeat(4100));
  await expect(share).toBeDisabled();
  await card.getByLabel("Manual command output").fill("manual proof");
  await share.click();
  await expect(
    card.getByRole("button", { name: "Result shared" }),
  ).toBeVisible();
  await page.getByRole("button", { name: /View thread with 1 reply/ }).click();
  await expect(
    page.getByText(
      "I changed the command from the original permission request.",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByText("Human-reported terminal result · exit 0", { exact: false }),
  ).toBeVisible();
});
