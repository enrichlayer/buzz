import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchReviewBundle,
  fetchReviewBundlesForReviews,
} from "./reviewBundleFetch.ts";
import {
  BUNDLE_APPROVAL_LABEL,
  BUNDLE_MEMBER_MARKER,
  REVIEW_BUNDLE_LABEL,
} from "./reviewBundles.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const REVIEWER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const PR_A = "1".repeat(64);
const PR_B = "2".repeat(64);
const PR_X = "3".repeat(64);
const BUNDLE = "5".repeat(64);
const FOREIGN_BUNDLE = "6".repeat(64);
const REPO = `30617:${OWNER}:demo`;
let counter = 0;

function event(kind, pubkey, tags, overrides = {}) {
  counter += 1;
  return {
    id: counter.toString(16).padStart(64, "0"),
    pubkey,
    kind,
    created_at: 1_700_000_000 + counter,
    content: "",
    sig: "",
    tags,
    ...overrides,
  };
}

function prRoot(id, head, pubkey = AUTHOR) {
  return event(
    1618,
    pubkey,
    [
      ["a", REPO],
      ["subject", `PR ${id.slice(0, 1)}`],
      ["c", head],
      ["p", REVIEWER],
    ],
    { id },
  );
}

const rootA = prRoot(PR_A, "7".repeat(40));
const rootB = prRoot(PR_B, "8".repeat(40));
const rootX = prRoot(PR_X, "9".repeat(40), STRANGER);
const update = event(1619, AUTHOR, [
  ["a", REPO],
  ["E", PR_B],
  ["c", "f".repeat(40)],
]);
const bundle = event(
  1,
  AUTHOR,
  [
    ["a", REPO],
    ["subject", "stack"],
    ["t", REVIEW_BUNDLE_LABEL],
    ["e", PR_A, "", BUNDLE_MEMBER_MARKER],
    ["e", PR_B, "", BUNDLE_MEMBER_MARKER],
    ["p", REVIEWER],
  ],
  { id: BUNDLE },
);
// Lists a member authored by a stranger: the root's signer may not speak for it.
const foreignBundle = event(
  1,
  AUTHOR,
  [
    ["a", REPO],
    ["subject", "stack"],
    ["t", REVIEW_BUNDLE_LABEL],
    ["e", PR_A, "", BUNDLE_MEMBER_MARKER],
    ["e", PR_X, "", BUNDLE_MEMBER_MARKER],
  ],
  { id: FOREIGN_BUNDLE },
);
const verdict = event(1, REVIEWER, [
  ["e", BUNDLE, "", "root"],
  ["a", REPO],
  ["t", BUNDLE_APPROVAL_LABEL],
  ["member-head", PR_A, "7".repeat(40)],
  ["member-head", PR_B, "f".repeat(40)],
]);
const plainReply = event(1, REVIEWER, [
  ["e", PR_A, "", "root"],
  ["a", REPO],
]);
const roots = { [PR_A]: rootA, [PR_B]: rootB, [PR_X]: rootX };

function relay(requests) {
  return async (filter) => {
    requests.push(filter);
    if (filter.ids) {
      return filter.ids
        .map((id) => roots[id] ?? (id === BUNDLE ? bundle : null))
        .filter((item) => item && filter.kinds.includes(item.kind));
    }
    if (filter.kinds[0] === 1619) return [update];
    if (filter.kinds[0] === 1630) return [];
    const refs = filter["#e"] ?? [];
    return [bundle, foreignBundle, verdict, plainReply].filter((item) =>
      item.tags.some((tag) => tag[0] === "e" && refs.includes(tag[1])),
    );
  };
}

test("a thread's reviews find their bundle, and the stranger's member drops the other", async () => {
  const requests = [];
  const states = await fetchReviewBundlesForReviews(relay(requests), [rootA]);
  assert.equal(states.length, 1);
  const [state] = states;
  assert.equal(state.bundle.id, BUNDLE);
  assert.deepEqual(
    state.members.map((row) => [
      row.position,
      row.pullRequest.id,
      row.pullRequest.commit,
    ]),
    [
      [1, PR_A, "7".repeat(40)],
      [2, PR_B, "f".repeat(40)],
    ],
    "the missing member is fetched by id and its trusted update applied",
  );
  assert.equal(state.decision, "approved");
  assert.deepEqual(requests[0], { kinds: [1], "#e": [PR_A], limit: 500 });
  const byIds = requests.find((filter) => filter.ids);
  assert.deepEqual(byIds, { kinds: [1618], ids: [PR_B, PR_X], limit: 2 });
  assert.ok(
    requests.some(
      (filter) => filter.kinds[0] === 1619 && filter.authors.includes(AUTHOR),
    ),
  );
  assert.ok(
    !requests.some(
      (filter) => filter.kinds[0] === 1619 && filter.authors.includes(STRANGER),
    ),
    "no history is fetched on behalf of a dropped bundle's member",
  );
});

test("no roots means no relay traffic", async () => {
  const requests = [];
  assert.deepEqual(await fetchReviewBundlesForReviews(relay(requests), []), []);
  assert.equal(requests.length, 0);
});

test("a bundle link resolves one bundle by id, or null when the relay holds none", async () => {
  const requests = [];
  const state = await fetchReviewBundle(relay(requests), BUNDLE.toUpperCase());
  assert.equal(state?.bundle.id, BUNDLE);
  assert.deepEqual(requests[0], { kinds: [1], ids: [BUNDLE], limit: 1 });
  assert.equal(state.members.length, 2);
  assert.equal(await fetchReviewBundle(relay([]), FOREIGN_BUNDLE), null);
  assert.equal(
    await fetchReviewBundle(relay([]), PR_A),
    null,
    "a PR root is not a bundle",
  );
});

test("a saturated status page fails visibly instead of summarising a partial stack", async () => {
  const relayWithStatuses = async (filter) => {
    if (filter.kinds[0] === 1630)
      return Array.from({ length: 200 }, (_, index) =>
        event(1630, AUTHOR, [["e", PR_A]], {
          id: index.toString(16).padStart(64, "0"),
        }),
      );
    return relay([])(filter);
  };
  await assert.rejects(
    fetchReviewBundlesForReviews(relayWithStatuses, [rootA, rootB]),
    /too large for a summary/,
  );
});
