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
import { linearSyncStatus } from "./linearSyncStatus.ts";
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
test("project completion receipts distinguish partial bootstrap and interrupted updates", () => {
  const task = linearEventToWork(event());
  const receipt = { ...task, type: "project", sourceId: project };
  assert.deepEqual(linearSyncStatus(task, [task]), {
    completeAt: null,
    partial: true,
  });
  assert.deepEqual(linearSyncStatus(task, [task, receipt]), {
    completeAt: receipt.observedAt,
    partial: false,
  });
  const update = { ...task, observedAt: "2026-10-16T00:00:00Z" };
  assert.equal(linearSyncStatus(update, [update, receipt]).partial, true);
  assert.equal(
    linearSyncStatus(update, [
      update,
      { ...receipt, observedAt: update.observedAt },
    ]).partial,
    false,
  );
  assert.equal(
    linearSyncStatus(task, [task, { ...receipt, publisher: "b".repeat(64) }])
      .completeAt,
    null,
  );
  assert.equal(
    linearSyncStatus(task, [task, receipt, { ...update, channelId: project }])
      .partial,
    false,
  );
});
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
  // #a is post-filtered by the relay, so it must not bound the root query.
  assert.equal(calls[0]["#a"], undefined);
  assert.equal(
    calls.find((filter) => filter.kinds[0] === 1619)["#E"],
    undefined,
  );
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].commit, "c".repeat(40));
  assert.equal(reviews[0].sessionContext.taskAddress, address);
  const many = Array.from({ length: 201 }, (_, index) => ({
    ...root,
    id: (index + 1).toString(16).padStart(64, "0"),
  }));
  await assert.rejects(
    fetchLinearTaskReviews(
      async (filter) => (filter.kinds[0] === 1618 ? many : []),
      address,
    ),
    /limit/,
  );
});

test("task review lookup survives relay-wide history beyond the SQL limit", async () => {
  const other = "f".repeat(64);
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
    ],
  };
  const unrelatedRoots = Array.from({ length: 600 }, (_, index) => ({
    ...root,
    id: `1${index.toString(16).padStart(63, "0")}`,
    pubkey: other,
    created_at: 1000 + index,
    tags: [["a", `30617:${other}:repo`]],
  }));
  const update = {
    id: "9".repeat(64),
    pubkey: owner,
    kind: 1619,
    content: "",
    created_at: 6,
    tags: [
      ["E", root.id],
      ["c", "2".repeat(40)],
    ],
  };
  const unrelatedUpdates = Array.from({ length: 600 }, (_, index) => ({
    ...update,
    id: `2${index.toString(16).padStart(63, "0")}`,
    pubkey: other,
    created_at: 1000 + index,
    tags: [["E", "8".repeat(64)]],
  }));
  const store = [root, update, ...unrelatedRoots, ...unrelatedUpdates];
  // Model the relay: kinds, authors, #e and until are applied in SQL before
  // LIMIT; #a and uppercase #E are applied to the limited page afterwards.
  const relay = async (filter) =>
    store
      .filter(
        (event) =>
          filter.kinds.includes(event.kind) &&
          (!filter.authors || filter.authors.includes(event.pubkey)) &&
          (!filter["#e"] ||
            event.tags.some(
              (tag) => tag[0] === "e" && filter["#e"].includes(tag[1]),
            )) &&
          (filter.until === undefined || event.created_at <= filter.until),
      )
      .sort((left, right) => right.created_at - left.created_at)
      .slice(0, filter.limit)
      .filter(
        (event) =>
          (!filter["#a"] ||
            event.tags.some(
              (tag) => tag[0] === "a" && filter["#a"].includes(tag[1]),
            )) &&
          (!filter["#E"] ||
            event.tags.some(
              (tag) => tag[0] === "E" && filter["#E"].includes(tag[1]),
            )),
      );
  const reviews = await fetchLinearTaskReviews(relay, address);
  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].id, root.id);
  assert.equal(reviews[0].commit, "2".repeat(40));
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
