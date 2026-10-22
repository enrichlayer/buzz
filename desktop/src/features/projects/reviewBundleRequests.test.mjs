import assert from "node:assert/strict";
import test from "node:test";
import {
  requestReviewBundleReview,
  reviewBundleReviewRequests,
} from "./reviewBundleRequests.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const REVIEWER = "c".repeat(64);
const PR_A = "1".repeat(64);
const PR_B = "2".repeat(64);
const REPO = `30617:${OWNER}:demo`;

function state(overrides = {}) {
  return {
    bundle: {
      id: "5".repeat(64),
      author: AUTHOR,
      subject: "DEV-1 stack",
      repository: REPO,
      recipients: [OWNER, REVIEWER],
    },
    owner: OWNER,
    members: [
      { position: 1, pullRequest: { id: PR_A, title: "PR A", author: AUTHOR } },
      { position: 2, pullRequest: { id: PR_B, title: "PR B", author: AUTHOR } },
    ],
    ...overrides,
  };
}

test("one review-request note per member, addressed to the root's recipients minus the author", () => {
  const requests = reviewBundleReviewRequests(state());
  assert.deepEqual(
    requests.map((request) => [request.pullRequest, request.reviewers]),
    [
      [PR_A, [OWNER, REVIEWER]],
      [PR_B, [OWNER, REVIEWER]],
    ],
  );
  assert.deepEqual(requests[0].tags, [
    ["e", PR_A, "", "root"],
    ["a", REPO],
    ["p", OWNER],
    ["p", REVIEWER],
    ["t", "review-request"],
  ]);
  assert.match(requests[0].content, /DEV-1 stack/);
  const explicit = reviewBundleReviewRequests(state(), [
    REVIEWER.toUpperCase(),
    AUTHOR,
    REVIEWER,
  ]);
  assert.deepEqual(explicit[1].reviewers, [REVIEWER]);
});

test("a member whose only candidate reviewer is its author rejects the whole request", () => {
  assert.throws(
    () => reviewBundleReviewRequests(state(), [AUTHOR]),
    /No reviewer for “PR A”/,
  );
  assert.throws(() => reviewBundleReviewRequests(state(), []), /at least one/);
});

test("a failed member leaves earlier members requested and names what is missing", async () => {
  const published = [];
  const result = await requestReviewBundleReview(
    state(),
    undefined,
    async (request) => {
      published.push(request.pullRequest);
    },
  );
  assert.deepEqual(result, { requested: [PR_A, PR_B] });
  const partial = [];
  await assert.rejects(
    requestReviewBundleReview(state(), undefined, async (request) => {
      if (request.pullRequest === PR_B) throw new Error("relay closed");
      partial.push(request.pullRequest);
    }),
    /Requested a review on 1 of 2 members; not requested: PR B \(relay closed\)/,
  );
  assert.deepEqual(partial, [PR_A]);
});
