import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchThreadReviews } from "./threadReviews.ts";
import {
  sessionReviewContext,
  parseSessionLinearIssue,
} from "./sessionReviewContext.ts";

const thread = "a".repeat(64);
const author = "b".repeat(64);
const repo = `30617:${"c".repeat(64)}:demo`;
const channel = "4978b750-109a-4aa4-8bbb-c9402217813c";
const root = {
  id: "d".repeat(64),
  pubkey: author,
  kind: 1618,
  created_at: 1,
  content: "Review",
  sig: "",
  tags: [
    ["h", channel],
    ["e", thread, "", "buzz-session"],
    ["a", repo],
    ["c", "1".repeat(40)],
    ["r", "https://linear.app/acme/issue/DEV-1/fix", "linear-issue"],
  ],
};

test("thread discovery opens the same durable review and follows only trusted commit updates", async () => {
  const requests = [];
  const updated = {
    ...root,
    id: "e".repeat(64),
    kind: 1619,
    created_at: 2,
    tags: [
      ["a", repo],
      ["E", root.id],
      ["c", "2".repeat(40)],
    ],
  };
  const rogue = {
    ...updated,
    pubkey: "f".repeat(64),
    created_at: 3,
    tags: [
      ["E", root.id],
      ["c", "3".repeat(40)],
    ],
  };
  const reviews = await fetchThreadReviews(
    async (filter) => {
      requests.push(filter);
      return filter.kinds[0] === 1618
        ? [root]
        : filter.kinds[0] === 1619
          ? [updated, rogue]
          : [];
    },
    channel,
    thread,
  );
  assert.deepEqual(requests[0], {
    kinds: [1618],
    "#h": [channel],
    "#e": [thread],
    limit: 200,
  });
  assert.deepEqual(requests[1]["#E"], [root.id]);
  assert.deepEqual(
    requests[2].kinds,
    [1630, 1631, 1632, 1633],
    "discussion volume must not consume the session summary cap",
  );
  assert.equal(reviews[0].commit, "2".repeat(40));
  assert.equal(reviews[0].id, root.id);
  assert.equal(reviews[0].sessionContext.threadRootId, thread);
  assert.equal(reviews[0].sessionContext.linearIssueId, "DEV-1");
});

test("other channels, other threads and ordinary event references never become session reviews", async () => {
  for (const tags of [
    root.tags.filter((tag) => tag[0] !== "h"),
    root.tags.map((tag) => (tag[0] === "h" ? ["h", "another"] : tag)),
    root.tags.map((tag) => (tag[0] === "e" ? ["e", thread, "", "root"] : tag)),
    root.tags.map((tag) =>
      tag[0] === "e" ? ["e", "f".repeat(64), "", "buzz-session"] : tag,
    ),
  ]) {
    let calls = 0;
    assert.deepEqual(
      await fetchThreadReviews(
        async () => {
          calls++;
          return [{ ...root, tags }];
        },
        channel,
        thread,
      ),
      [],
    );
    assert.equal(calls, 1);
  }
});

test("invalid and ambiguous issue/thread associations fail closed; prose is not metadata", () => {
  assert.equal(sessionReviewContext({ tags: [] }), null);
  assert.equal(
    sessionReviewContext({
      tags: [...root.tags, ["e", thread, "", "buzz-session"]],
    }),
    null,
  );
  assert.equal(
    sessionReviewContext({
      tags: [
        ...root.tags,
        ["r", "https://linear.app/acme/issue/DEV-2", "linear-issue"],
      ],
    }),
    null,
  );
  for (const url of [
    "http://linear.app/acme/issue/DEV-1",
    "https://linear.app.evil.test/acme/issue/DEV-1",
    "https://user@linear.app/acme/issue/DEV-1",
    "https://linear.app/acme/project/DEV-1",
    "https://linear.app/acme/issue/nope",
  ]) {
    assert.equal(parseSessionLinearIssue(url), null, url);
  }
  assert.deepEqual(
    parseSessionLinearIssue(
      "https://linear.app/acme/issue/dev-1/fix?view=test#detail",
    ),
    { id: "DEV-1", url: "https://linear.app/acme/issue/dev-1/fix" },
  );
});

test("relay failures and capped snapshots are errors rather than authoritative empty reviews", async () => {
  await assert.rejects(
    fetchThreadReviews(
      async () => {
        throw new Error("offline");
      },
      channel,
      thread,
    ),
    /offline/,
  );
  await assert.rejects(
    fetchThreadReviews(async () => Array(200).fill(root), channel, thread),
    /Too many reviews/,
  );
  await assert.rejects(
    fetchThreadReviews(
      async (filter) =>
        filter.kinds[0] === 1618 ? [root] : Array(200).fill(root),
      channel,
      thread,
    ),
    /history is too large/,
  );
});
