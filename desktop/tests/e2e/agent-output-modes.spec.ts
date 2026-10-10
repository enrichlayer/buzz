import { waitForAnimations } from "../helpers/animations";
import { expect, test, type Page } from "@playwright/test";
import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

test.setTimeout(60_000);

const CHANNEL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const AGENT = TEST_IDENTITIES.charlie.pubkey;
const ROOT = "4".repeat(64);
const SESSION = "output-mode-session";
const TURN = "output-mode-turn";

async function openSession(page: Page, outputMode?: "full" | "summary") {
  await installMockBridge(page, {
    managedAgents: [
      {
        pubkey: AGENT,
        name: "Charlie",
        status: "running",
        channelNames: ["general"],
        outputMode,
      },
    ],
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function" &&
      typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function",
  );
  await page.evaluate(
    ({ channel, agent, root, session, turn }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        id: root,
        content: "Inspect the endpoint",
        mentionPubkeys: [agent],
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        id: "5".repeat(64),
        parentEventId: root,
        pubkey: agent,
        content: "The endpoint needs your decision.",
      });
      const event = (seq: number, payload: unknown) => ({
        seq,
        timestamp: new Date(1_780_000_000_000 + seq * 1_000).toISOString(),
        kind: "acp_read",
        agentIndex: 0,
        channelId: channel,
        sessionId: session,
        turnId: turn,
        payload,
      });
      const update = (seq: number, value: unknown) =>
        event(seq, {
          method: "session/update",
          params: { sessionId: session, update: value },
        });
      const updateForSession = (
        seq: number,
        eventSessionId: string,
        value: unknown,
      ) => ({
        ...event(seq, {
          method: "session/update",
          params: { sessionId: eventSessionId, update: value },
        }),
        sessionId: eventSessionId,
      });
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: agent,
        events: [
          update(1, {
            sessionUpdate: "user_message_chunk",
            messageId: root,
            content: { type: "text", text: "Inspect the endpoint" },
          }),
          update(2, {
            sessionUpdate: "agent_message_chunk",
            messageId: "reply",
            content: {
              type: "text",
              text: "Auth is undecided.\n\n```ts\nconst auth = null;\n```",
            },
          }),
          update(3, {
            sessionUpdate: "tool_call",
            toolCallId: "read-endpoint",
            title: "Inspect endpoint source",
            kind: "read",
            status: "completed",
            rawInput: { path: "src/endpoint.ts" },
            rawOutput: "endpoint source",
          }),
          update(4, {
            sessionUpdate: "tool_call",
            toolCallId: "failed-check",
            title: "Endpoint validation failed",
            kind: "execute",
            status: "failed",
            rawInput: { command: "pnpm test" },
            rawOutput: "Missing auth configuration",
          }),
          event(5, {
            jsonrpc: "2.0",
            id: 42,
            method: "session/request_permission",
            params: {
              title: "Confirm endpoint access",
              options: [
                { optionId: "allow", kind: "allow_once", name: "Allow once" },
                { optionId: "deny", kind: "reject_once", name: "Deny" },
              ],
            },
          }),
          updateForSession(6, `${session}-archived`, {
            sessionUpdate: "available_commands_update",
            availableCommands: Array.from({ length: 97 }, (_, index) => ({
              name: `command-${index}`,
            })),
          }),
          updateForSession(7, `${session}-live`, {
            sessionUpdate: "current_mode_update",
            currentModeId: "bypassPermissions",
          }),
        ],
      });
    },
    {
      channel: CHANNEL,
      agent: AGENT,
      root: ROOT,
      session: SESSION,
      turn: TURN,
    },
  );
  await page.getByTestId("channel-general").click();
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${ROOT}"]`,
    )
    .click();
  const activity = page.getByTestId("agent-thread-session-activity");
  await expect(activity).toBeVisible();
  return page.getByTestId("message-thread-panel");
}

