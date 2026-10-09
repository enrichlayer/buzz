import assert from "node:assert/strict";
import test from "node:test";

import {
  canStopAgentThreadSession,
  selectThreadAgentCandidates,
  selectThreadSessionTranscript,
  shouldOfferOlderThreadSessionActivity,
} from "./agentThreadSession.ts";

const AGENT_A = "a".repeat(64);
const AGENT_B = "b".repeat(64);
const HUMAN = "c".repeat(64);

function message(id, overrides = {}) {
  return {
    id,
    createdAt: 1,
    author: "Human",
    body: "hello",
    depth: 0,
    time: "now",
    pubkey: HUMAN,
    tags: [],
    ...overrides,
  };
}

function transcriptMessage(id, overrides = {}) {
  return {
    id,
    type: "message",
    renderClass: "message",
    role: "user",
    title: "User",
    text: "hello",
    timestamp: "2026-10-07T00:00:00.000Z",
    channelId: "channel-a",
    sessionId: "shared-session",
    turnId: "turn-a",
    ...overrides,
  };
}

function tool(id, overrides = {}) {
  return {
    id,
    type: "tool",
    renderClass: "shell",
    descriptor: {
      renderClass: "shell",
      label: "Ran command",
      preview: "pnpm test",
    },
    title: "shell",
    toolName: "shell",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "ok",
    isError: false,
    timestamp: "2026-10-07T00:00:01.000Z",
    startedAt: "2026-10-07T00:00:00.000Z",
    completedAt: "2026-10-07T00:00:01.000Z",
    channelId: "channel-a",
    sessionId: "shared-session",
    turnId: "turn-a",
    ...overrides,
  };
}

test("agent candidates are limited to known agents that authored or were addressed in the thread", () => {
  const agents = [
    { pubkey: AGENT_A, name: "A" },
    { pubkey: AGENT_B, name: "B" },
  ];

  assert.deepEqual(
    selectThreadAgentCandidates(
      [message("head", { tags: [["p", AGENT_A]] })],
      agents,
    ),
    [agents[0]],
  );
  assert.deepEqual(
    selectThreadAgentCandidates(
      [
        message("head"),
        message("reply", {
          pubkey: AGENT_B,
          role: "bot",
          isAgent: true,
        }),
      ],
      agents,
    ),
    [agents[1]],
  );
  assert.deepEqual(
    selectThreadAgentCandidates(
      [message("human", { tags: [["p", HUMAN]] })],
      agents,
    ),
    [],
  );
});

test("thread transcript binds by exact prompt turn and does not widen to another thread in the same session", () => {
  const selected = selectThreadSessionTranscript(
    [
      transcriptMessage("prompt-a", { messageId: "head-a", turnId: "turn-a" }),
      tool("tool-a", { turnId: "turn-a" }),
      transcriptMessage("prompt-b", { messageId: "head-b", turnId: "turn-b" }),
      tool("tool-b", { turnId: "turn-b" }),
      tool("session-only", { turnId: null }),
      tool("other-channel", { channelId: "channel-b", turnId: "turn-a" }),
    ],
    [message("head-a")],
    "channel-a",
  );

  assert.deepEqual([...selected.turnIds], ["turn-a"]);
  assert.deepEqual(
    selected.items.map((item) => item.id),
    ["tool-a"],
  );
});

test("a channel-policy turn batching another thread is rejected fail closed", () => {
  const selected = selectThreadSessionTranscript(
    [
      transcriptMessage("prompt-a", {
        messageId: "head-a",
        turnId: "batched-turn",
      }),
      transcriptMessage("prompt-b", {
        messageId: "head-b",
        turnId: "batched-turn",
      }),
      tool("mixed-tool", { turnId: "batched-turn" }),
    ],
    [message("head-a")],
    "channel-a",
  );

  assert.deepEqual([...selected.turnIds], []);
  assert.deepEqual(selected.items, []);
});

test("published prompts and successful sent-message tools are deduplicated from activity", () => {
  const sendTool = tool("send-reply", {
    renderClass: "message",
    descriptor: {
      renderClass: "message",
      label: "Sent message",
      preview: "answer",
    },
    args: { channel_id: "channel-a" },
    result: JSON.stringify({ accepted: true, event_id: "reply-a" }),
  });
  const selected = selectThreadSessionTranscript(
    [
      transcriptMessage("prompt-a", { messageId: "head-a" }),
      tool("read-a", { renderClass: "file-read" }),
      sendTool,
    ],
    [message("head-a"), message("reply-a", { depth: 1 })],
    "channel-a",
  );

  assert.deepEqual(
    selected.items.map((item) => item.id),
    ["read-a"],
  );
});

test("thread stop is available only for interruptible thread-policy agents outside DMs", () => {
  assert.equal(
    canStopAgentThreadSession({
      canInterruptTurn: true,
      isDirectMessage: false,
      sessionPolicy: "thread",
    }),
    true,
  );
  for (const input of [
    {
      canInterruptTurn: true,
      isDirectMessage: false,
      sessionPolicy: "channel",
    },
    {
      canInterruptTurn: true,
      isDirectMessage: false,
      sessionPolicy: undefined,
    },
    {
      canInterruptTurn: true,
      isDirectMessage: true,
      sessionPolicy: "thread",
    },
    {
      canInterruptTurn: false,
      isDirectMessage: false,
      sessionPolicy: "thread",
    },
  ]) {
    assert.equal(canStopAgentThreadSession(input), false);
  }
});

test("older activity recovery stays visible while a published prompt anchor may remain in the archive", () => {
  assert.equal(
    shouldOfferOlderThreadSessionActivity({
      hasBoundTurn: false,
      hasOlderArchived: true,
      publishedMessageCount: 1,
    }),
    true,
  );
  assert.equal(
    shouldOfferOlderThreadSessionActivity({
      hasBoundTurn: true,
      hasOlderArchived: true,
      publishedMessageCount: 1,
    }),
    false,
  );
  assert.equal(
    shouldOfferOlderThreadSessionActivity({
      hasBoundTurn: false,
      hasOlderArchived: false,
      publishedMessageCount: 1,
    }),
    false,
  );

  const recovered = selectThreadSessionTranscript(
    [
      transcriptMessage("old-prompt", {
        messageId: "head-a",
        turnId: "long-turn",
      }),
      ...Array.from({ length: 3_001 }, (_, index) =>
        tool(`long-tool-${index}`, { turnId: "long-turn" }),
      ),
    ],
    [message("head-a")],
    "channel-a",
  );
  assert.deepEqual([...recovered.turnIds], ["long-turn"]);
  assert.equal(recovered.items.length, 3_001);
});

test("receipt projection retains exact successful send evidence and never includes a foreign turn", () => {
  const send = tool("send", {
    renderClass: "message",
    descriptor: { renderClass: "message" },
    result: JSON.stringify({ accepted: true, event_id: "reply" }),
  });
  const selected = selectThreadSessionTranscript(
    [
      transcriptMessage("prompt", { messageId: "head" }),
      send,
      tool("foreign", { turnId: "foreign" }),
    ],
    [message("head"), message("reply")],
    "channel-a",
    true,
  );
  assert.deepEqual(
    selected.items.map((item) => item.id),
    ["send"],
  );
});
