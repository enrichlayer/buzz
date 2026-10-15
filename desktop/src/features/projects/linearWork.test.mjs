import assert from "node:assert/strict";
import test from "node:test";
import { linearEventToWork, sameLinearProject } from "./linearWorkModels.ts";
import { fetchLinearWork } from "./linearWorkFetch.ts";
import {
  fetchLinearTaskReviews,
  fetchLinearTaskThreads,
} from "./linearTaskReviews.ts";
import {
  linearWorkLinkFromAddress,
  parseLinearWorkLink,
} from "../../shared/lib/linearWorkLink.ts";
import {
  parseEntityLink,
  entityLinkProjectRouteId,
} from "../../shared/lib/entityLink.ts";
import { sessionReviewContext } from "./sessionReviewContext.ts";
const channel = "11111111-1111-4111-8111-111111111111";
const org = "22222222-2222-4222-8222-222222222222";
const project = "33333333-3333-4333-8333-333333333333";
const issue = "44444444-4444-4444-8444-444444444444";
const owner = "a".repeat(64);
const address = `30624:${owner}:linear:${channel}:${org}:${issue}`;
function event(index = 1) {
  return {
    id: index.toString(16).padStart(64, "0"),
    pubkey: owner,
    kind: 30624,
    created_at: 1000 - index,
    tags: [
      ["h", channel],
      ["d", `linear:${channel}:${org}:${issue}`],
      ["l", project],
    ],
    content: JSON.stringify({
      schema: "buzz.linear-record.v1",
      source: {
        provider: "linear",
        organizationId: org,
        projectId: project,
        workspace: "acme",
      },
      type: "issue",
      observedAt: "2026-10-15T00:00:00Z",
      record: {
        id: issue,
        project: { id: project },
        identifier: "DEV-42",
        title: "Connected work",
        description: "Full acceptance criteria\n- Keep source identity",
        updatedAt: "2026-10-14T00:00:00Z",
        url: "https://linear.app/acme/issue/DEV-42/connected-work",
        state: { name: "In Progress", type: "started" },
      },
    }),
  };
}
test("source records and native links retain channel, publisher and immutable issue identity", () => {
  const record = linearEventToWork(event());
  assert.equal(record.address, address);
  assert.match(record.description, /Full acceptance criteria/);
  assert.equal(
    sameLinearProject(record, { ...record, publisher: "b".repeat(64) }),
    false,
  );
  assert.equal(
    sameLinearProject(record, { ...record, channelId: project }),
    false,
  );
  assert.equal(
    linearEventToWork({ ...event(), tags: [...event().tags, ["h", project]] }),
    null,
  );
  assert.equal(
    linearEventToWork({
      ...event(),
      tags: event().tags.map((tag) => (tag[0] === "l" ? ["l", issue] : tag)),
    }),
    null,
  );
  const href = linearWorkLinkFromAddress(address);
  const link = parseEntityLink(href);
  assert.equal(link.ok, true);
  assert.equal(entityLinkProjectRouteId(link.value), address);
  assert.equal(parseLinearWorkLink(`${href}&owner=${owner}`), null);
  assert.equal(parseLinearWorkLink(href.replace("buzz:", "https:")), null);
});
test("complete source reads deduplicate inclusive boundaries and fail closed on incomplete pages", async () => {
  let calls = 0;
  const records = await fetchLinearWork(async (filter) => {
    assert.deepEqual(filter.kinds, [30623, 30624]);
    calls++;
    return calls === 1
      ? Array.from({ length: 500 }, (_, i) => event(i + 1))
      : [event(500), event(501)];
  });
  // These events replace one address; the newest head is the only visible task.
  assert.equal(records.length, 1);
  assert.equal(records[0].eventId, event(1).id);
  await assert.rejects(
    fetchLinearWork(async ({ limit }) =>
      Array.from({ length: limit }, (_, i) => ({
        ...event(i),
        created_at: 10,
      })),
    ),
    /saturated/,
  );
  await assert.rejects(
    fetchLinearWork(async () => [{ ...event(), content: "bad JSON" }]),
    /malformed/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    fetchLinearWork(async () => [], controller.signal),
    /abort/i,
  );
});
test("task review lookup binds the signed task marker and exact commit", async () => {
  const root = {
    id: "d".repeat(64),
    pubkey: owner,
    kind: 1618,
    content: "Review connected work",
    created_at: 5,
    tags: [
      ["a", `30617:${owner}:repo`],
      ["a", address, "", "buzz-task"],
      ["e", "b".repeat(64), "", "buzz-session"],
      ["c", "c".repeat(40)],
      ["r", "https://linear.app/acme/issue/DEV-42", "linear-issue"],
    ],
  };
  assert.equal(sessionReviewContext(root).taskAddress, address);
  const calls = [];
  const reviews = await fetchLinearTaskReviews(async (filter) => {
    calls.push(filter);
    return filter.kinds[0] === 1618
      ? [
          root,
          {
            ...root,
            id: "e".repeat(64),
            tags: root.tags.filter((tag) => tag[3] !== "buzz-task"),
          },
        ]
      : [];
  }, address);
  assert.deepEqual(calls[0]["#a"], [address]);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].commit, "c".repeat(40));
  assert.equal(reviews[0].sessionContext.taskAddress, address);
  await assert.rejects(
    fetchLinearTaskReviews(async () => Array(200).fill(root), address),
    /limit/,
  );
});

test("task threads use signed roots and exclude replies and other channels", async () => {
  const root = {
    ...event(),
    kind: 9,
    tags: [
      ["h", channel],
      ["a", address, "", "buzz-task"],
    ],
  };
  const reply = {
    ...root,
    id: "b".repeat(64),
    tags: [...root.tags, ["e", root.id, "", "root"]],
  };
  const wrong = {
    ...root,
    id: "c".repeat(64),
    tags: [
      ["h", project],
      ["a", address, "", "buzz-task"],
    ],
  };
  const result = await fetchLinearTaskThreads(
    async (filter) => {
      assert.deepEqual(filter["#h"], [channel]);
      assert.deepEqual(filter["#a"], [address]);
      return [reply, wrong, root];
    },
    address,
    channel,
  );
  assert.deepEqual(
    result.map((item) => item.id),
    [root.id],
  );
});
