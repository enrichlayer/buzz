import assert from "node:assert/strict";
import test from "node:test";

import { KIND_ARTIFACT } from "@/features/artifacts/artifactEnvelope";
import {
  CHANNEL_EVENT_KINDS,
  CHANNEL_TIMELINE_CONTENT_KINDS,
} from "@/shared/constants/kinds";
import { ARTIFACT_TYPE_AGENT_PROMPT } from "./agentPrompt";
import {
  ARTIFACT_TYPE_POLICIES,
  getArtifactTypePolicy,
  isRegisteredArtifactType,
} from "./policies";

test("each artifact-type plugin owns a distinct type and id", () => {
  const types = ARTIFACT_TYPE_POLICIES.map((p) => p.type);
  const ids = ARTIFACT_TYPE_POLICIES.map((p) => p.id);
  assert.equal(new Set(types).size, types.length);
  assert.equal(new Set(ids).size, ids.length);
});

test("agent prompts are registered by their artifact type", () => {
  assert.equal(
    getArtifactTypePolicy(ARTIFACT_TYPE_AGENT_PROMPT)?.id,
    "agent-prompt",
  );
  assert.equal(isRegisteredArtifactType("buzz.task"), false);
  assert.equal(getArtifactTypePolicy(undefined), undefined);
});

test("artifact revisions never become timeline rows", () => {
  // NIP-AR: revisions are state, not messages. They ride their own
  // subscription and must not dilute the timeline's history limits.
  assert.ok(!CHANNEL_EVENT_KINDS.includes(KIND_ARTIFACT));
  assert.ok(!CHANNEL_TIMELINE_CONTENT_KINDS.includes(KIND_ARTIFACT));
});
