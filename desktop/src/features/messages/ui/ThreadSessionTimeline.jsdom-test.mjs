import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import {
  ThreadSessionTimelineProvider,
  ThreadSessionActivitySlot,
  useThreadActivityFragments,
} from "./ThreadSessionTimeline.tsx";
const h = React.createElement;
function Publisher({ owner, items }) {
  useThreadActivityFragments(owner, items);
  return null;
}
test("activity slots interleave independent agents, update in place and remove unmounted owners", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const a = [
    {
      id: "a1",
      afterMessageId: "prompt",
      timestamp: "2026-01-01T01:00:00Z",
      content: "Read",
    },
    {
      id: "a2",
      afterMessageId: "feedback",
      timestamp: "2026-01-01T01:03:00Z",
      content: "Edit",
    },
  ];
  const b = [
    {
      id: "b1",
      afterMessageId: "prompt",
      timestamp: "2026-01-01T01:01:00Z",
      content: "Tests failed",
    },
  ];
  const tree = (showB = true) =>
    h(
      ThreadSessionTimelineProvider,
      null,
      h(Publisher, { owner: "a", items: a }),
      showB ? h(Publisher, { owner: "b", items: b }) : null,
      h("p", null, "Prompt"),
      h(ThreadSessionActivitySlot, { messageId: "prompt" }),
      h("p", null, "Feedback"),
      h(ThreadSessionActivitySlot, { messageId: "feedback" }),
    );
  try {
    await act(async () => root.render(tree()));
    assert.equal(container.textContent, "PromptReadTests failedFeedbackEdit");
    await act(async () => root.render(tree(false)));
    assert.equal(container.textContent, "PromptReadFeedbackEdit");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("attribution follows agent identity and turn boundaries, not display name", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const items = [
    {
      id: "a",
      agentId: "a",
      agentName: "Same name",
      turnId: "a1",
      afterMessageId: "prompt",
      timestamp: "1",
      content: "Read",
    },
    {
      id: "b",
      agentId: "b",
      agentName: "Same name",
      turnId: "b1",
      afterMessageId: "prompt",
      timestamp: "2",
      content: "Edit",
    },
    {
      id: "b2",
      agentId: "b",
      agentName: "Same name",
      turnId: "b1",
      afterMessageId: "prompt",
      timestamp: "3",
      content: "Test",
    },
    {
      id: "b3",
      agentId: "b",
      agentName: "Same name",
      turnId: "b1",
      afterMessageId: "answer",
      timestamp: "4",
      content: "Follow-up",
    },
  ];
  try {
    await act(async () =>
      root.render(
        h(
          ThreadSessionTimelineProvider,
          null,
          h(Publisher, { owner: "all", items }),
          h(ThreadSessionActivitySlot, {
            messageId: "prompt",
            messageAuthor: "human",
          }),
          h(ThreadSessionActivitySlot, {
            messageId: "answer",
            messageAuthor: "b",
          }),
        ),
      ),
    );
    assert.equal(container.querySelectorAll("section p").length, 2);
    assert.equal(
      container.querySelectorAll("section")[1].textContent,
      "Follow-up",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
