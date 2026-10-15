import assert from "node:assert/strict";
import test from "node:test";
import { fetchProjectPullRequests } from "./projectReviewFetch.ts";
import { projectReviewThreads } from "./reviewThreads.ts";
const owner = "a".repeat(64),
  reviewer = "b".repeat(64);
const address = `30617:${owner}:demo`;
const root = {
  id: "c".repeat(64),
  kind: 1618,
  pubkey: owner,
  content: "Review",
  created_at: 1,
  tags: [
    ["a", address],
    ["c", "d".repeat(40)],
  ],
};
const comment = (id, time, tags = []) => ({
  id,
  kind: 1,
  pubkey: reviewer,
  content: id,
  created_at: time,
  tags: [
    ["a", address],
    ["e", root.id, "", "root"],
    ["c", "d".repeat(40)],
    ...tags,
  ],
});
const discussion = comment("discussion", 2);
const reply = comment("reply", 3, [["e", "discussion", "", "reply"]]);
const resolve = comment("resolve", 1000, [
  ["e", "discussion", "", "reply"],
  ["t", "review-thread-resolve"],
]);
function relay(comments, calls = []) {
  return async (filter) => {
    calls.push(filter);
    if (filter.kinds[0] === 1618) return [root];
    if (filter.kinds[0] !== 1) return [];
    assert.deepEqual(filter["#e"], [root.id]);
    assert.equal(filter["#a"], undefined);
    return comments
      .filter(
        (event) =>
          filter.until === undefined || event.created_at <= filter.until,
      )
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filter.limit);
  };
}
test("production review fetch keeps roots, replies and resolution beyond 500 newer comments", async () => {
  const comments = [
    discussion,
    reply,
    resolve,
    ...Array.from({ length: 1100 }, (_, i) => comment(`new-${i}`, 1100 + i)),
  ];
  const calls = [];
  const [review] = await fetchProjectPullRequests(
    { repoAddress: address },
    relay(comments, calls),
  );
  const thread = projectReviewThreads(review, owner).find(
    (thread) => thread.id === "discussion" || thread.root.id === "discussion",
  );
  assert.ok(thread);
  assert.equal(thread.resolved, true);
  assert.equal(thread.replies.length, 1);
  assert.ok(calls.filter((filter) => filter.kinds[0] === 1).length >= 3);
});
test("saturated timestamps fail visibly instead of projecting partial discussions", async () => {
  const comments = Array.from({ length: 1100 }, (_, i) =>
    comment(`same-${i}`, 50),
  );
  await assert.rejects(
    fetchProjectPullRequests({ repoAddress: address }, relay(comments)),
    /incomplete.*timestamp/,
  );
});
test("cancellation stops history pagination", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(
    fetchProjectPullRequests({ repoAddress: address }, relay([]), abort.signal),
    /abort/i,
  );
});
