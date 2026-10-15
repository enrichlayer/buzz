import assert from "node:assert/strict";
import test from "node:test";
import { getSentMessageLink } from "./messageLinks.ts";
const result = JSON.stringify({ accepted: true, event_id: "reply" });
const item = {
  status: "completed",
  isError: false,
  descriptor: { renderClass: "message" },
  channelId: "channel",
  args: {},
  result,
};
test("publication proof accepts exact Claude console envelopes and retains failure boundaries", () => {
  for (const value of [
    result,
    `\x60\x60\x60console\n${result}\n\x60\x60\x60`,
    JSON.stringify({ stdout: `\x60\x60\x60json\n${result}\n\x60\x60\x60` }),
  ]) {
    assert.deepEqual(getSentMessageLink({ ...item, result: value }), {
      channelId: "channel",
      messageId: "reply",
    });
  }
  for (const override of [
    { status: "failed" },
    { status: "executing" },
    { isError: true },
    { result: JSON.stringify({ accepted: false, event_id: "reply" }) },
    { result: `Failed to publish\n${result}` },
    { result: `\x60\x60\x60console\n${result}\n\x60\x60\x60\nWarning: failed` },
  ]) {
    assert.equal(getSentMessageLink({ ...item, ...override }), null);
  }
});
