import assert from "node:assert/strict";
import test from "node:test";
import { eventToProjectPullRequest } from "./projectPullRequests.mjs";
import {
  BUNDLE_APPROVAL_LABEL,
  BUNDLE_CHANGES_REQUESTED_LABEL,
  BUNDLE_MEMBER_MARKER,
  REVIEW_BUNDLE_LABEL,
  eventToReviewBundle,
} from "./reviewBundles.ts";
import {
  canRequestBundleReview,
  canReviewBundle,
  isTrustedReviewBundle,
  reviewBundleState,
} from "./reviewBundleState.ts";

const OWNER = "a".repeat(64);
const AUTHOR = "b".repeat(64);
const REVIEWER = "c".repeat(64);
const STRANGER = "d".repeat(64);
const PR_A = "1".repeat(64);
const PR_B = "2".repeat(64);
const HEAD_A = "3".repeat(40);
const HEAD_B = "4".repeat(40);
const BUNDLE = "5".repeat(64);
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

function prRoot(id, head, extra = []) {
  return event(
    1618,
    AUTHOR,
    [
      ["a", REPO],
      ["subject", `PR ${id.slice(0, 1)}`],
      ["c", head],
      ["p", REVIEWER],
      ["r", "https://linear.app/acme/issue/DEV-1", "linear-issue"],
      ["r", "https://gitlab.com/acme/tools/-/merge_requests/7", "mirror-of"],
      ...extra,
    ],
    { id },
  );
}

function bundleRoot(pubkey = AUTHOR) {
  return eventToReviewBundle(
    event(
      1,
      pubkey,
      [
        ["a", REPO],
        ["subject", "DEV-1 stack"],
        ["t", REVIEW_BUNDLE_LABEL],
        ["e", PR_A, "", BUNDLE_MEMBER_MARKER],
        ["bookmark", PR_A, "feature/a"],
        ["e", PR_B, "", BUNDLE_MEMBER_MARKER],
        ["p", REVIEWER],
        ["r", "https://linear.app/acme/issue/DEV-9", "linear-issue"],
      ],
      { id: BUNDLE },
    ),
  );
}

function verdict(pubkey, label, heads) {
  return event(1, pubkey, [
    ["e", BUNDLE, "", "root"],
    ["a", REPO],
    ["t", label],
    ...heads.map(([pr, commit]) => ["member-head", pr, commit]),
  ]);
}

function inlineComment(pr, head, pubkey = REVIEWER) {
  return event(1, pubkey, [
    ["e", pr, "", "root"],
    ["a", REPO],
    ["c", head],
    ["file", "src/a.ts"],
    ["side", "new"],
    ["line", "3"],
    ["t", "inline-comment"],
  ]);
}

function pullRequests(comments = []) {
  const roots = [prRoot(PR_A, HEAD_A), prRoot(PR_B, HEAD_B)];
  return new Map(
    roots.map((root) => [
      root.id,
      eventToProjectPullRequest(root, [], comments, []),
    ]),
  );
}

test("member rows carry the root's own Linear issue and mirror, in stack order", () => {
  const state = reviewBundleState(bundleRoot(), pullRequests(), []);
  assert.ok(state);
  assert.equal(state.owner, OWNER);
  assert.deepEqual(
    state.members.map((row) => [
      row.position,
      row.pullRequest.id,
      row.bookmark,
    ]),
    [
      [1, PR_A, "feature/a"],
      [2, PR_B, null],
    ],
  );
  assert.deepEqual(state.members[0].linearIssue, {
    url: "https://linear.app/acme/issue/DEV-1",
    id: "DEV-1",
  });
  assert.equal(
    state.members[0].mirrorOf,
    "https://gitlab.com/acme/tools/-/merge_requests/7",
  );
  assert.deepEqual(state.umbrellaIssue, {
    url: "https://linear.app/acme/issue/DEV-9",
    id: "DEV-9",
  });
  assert.equal(state.decision, null);
  assert.equal(state.stale, false);
  const bare = eventToProjectPullRequest(
    prRoot(PR_A, HEAD_A, [["r", "ftp://x", "mirror-of"]]),
    [],
    [],
    [],
  );
  assert.equal(bare.linearIssue?.id, "DEV-1");
  // The last `r … mirror-of` is a non-https scheme; the first one wins and is kept.
  assert.equal(
    bare.mirrorOf,
    "https://gitlab.com/acme/tools/-/merge_requests/7",
  );
  const plain = eventToProjectPullRequest(
    event(1618, AUTHOR, [
      ["a", REPO],
      ["subject", "x"],
      ["r", "ftp://x", "mirror-of"],
    ]),
    [],
    [],
    [],
  );
  assert.equal(plain.linearIssue, null);
  assert.equal(plain.mirrorOf, null);
});

