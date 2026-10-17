import assert from "node:assert/strict";
import test from "node:test";
import {
  sessionActivityAnchor,
  sessionOutcome,
  visibleSessionItems,
} from "./threadSessionPresentation.ts";
import { buildCompactToolSummary } from "./agentSessionToolSummary.ts";
import { classifyTool } from "./agentSessionToolClassifier.ts";

const event = (kind, payload = {}, turnId = "t1") => ({
  kind,
  payload,
  turnId,
  timestamp: "2026-01-01T00:00:00Z",
});
test("outcome survives the terminal guard, distinguishes cancellation and never assumes silence is success", () => {
  const turns = new Set(["t1"]);
  assert.equal(
    sessionOutcome(
      [event("turn_error", { outcome: "error" }), event("turn_completed")],
      turns,
      false,
      false,
    ),
    "Turn failed",
  );
  assert.equal(
    sessionOutcome(
      [
        event("acp_read", { result: { stopReason: "cancelled" } }),
        event("turn_completed"),
      ],
      turns,
      false,
      false,
    ),
    "Turn cancelled",
  );
  assert.equal(
    sessionOutcome([event("turn_completed")], turns, false, true),
    "Turn ended · outcome unknown",
  );
  assert.equal(
    sessionOutcome(
      [
        event("acp_read", { result: { stopReason: "end_turn" } }),
        event("turn_completed"),
      ],
      turns,
      false,
      false,
    ),
    "Turn completed",
  );
  assert.equal(
    sessionOutcome([event("turn_started")], turns, false, false),
    "Outcome unknown",
  );
  assert.equal(
    sessionOutcome([event("turn_started")], turns, true, true),
    "Connection lost · outcome unknown",
  );
  assert.equal(
    sessionOutcome(
      [event("turn_completed", {}, "neighbor")],
      turns,
      false,
      false,
    ),
    "Outcome unknown",
  );
});
test("two turns interleave activity with published messages, including second-precision ties", () => {
  const messages = [
    { id: "prompt", createdAt: 1 },
    { id: "answer", createdAt: 3, isAgent: true },
    { id: "feedback", createdAt: 5 },
    { id: "answer2", createdAt: 8, isAgent: true },
  ];
  const anchor = (ms) =>
    sessionActivityAnchor({ timestamp: new Date(ms).toISOString() }, messages);
  assert.equal(anchor(1200), "prompt");
  assert.equal(anchor(3100), "prompt");
  assert.equal(anchor(4000), "answer");
  assert.equal(anchor(5000), "feedback");
  assert.equal(anchor(7000), "feedback");
  assert.equal(anchor(9000), "answer2");
});
test("reader views retain attention states and never mutate captured evidence", () => {
  const items = [
    { type: "message" },
    { type: "metadata" },
    { type: "thought" },
    { type: "tool", status: "completed" },
    { type: "tool", status: "failed" },
    { type: "lifecycle", renderClass: "permission" },
  ];
  const before = JSON.stringify(items);
  assert.deepEqual(visibleSessionItems(items, "conversation"), [
    items[0],
    items[4],
    items[5],
  ]);
  assert.deepEqual(visibleSessionItems(items, "activity"), [
    items[0],
    items[3],
    items[4],
    items[5],
  ]);
  assert.deepEqual(visibleSessionItems(items, "full"), items);
  assert.equal(JSON.stringify(items), before);
});
test("failed action cannot override failure label; Claude Edit exposes exact observed diff", () => {
  const input = {
    toolName: "shell",
    title: "Run",
    buzzToolName: null,
    args: { command: "node --test" },
    result: "Exit code: 1",
    isError: true,
  };
  const failed = buildCompactToolSummary({
    ...input,
    type: "tool",
    status: "failed",
    descriptor: classifyTool(input),
  });
  assert.equal(failed.action, null);
  assert.equal(failed.label, "Command failed");
  const edit = {
    ...input,
    toolName: "Edit",
    title: "Edit /tmp/slugify.js",
    isError: false,
    args: {
      file_path: "/tmp/slugify.js",
      old_string: "bad()",
      new_string: "good()",
    },
    result: "Updated successfully",
  };
  const summary = buildCompactToolSummary({
    ...edit,
    type: "tool",
    status: "completed",
    descriptor: classifyTool(edit),
  });
  assert.equal(summary.kind, "file-edit");
  assert.equal(summary.fileEditDiff.path, "/tmp/slugify.js");
  assert.deepEqual(summary.fileEditDiff.lines, [
    { kind: "remove", text: "-bad()" },
    { kind: "add", text: "+good()" },
  ]);
});
