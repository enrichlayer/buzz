import assert from "node:assert/strict";
import test from "node:test";

import {
  CHANNEL_EVENT_KINDS,
  CHANNEL_TIMELINE_CONTENT_KINDS,
  isConversationalUnreadKind,
  KIND_HUDDLE_STARTED,
  KIND_STREAM_MESSAGE,
  KIND_STREAM_MESSAGE_DIFF,
} from "@/shared/constants/kinds";
import { getCodeFenceRenderer } from "@/shared/plugins/codeFences";
import {
  getMessageKindPolicy,
  isSystemCardKind,
  MESSAGE_KIND_POLICIES,
  PLUGIN_DM_NOTIFIABLE_KINDS,
  PLUGIN_TYPING_COMPLETION_KINDS,
  PLUGIN_WORKFLOW_PICKABLE_KINDS,
} from "./policies";

test("each plugin owns a distinct kind and id", () => {
  const kinds = MESSAGE_KIND_POLICIES.map((p) => p.kind);
  const ids = MESSAGE_KIND_POLICIES.map((p) => p.id);
  assert.equal(new Set(kinds).size, kinds.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("plugin kinds are fetched and rendered as timeline rows", () => {
  for (const { kind } of MESSAGE_KIND_POLICIES) {
    assert.ok(CHANNEL_EVENT_KINDS.includes(kind), `subscribed: ${kind}`);
    assert.ok(CHANNEL_TIMELINE_CONTENT_KINDS.includes(kind), `row: ${kind}`);
  }
});

test("diff keeps its pre-plugin behaviour", () => {
  assert.equal(isConversationalUnreadKind(KIND_STREAM_MESSAGE_DIFF), true);
  assert.equal(isSystemCardKind(KIND_STREAM_MESSAGE_DIFF), false);
  assert.ok(PLUGIN_TYPING_COMPLETION_KINDS.includes(KIND_STREAM_MESSAGE_DIFF));
  assert.ok(PLUGIN_WORKFLOW_PICKABLE_KINDS.includes(KIND_STREAM_MESSAGE_DIFF));
  assert.ok(!PLUGIN_DM_NOTIFIABLE_KINDS.includes(KIND_STREAM_MESSAGE_DIFF));
});

test("huddle-started keeps its pre-plugin behaviour", () => {
  assert.equal(isConversationalUnreadKind(KIND_HUDDLE_STARTED), false);
  assert.equal(isSystemCardKind(KIND_HUDDLE_STARTED), true);
  assert.ok(PLUGIN_DM_NOTIFIABLE_KINDS.includes(KIND_HUDDLE_STARTED));
  assert.ok(!PLUGIN_TYPING_COMPLETION_KINDS.includes(KIND_HUDDLE_STARTED));
  assert.ok(!PLUGIN_WORKFLOW_PICKABLE_KINDS.includes(KIND_HUDDLE_STARTED));
});

test("ordinary messages are not plugin kinds", () => {
  assert.equal(getMessageKindPolicy(KIND_STREAM_MESSAGE), undefined);
  assert.equal(getMessageKindPolicy(undefined), undefined);
  assert.equal(isSystemCardKind(KIND_STREAM_MESSAGE), false);
});

test("code fences resolve only registered languages", () => {
  assert.ok(getCodeFenceRenderer("mermaid"));
  assert.equal(getCodeFenceRenderer("typescript"), undefined);
  assert.equal(getCodeFenceRenderer(""), undefined);
  // Object prototype keys must not resolve as plugins.
  assert.equal(getCodeFenceRenderer("toString"), undefined);
});
