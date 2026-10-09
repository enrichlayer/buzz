import assert from "node:assert/strict";
import test from "node:test";

import {
  annotationSourceRevision,
  formatAnnotationMessage,
  annotationMetadata,
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
  assert.match(message, /Response · code block 2 · lines 4–6/);
  assert.doesNotMatch(
    message.split("```buzz-annotation")[0],
    /event:abc|assistant-message-7/,
  );
  assert.match(message, /Please keep the error result typed\./);
});

test("source metadata escapes fence characters without changing the quote", () => {
  const anchor = {
    sourceId: "m",
    sourceRevision: "v1",
    selectedText: "```danger",
    originalSourceText: "```danger",
  };
  const message = formatAnnotationMessage(anchor, "Fix this");
  const body = message.split("```buzz-annotation\n")[1].split("\n```")[0];
  assert.deepEqual(
    JSON.parse(body),
    JSON.parse(JSON.stringify(annotationMetadata(anchor))),
  );
  assert.equal(body.includes("```"), false);
});

import { parseAnnotationMessage } from "./annotationModel.ts";
test("annotation presentation preserves exact source and refuses mismatched envelopes", () => {
  const anchor = {
    sourceId: "source",
    sourceRevision: "rev",
    selectedText: "first\nsecond <tag>\nthird\nfourth res",
    originalSourceText: "first",
  };
  const message = formatAnnotationMessage(anchor, "Keep this comment.");
  const parsed = parseAnnotationMessage(message);
  assert.equal(parsed.metadata.selectedText, anchor.selectedText);
  assert.equal(parsed.comment, "Keep this comment.");
  assert.equal(
    parseAnnotationMessage(message.replace("> first", "> altered")),
    null,
  );
  assert.equal(parseAnnotationMessage(`Ordinary message\n${message}`), null);
});
