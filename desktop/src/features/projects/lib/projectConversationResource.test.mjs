import assert from "node:assert/strict";
import test from "node:test";
import { projectConversationResource } from "./projectConversationResource.ts";
import {
  buildProjectDetailAgentContext,
  buildProjectSelectionAgentContext,
} from "./projectDetailAgentContext.ts";
import { projectsConversationScope } from "./projectAgentConversationStorage.ts";

function detail(id) {
  return buildProjectDetailAgentContext({
    activeTab: "issues",
    project: { name: "Tools" },
    repository: { name: "Buzz", repoAddress: "30617:owner:buzz" },
    source: "remote",
    workItems: [null, { id, title: "Same title", status: "In Progress" }, null],
  });
}

test("two tasks in one repository never share a conversation or draft scope", () => {
  const first = projectConversationResource(detail("a".repeat(64)));
  const second = projectConversationResource(detail("b".repeat(64)));
  assert.notEqual(first, second);
  assert.notEqual(
    projectsConversationScope("detail", "https://relay.test", "owner", first),
    projectsConversationScope("detail", "https://relay.test", "owner", second),
  );
  assert.notEqual(first, detail("a").repoAddress);
});

test("the same task selected from the overview reopens its detail conversation", () => {
  const id = "a".repeat(64);
  const selected = buildProjectSelectionAgentContext([
    { kind: "task", id, title: "Renamed task" },
  ]);
  assert.equal(
    projectConversationResource(selected),
    projectConversationResource(detail(id)),
  );
});

test("selection identity is order-independent and distinguishes different tasks", () => {
  const a = { kind: "task", id: "a", title: "A" };
  const b = { kind: "task", id: "b", title: "B" };
  const resource = (items) =>
    projectConversationResource(buildProjectSelectionAgentContext(items));
  assert.equal(resource([a, b]), resource([b, a]));
  assert.notEqual(resource([a, b]), resource([a, { ...b, id: "c" }]));
  assert.notEqual(resource([a]), resource([{ ...a, kind: "review" }]));
});

test("repository browsing preserves its scope and commits keep repository identity", () => {
  const context = { ...detail("a"), workItem: null };
  assert.equal(projectConversationResource(context), context.repoAddress);
  const commit = {
    ...context,
    workItem: { kind: "commit", id: "hash", title: "Fix" },
  };
  assert.notEqual(
    projectConversationResource(commit),
    projectConversationResource({
      ...commit,
      repoAddress: "30617:owner:other",
    }),
  );
});

test("work identity never replaces the community and signer boundaries", () => {
  const resource = projectConversationResource(detail("a"));
  const scope = (relay, signer) =>
    projectsConversationScope("detail", relay, signer, resource);
  assert.notEqual(
    scope("https://a.test", "owner"),
    scope("https://b.test", "owner"),
  );
  assert.notEqual(
    scope("https://a.test", "owner"),
    scope("https://a.test", "peer"),
  );
  assert.equal(scope(null, "owner"), null);
});
