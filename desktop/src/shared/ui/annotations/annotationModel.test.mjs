import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationSourceRevision,
  formatAnnotationMessage,
} from "./annotationModel.ts";

test("annotation revisions change with source bytes and honor upstream revisions", () => {
  const first = annotationSourceRevision({ sourceId: "m1", text: "alpha" });
  const second = annotationSourceRevision({ sourceId: "m1", text: "beta" });
  assert.match(first, /^fnv1a64:[0-9a-f]{16}$/);
  assert.notEqual(first, second);
  assert.equal(
    annotationSourceRevision({
      sourceId: "m1",
      text: "changed",
      revision: "event:abc",
    }),
    "event:abc",
  );
});

test("formatted feedback carries explicit quote and immutable source location", () => {
  const message = formatAnnotationMessage(
    {
      sourceId: "assistant-message-7",
      sourceRevision: "event:abc",
      originalSourceText: "one\ntwo",
      selectedText: "one\ntwo",
      sessionId: "session-1",
      codeRange: {
        blockId: "assistant-message-7:code:2",
        startLine: 4,
        endLine: 6,
      },
    },
    "Please keep the error result typed.",
  );

  assert.match(message, /> one\n> two/);
  assert.match(message, /assistant-message-7/);
  assert.match(message, /event:abc/);
  assert.match(message, /code block `assistant-message-7:code:2` lines 4-6/);
  assert.match(message, /Please keep the error result typed\.$/);
});