test("conversation preserves replies, failures and permissions; full transcript reveals captured activity", async ({
  page,
}) => {
  const activity = await openSession(page, "summary");
  await expect(activity).toContainText("Auth is undecided.");
  await expect(activity.locator('[data-code-line="1"]')).toHaveText(
    "const auth = null;",
  );
  await expect(activity).toContainText("Missing auth configuration");
  await expect(activity).toContainText("Confirm endpoint access");
  await expect(activity).not.toContainText("src/endpoint.ts");
  await expect(activity).not.toContainText("Commands available: 97");
  await expect(activity).not.toContainText("bypassPermissions");
  await activity
    .getByRole("button", { name: "Full transcript", exact: true })
    .click();
  await expect(activity).toContainText("src/endpoint.ts");
  await expect(activity).toContainText("Commands available: 97");
  await expect(activity).toContainText("bypassPermissions");
  await expect(activity).toContainText("Missing auth configuration");
  await activity
    .getByRole("button", { name: "Conversation", exact: true })
    .click();
  await expect(activity).not.toContainText("src/endpoint.ts");
  await expect(activity).not.toContainText("Commands available: 97");
  await expect(activity).not.toContainText("bypassPermissions");
  await expect(activity).toContainText("Confirm endpoint access");
  const policyWrites = await page.evaluate(() =>
    (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter((entry) =>
      ["update_persona", "update_managed_agent"].includes(entry.command),
    ),
  );
  expect(policyWrites).toEqual([]);
});

test("legacy agents show decorated activity with local transcript controls", async ({
  page,
}) => {
  const activity = await openSession(page);
  await expect(activity).toContainText("src/endpoint.ts");
  await expect(activity.locator('[data-code-line="1"]')).toHaveText(
    "const auth = null;",
  );
  await expect(
    activity.getByRole("button", { name: "Activity", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(activity).toContainText("Command failed");
  const body = await activity.getByTestId("message-thread-body").boundingBox();
  const dock = await activity
    .getByTestId("thread-composer-overlay")
    .boundingBox();
  if (!body || !dock)
    throw new Error("Coding transcript or composer has no bounds");
  expect(body.y + body.height).toBeLessThanOrEqual(dock.y + 1);
});

test("publication receipts retain raw evidence and selection previews expand exactly", async ({
  page,
}) => {
  const panel = await openSession(page);
  const selected =
    "First line\nSecond line\nThird line\nFourth line\nFifth line ending mid-wor";
  await page.evaluate(
    ({ agent, channel, root, session, turn, selected }) => {
      const event = (seq: number, update: unknown) => ({
        seq: 100 + seq,
        timestamp: new Date(1_780_000_000_000 + seq * 1000).toISOString(),
        kind: "acp_read",
        agentIndex: 0,
        channelId: channel,
        sessionId: session,
        turnId: turn,
        payload: {
          method: "session/update",
          params: { sessionId: session, update },
        },
      });
      window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
        agentPubkey: agent,
        events: [
          event(1, {
            sessionUpdate: "user_message_chunk",
            messageId: root,
            content: { type: "text", text: "Inspect the endpoint" },
          }),
          event(2, {
            sessionUpdate: "tool_call",
            toolCallId: "publish-proof",
            title: "Bash",
            kind: "execute",
            status: "completed",
            rawInput: {
              command: `cat <<'EOF' | buzz messages send --channel ${channel} --content -\nReply\nEOF`,
            },
            rawOutput: JSON.stringify({
              accepted: true,
              event_id: "5".repeat(64),
            }),
          }),
          event(3, {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Warning: Desktop support remains pending.",
            },
          }),
        ],
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        id: "6".repeat(64),
        parentEventId: root,
        content: `Response · selected text\n\n${selected
          .split("\n")
          .map((line) => `> ${line}`)
          .join(
            "\n",
          )}\n\nKeep the exact selection.\n\n\`\`\`buzz-annotation\n${JSON.stringify({ sourceId: "source", sourceRevision: "rev", selectedText: selected })}\n\`\`\``,
      });
    },
    {
      agent: AGENT,
      channel: CHANNEL,
      root: ROOT,
      session: SESSION,
      turn: TURN,
      selected,
    },
  );
  const receipt = panel.getByTestId("publication-receipt");
  await expect(receipt).toBeVisible();
  await receipt.locator("summary").press("Enter");
  await expect(receipt).toContainText('"accepted": true');
  await expect(receipt).toContainText("buzz messages send");
  await expect(panel).toContainText(
    "Warning: Desktop support remains pending.",
  );
  const feedback = panel.getByTestId("selection-feedback");
  await expect(feedback).toBeVisible();
  const quote = feedback.locator("blockquote");
  expect(
    await quote.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeLessThanOrEqual(73);
  await feedback
    .getByRole("button", { name: "Show full selection" })
    .press("Enter");
  await expect(quote).toHaveText(selected);
  expect(
    await quote.evaluate((el) => el.getBoundingClientRect().height),
  ).toBeGreaterThan(73);
  await feedback.getByRole("button", { name: "Show less" }).click();
  await panel
    .getByRole("button", { name: "Full transcript", exact: true })
    .click();
  await expect(receipt).toBeVisible();
  await expect(panel).toContainText(
    "Warning: Desktop support remains pending.",
  );
});

test("persona output mode saves through the behavior group and reopens as Summary", async ({
  page,
}) => {
  const personaId = "persona-output-mode-e2e";
  await installMockBridge(page, {
    bakedBuildEnv: [
      { key: "BUZZ_AGENT_PROVIDER", value: "anthropic", masked: false },
      {
        key: "BUZZ_AGENT_MODEL",
        value: "claude-opus-4-8",
        masked: false,
      },
      {
        key: "ANTHROPIC_API_KEY",
        value: "sk-ant-output-mode-e2e",
        masked: true,
      },
    ],
    managedAgents: [
      {
        pubkey: AGENT,
        name: "Charlie",
        personaId,
        status: "stopped",
        channelNames: ["agents"],
        outputMode: "full",
      },
    ],
    personas: [
      {
        id: personaId,
        displayName: "Output Mode Persona",
        systemPrompt: "Review the requested change.",
        outputMode: "full",
      },
    ],
  });

  await page.goto("/");
  await page.getByTestId("open-agents-view").click();
  await page
    .getByRole("button", { name: "Output Mode Persona agent profile" })
    .click();
  await page.getByTestId("user-profile-edit-agent").click();

  const dialog = page.getByTestId("persona-dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  const output = dialog.getByRole("group", {
    name: "Agent output",
    exact: true,
  });
  await output.getByRole("button", { name: "Summary", exact: true }).click();
  const context = dialog.getByRole("group", {
    name: "Conversation context",
    exact: true,
  });
  await context
    .getByRole("button", { name: "Each thread", exact: true })
    .click();
  const audience = dialog.getByRole("group", {
    name: "Who can send instructions",
    exact: true,
  });
  await audience
    .getByRole("button", { name: "Selected people", exact: true })
    .click();
  await expect(dialog.getByTestId("agent-access-warning")).toBeVisible();
  await audience.getByRole("button", { name: "Anyone", exact: true }).click();
  await expect(dialog.getByTestId("agent-access-warning")).toContainText(
    "Anyone",
  );
  await audience
    .getByRole("button", { name: "Only me (default)", exact: true })
    .click();
  await expect(dialog.getByTestId("agent-access-warning")).toHaveCount(0);
  await waitForAnimations(page);
  await dialog.screenshot({
    path: "test-results/segmented-choices/agent-settings.png",
  });
  await dialog.getByTestId("persona-dialog-submit").click();
  await expect(dialog).not.toBeVisible();

  const updatePayload = await page.evaluate(() => {
    const entry = [...(window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [])]
      .reverse()
      .find((candidate) => candidate.command === "update_persona");
    return entry?.payload as
      | {
          input?: {
            behavior?: {
              outputMode?: string;
              sessionPolicy?: string;
              respondTo?: string;
            };
          };
        }
      | undefined;
  });
  expect(updatePayload?.input?.behavior?.outputMode).toBe("summary");
  expect(updatePayload?.input?.behavior?.sessionPolicy).toBe("thread");
  expect(updatePayload?.input?.behavior?.respondTo).toBe("owner-only");

  await page.getByTestId("user-profile-edit-agent").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(
    output.getByRole("button", { name: "Summary", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(
    context.getByRole("button", { name: "Each thread", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});