test("a root signed by a stranger, or over a foreign member, is not a bundle", () => {
  assert.equal(
    reviewBundleState(bundleRoot(STRANGER), pullRequests(), []),
    null,
  );
  const foreign = pullRequests();
  foreign.set(PR_B, {
    ...foreign.get(PR_B),
    repoAddress: `30617:${OWNER}:other`,
  });
  assert.equal(reviewBundleState(bundleRoot(), foreign, []), null);
  const partial = pullRequests();
  partial.delete(PR_B);
  assert.equal(reviewBundleState(bundleRoot(), partial, []), null);
  assert.ok(reviewBundleState(bundleRoot(OWNER), pullRequests(), []));
  assert.equal(
    isTrustedReviewBundle({ author: STRANGER, repository: REPO }, [
      { author: AUTHOR },
    ]),
    false,
  );
});

test("the bundle decision keeps the latest covering verdict per trusted reviewer", () => {
  const state = reviewBundleState(bundleRoot(), pullRequests(), [
    verdict(REVIEWER, BUNDLE_CHANGES_REQUESTED_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, HEAD_B],
    ]),
    verdict(REVIEWER, BUNDLE_APPROVAL_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, HEAD_B],
    ]),
    // A stranger's verdict and the author's own verdict never count.
    verdict(STRANGER, BUNDLE_CHANGES_REQUESTED_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, HEAD_B],
    ]),
    verdict(AUTHOR, BUNDLE_APPROVAL_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, HEAD_B],
    ]),
  ]);
  assert.equal(state.decision, "approved");
  assert.equal(state.verdicts.length, 1);
  assert.equal(state.verdicts[0].author, REVIEWER);
  const owner = reviewBundleState(bundleRoot(), pullRequests(), [
    verdict(OWNER, BUNDLE_CHANGES_REQUESTED_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, HEAD_B],
    ]),
  ]);
  assert.equal(owner.decision, "changes-requested");
});

test("a verdict over a partial stack or a moved head is stale, not current", () => {
  const partial = reviewBundleState(bundleRoot(), pullRequests(), [
    verdict(REVIEWER, BUNDLE_APPROVAL_LABEL, [[PR_A, HEAD_A]]),
  ]);
  assert.equal(partial.decision, null);
  assert.equal(partial.stale, true);
  const moved = reviewBundleState(bundleRoot(), pullRequests(), [
    verdict(REVIEWER, BUNDLE_APPROVAL_LABEL, [
      [PR_A, HEAD_A],
      [PR_B, "9".repeat(40)],
    ]),
  ]);
  assert.equal(moved.decision, null);
  assert.equal(moved.stale, true);
});

test("open findings count unresolved inline threads on the current head only", () => {
  const current = inlineComment(PR_A, HEAD_A);
  const resolved = inlineComment(PR_A, HEAD_A);
  const resolve = event(1, REVIEWER, [
    ["e", PR_A, "", "root"],
    ["e", resolved.id, "", "reply"],
    ["a", REPO],
    ["c", HEAD_A],
    ["file", "src/a.ts"],
    ["side", "new"],
    ["line", "3"],
    ["t", "review-thread-resolve"],
  ]);
  const outdated = inlineComment(PR_A, "8".repeat(40));
  const plain = event(1, REVIEWER, [
    ["e", PR_A, "", "root"],
    ["a", REPO],
  ]);
  const approval = event(1, REVIEWER, [
    ["e", PR_B, "", "root"],
    ["a", REPO],
    ["c", HEAD_B],
    ["t", "approval"],
  ]);
  const state = reviewBundleState(
    bundleRoot(),
    pullRequests([current, resolved, resolve, outdated, plain, approval]),
    [],
  );
  assert.deepEqual(
    state.members.map((row) => [row.openFindings, row.decision]),
    [
      [1, null],
      [0, "approved"],
    ],
  );
});

test("review and request permissions are decided across every member", () => {
  const members = [...pullRequests().values()];
  assert.equal(canReviewBundle(OWNER, members, REVIEWER), true);
  assert.equal(canReviewBundle(OWNER, members, OWNER), true);
  assert.equal(canReviewBundle(OWNER, members, AUTHOR), false);
  assert.equal(canReviewBundle(OWNER, members, STRANGER), false);
  assert.equal(canReviewBundle(OWNER, members, null), false);
  const mixed = [members[0], { ...members[1], reviewers: [] }];
  assert.equal(canReviewBundle(OWNER, mixed, REVIEWER), false);
  assert.equal(canRequestBundleReview(OWNER, members, AUTHOR), true);
  assert.equal(canRequestBundleReview(OWNER, members, OWNER), true);
  assert.equal(canRequestBundleReview(OWNER, members, REVIEWER), false);
  assert.equal(
    canRequestBundleReview(
      OWNER,
      [members[0], { ...members[1], author: STRANGER }],
      AUTHOR,
    ),
    false,
  );
});
