import assert from "node:assert/strict";
import test from "node:test";

import { createChannelArtifactRegistry } from "./channelArtifactRegistry";

const CHANNEL = "9b353519-f4fe-4757-aef4-bec6cc0ae54c";
const D = "04737c81-e5e8-4412-bb47-f446813cfeba";
const GRACE_MS = 5;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function harness({ fetched = [] } = {}) {
  const subscriptions = [];
  const registry = createChannelArtifactRegistry({
    subscribeLive: async (filter, onEvent) => {
      const sub = { filter, onEvent, disposed: 0 };
      subscriptions.push(sub);
      return () => {
        sub.disposed += 1;
      };
    },
    fetchEvents: async () => fetched,
    isRegisteredType: (type) => type === "buzz.agent_prompt",
    releaseGraceMs: GRACE_MS,
  });
  return { registry, subscriptions };
}

function prompt(id, prev) {
  const tags = [
    ["ar", "1"],
    ["d", D],
    ["h", CHANNEL],
    ["type", "buzz.agent_prompt"],
    ["title", "Which auth?"],
    ["op", prev ? "update" : "create"],
    ["root", "a".repeat(64)],
  ];
  if (prev) tags.push(["prev", prev]);
  return {
    id,
    pubkey: "b".repeat(64),
    created_at: 1,
    kind: 45010,
    tags,
    content: "{}",
    sig: "",
  };
}

test("one subscription per channel, shared and released after a grace", async () => {
  const { registry, subscriptions } = harness();
  const first = registry.acquire(CHANNEL);
  const second = registry.acquire(CHANNEL);
  assert.equal(first, second);
  assert.equal(subscriptions.length, 1);
  assert.deepEqual(subscriptions[0].filter.kinds, [45010, 45011]);

  registry.release(CHANNEL, first);
  registry.release(CHANNEL, second);
  // Re-acquired within the grace (timeline virtualization): no new REQ.
  const third = registry.acquire(CHANNEL);
  await wait(GRACE_MS * 3);
  assert.equal(subscriptions.length, 1);
  assert.equal(subscriptions[0].disposed, 0);

  registry.release(CHANNEL, third);
  await wait(GRACE_MS * 3);
  assert.equal(subscriptions[0].disposed, 1);
  assert.equal(registry.size(), 0);
});

test("reset drops every store and re-subscribes on the next acquire", async () => {
  const { registry, subscriptions } = harness();
  const before = registry.acquire(CHANNEL);
  await wait(0);
  subscriptions[0].onEvent(prompt("1".repeat(64)));
  assert.equal(before.getForRoot("a".repeat(64)).length, 1);

  // Community switch: relayClient.disconnect() killed the live REQ.
  registry.reset();
  await wait(0);
  assert.equal(subscriptions[0].disposed, 1);
  assert.equal(registry.size(), 0);
  // A release from a row of the old community is a no-op.
  registry.release(CHANNEL, before);

  const after = registry.acquire(CHANNEL);
  assert.notEqual(after, before);
  assert.equal(subscriptions.length, 2, "A -> B -> A must send a new REQ");
  assert.equal(after.getForRoot("a".repeat(64)).length, 0);
});

test("ingest and refresh never create unacquired stores", async () => {
  const { registry } = harness({ fetched: [prompt("1".repeat(64))] });
  registry.ingest(CHANNEL, prompt("1".repeat(64)));
  assert.equal(await registry.refreshHead(CHANNEL, D), undefined);
  assert.equal(registry.size(), 0);
});

test("refresh adopts the relay's head, and drops an artifact it no longer has", async () => {
  const head = prompt("2".repeat(64), "1".repeat(64));
  const withHead = harness({ fetched: [head] });
  const store = withHead.registry.acquire(CHANNEL);
  withHead.registry.ingest(CHANNEL, prompt("1".repeat(64)));
  assert.equal((await withHead.registry.refreshHead(CHANNEL, D))?.id, head.id);
  assert.equal(store.getHead(D)?.id, head.id);

  const gone = harness({ fetched: [] });
  const goneStore = gone.registry.acquire(CHANNEL);
  gone.registry.ingest(CHANNEL, prompt("1".repeat(64)));
  assert.equal(await gone.registry.refreshHead(CHANNEL, D), undefined);
  assert.equal(goneStore.getForRoot("a".repeat(64)).length, 0);
});
