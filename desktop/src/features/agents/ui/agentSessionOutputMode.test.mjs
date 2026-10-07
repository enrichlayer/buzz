import assert from "node:assert/strict";
import test from "node:test";

import {
  presentAgentSessionTranscript,
  resolveAgentOutputMode,
} from "./agentSessionOutputMode.ts";

const common = { timestamp: "2026-01-01T00:00:00Z" };
const items = [
  {
    ...common,
    id: "message",
    type: "message",
    renderClass: "message",
    role: "assistant",
    title: "Agent",
    text: "Done",
  },
  {
    ...common,
    id: "thought",
    type: "thought",
    renderClass: "thought",
    title: "Thinking",
    text: "Routine progress",
  },
  {
    ...common,
    id: "permission",
    type: "lifecycle",
    renderClass: "permission",
    title: "Permission requested",
    text: "Approve this action",
  },
  {
    ...common,
    id: "status",
    type: "lifecycle",
    renderClass: "status",
    title: "Working",
    text: "In progress",
  },
  {
    ...common,
    id: "failed-tool",
    type: "tool",
    renderClass: "shell",
    descriptor: { renderClass: "shell", label: "Shell", preview: null },
    title: "Shell",
    toolName: "shell",
    buzzToolName: null,
    status: "failed",
    args: {},
    result: "failed",
    isError: true,
    startedAt: common.timestamp,
    completedAt: common.timestamp,
  },
  {
    ...common,
    id: "successful-tool",
    type: "tool",
    renderClass: "file-read",
    descriptor: { renderClass: "file-read", label: "Read", preview: null },
    title: "Read",
    toolName: "read",
    buzzToolName: null,
    status: "completed",
    args: {},
    result: "ok",
    isError: false,
    startedAt: common.timestamp,
    completedAt: common.timestamp,
  },
];

test("legacy absence and full mode preserve the entire transcript", () => {
  assert.equal(resolveAgentOutputMode(undefined), "full");
  assert.deepEqual(presentAgentSessionTranscript(items, undefined, false), {
    items,
    hiddenCount: 0,
  });
});

test("summary hides routine progress but preserves messages and attention items", () => {
  const presentation = presentAgentSessionTranscript(items, "summary", false);
  assert.deepEqual(
    presentation.items.map((item) => item.id),
    ["message", "permission", "failed-tool"],
  );
  assert.equal(presentation.hiddenCount, 3);
});

test("Show details reveals the original evidence without changing it", () => {
  const presentation = presentAgentSessionTranscript(items, "summary", true);
  assert.deepEqual(presentation.items, items);
  assert.equal(presentation.hiddenCount, 0);
});

test("tool permission and error classifications remain visible without failure flags", () => {
  const tool = items.find((item) => item.id === "successful-tool");
  for (const renderClass of ["permission", "error"]) {
    const attention = { ...tool, renderClass };
    assert.deepEqual(
      presentAgentSessionTranscript([attention], "summary", false).items,
      [attention],
    );
  }
});
