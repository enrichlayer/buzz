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
  return activity;
}

test("summary preserves replies, failures and permissions; details reveal original activity", async ({
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
  await activity
    .getByRole("button", { name: "Show details", exact: true })
    .click();
  await expect(activity).toContainText("src/endpoint.ts");
  await expect(activity).toContainText("Missing auth configuration");
  await activity
    .getByRole("button", { name: "Show summary", exact: true })
    .click();
  await expect(activity).not.toContainText("src/endpoint.ts");
  await expect(activity).toContainText("Confirm endpoint access");
  const policyWrites = await page.evaluate(() =>
    (window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? []).filter((entry) =>
      ["update_persona", "update_managed_agent"].includes(entry.command),
    ),
  );
  expect(policyWrites).toEqual([]);
});

test("legacy agents retain full decorated activity", async ({ page }) => {
  const activity = await openSession(page);
  await expect(activity).toContainText("src/endpoint.ts");
  await expect(activity.locator('[data-code-line="1"]')).toHaveText(
    "const auth = null;",
  );
  await expect(
    activity.getByRole("button", { name: "Show details", exact: true }),
  ).toHaveCount(0);
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
  await dialog.locator("#persona-output-mode").click();
  await page
    .getByRole("menuitemradio", { name: "Summary", exact: true })
    .click();
  await dialog.getByTestId("persona-dialog-submit").click();
  await expect(dialog).not.toBeVisible();

  const updatePayload = await page.evaluate(() => {
    const entry = [...(window.__BUZZ_E2E_COMMAND_PAYLOADS__ ?? [])]
      .reverse()
      .find((candidate) => candidate.command === "update_persona");
    return entry?.payload as
      | { input?: { behavior?: { outputMode?: string } } }
      | undefined;
  });
  expect(updatePayload?.input?.behavior?.outputMode).toBe("summary");

  await page.getByTestId("user-profile-edit-agent").click();
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Advanced", exact: true }).click();
  await expect(dialog.locator("#persona-output-mode")).toHaveText("Summary");
});
