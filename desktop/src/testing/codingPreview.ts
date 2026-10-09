import { router } from "@/app/router";
import { formatAnnotationMessage } from "@/shared/ui/annotations/annotationModel";

const agent =
  "554cef57437abac34522ac2c9f0490d685b72c80478cf9f7ed6f9570ee8624ea";
const channel = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const root = "4".repeat(64);
const reply = "5".repeat(64);
const session = "coding-preview-session";
const turn = "coding-preview-turn";

/** Explicit, isolated fixture mode. Never connects a browser to native credentials. */
export function configureCodingPreview() {
  window.__BUZZ_E2E__ = {
    mode: "mock",
    mock: {
      managedAgents: [
        {
          pubkey: agent,
          name: "Coding Session Test",
          status: "running",
          channelNames: ["general"],
          outputMode: "full",
        },
      ],
    },
  };
}

export function loadCodingPreview() {
  const now = Math.floor(Date.now() / 1000) - 15;
  const quote =
    "I added the underscore regression test and posted the result.\nThe CLI and Web clients use OAuth.\nMobile uses the same endpoint.\nDesktop will follow after the first release.\nAll existing tests still pass.";
  window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
    channelName: "general",
    id: root,
    createdAt: now,
    content: formatAnnotationMessage(
      {
        sourceId: "preview-source",
        sourceRevision: "preview-v1",
        originalSourceText: quote,
        selectedText: quote,
      },
      "Please confirm the selected requirements and show the implementation details.",
    ),
    mentionPubkeys: [agent],
  });
  window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
    channelName: "general",
    id: reply,
    parentEventId: root,
    createdAt: now + 5,
    pubkey: agent,
    content:
      "The endpoint uses **OAuth** for Web, CLI and Mobile. Desktop support comes in the next release.\n\n```ts\nconst clients = ['web', 'cli', 'mobile'];\nconst auth = { method: 'oauth', clients };\n```\n\nThe regression test passed. No production configuration was changed.",
  });
  const event = (seq: number, update: unknown) => ({
    seq,
    timestamp: new Date((now + seq) * 1000).toISOString(),
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
        content: { type: "text", text: "Confirm the requirements" },
      }),
      event(2, {
        sessionUpdate: "agent_thought_chunk",
        content: {
          type: "text",
          text: "Check the selected requirements against the endpoint contract.",
        },
      }),
      event(3, {
        sessionUpdate: "tool_call",
        toolCallId: "test",
        title: "Run regression tests",
        kind: "execute",
        status: "completed",
        rawInput: { command: "node --test slugify.test.js" },
        rawOutput: "4 tests passed",
      }),
      event(4, {
        sessionUpdate: "tool_call",
        toolCallId: "publish",
        title: "Bash",
        kind: "execute",
        status: "completed",
        rawInput: {
          command: `cat <<'EOF' | buzz messages send --channel ${channel} --reply-to ${root} --content -\nThe endpoint uses OAuth.\nEOF`,
        },
        rawOutput: JSON.stringify({ accepted: true, event_id: reply }),
      }),
      event(6, {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "I posted the confirmed requirements in this thread.\n\nNote: Desktop support is still pending.",
        },
      }),
      {
        seq: 7,
        timestamp: new Date((now + 7) * 1000).toISOString(),
        kind: "acp_read",
        agentIndex: 0,
        channelId: channel,
        sessionId: session,
        turnId: turn,
        payload: { result: { stopReason: "end_turn" } },
      },
      {
        seq: 8,
        timestamp: new Date((now + 8) * 1000).toISOString(),
        kind: "turn_completed",
        agentIndex: 0,
        channelId: channel,
        sessionId: session,
        turnId: turn,
        payload: null,
      },
    ],
  });
  void router.navigate({
    to: "/channels/$channelId",
    params: { channelId: channel },
  });
}

/** An explicit permission fixture for reviewing the real card renderer. */
export function loadPermissionPreview() {
  const message = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
    channelName: "general",
    pubkey: agent,
    content:
      "Permission card preview: allow or deny a harmless working-directory check.",
  });
  if (!message) return;
  window.__BUZZ_E2E_EMIT_MOCK_ARTIFACT__?.({
    channelName: "general",
    pubkey: agent,
    tags: [
      ["ar", "1"],
      ["d", crypto.randomUUID()],
      ["type", "buzz.agent_prompt"],
      ["title", "Allow this agent action?"],
      ["op", "create"],
      ["root", message.id],
    ],
    content: JSON.stringify({
      version: 1,
      kind: "question",
      state: "open",
      permission: {
        version: 1,
        ownerPubkey: "deadbeef".repeat(8),
        agentPubkey: agent,
        requestId: "preview-permission",
        sessionId: "preview",
        cwd: "/tmp/buzz-permission-test",
        command: "pwd",
        toolCall: {
          toolCallId: "preview-tool",
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
    }),
  });
  void router.navigate({
    to: "/channels/$channelId",
    params: { channelId: channel },
  });
}
