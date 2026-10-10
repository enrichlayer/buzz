import { expect, test } from "@playwright/test";

import { installMockBridge, TEST_IDENTITIES } from "../helpers/bridge";

const CHANNEL_ID = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const ROOT = "4".repeat(64);
const REPLY = "5".repeat(64);
const AGENTS = [TEST_IDENTITIES.charlie.pubkey, TEST_IDENTITIES.bob.pubkey];

function sessionUpdate(agentIndex: number, turnId: string) {
  return {
    seq: 1,
    timestamp: "2026-10-07T00:00:00.000Z",
    kind: "acp_read",
    agentIndex,
    channelId: CHANNEL_ID,
    sessionId: `archive-loader-session-${agentIndex}`,
    turnId,
    payload: {
      method: "session/update",
      params: {
        sessionId: `archive-loader-session-${agentIndex}`,
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: ROOT,
          content: { type: "text", text: "Shared thread request" },
        },
      },
    },
  };
}

test("two agent cards share one thread archive loader", async ({ page }) => {
  await installMockBridge(page, {
    managedAgents: AGENTS.map((pubkey, index) => ({
      pubkey,
      name: `Agent ${index + 1}`,
      status: "running",
      channelNames: ["general"],
    })),
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () =>
      typeof window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__ === "function" &&
      typeof window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__ === "function",
  );
  const events = AGENTS.map((_, index) => [
    sessionUpdate(index, `archive-loader-turn-${index}`),
  ]);
  await page.evaluate(
    ({ agents, events, reply, root }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Shared thread request",
        id: root,
        mentionPubkeys: agents,
      });
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: "Open the shared session thread.",
        id: reply,
        parentEventId: root,
      });
      agents.forEach((agentPubkey, index) => {
        window.__BUZZ_E2E_SEED_OBSERVER_EVENTS__?.({
          agentPubkey,
          events: events[index],
        });
      });
    },
    { agents: AGENTS, events, reply: REPLY, root: ROOT },
  );

  await page.getByTestId("channel-general").click();
  const baseline = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __BUZZ_E2E_IPC_COUNTERS__?: Record<string, number>;
        }
      ).__BUZZ_E2E_IPC_COUNTERS__?.list_save_subscriptions ?? 0,
  );
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${ROOT}"]`,
    )
    .click();

  const panel = page.getByTestId("message-thread-panel");
  await expect(panel.getByTestId("agent-thread-session-activity")).toHaveCount(
    2,
  );
  await expect
    .poll(() =>
      page.evaluate(
        (before) =>
          ((
            window as typeof window & {
              __BUZZ_E2E_IPC_COUNTERS__?: Record<string, number>;
            }
          ).__BUZZ_E2E_IPC_COUNTERS__?.list_save_subscriptions ?? 0) - before,
        baseline,
      ),
    )
    .toBe(1);
});
