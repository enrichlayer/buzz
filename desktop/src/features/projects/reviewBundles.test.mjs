import assert from "node:assert/strict";
import test from "node:test";
import {
  BUNDLE_APPROVAL_LABEL,
  BUNDLE_MEMBER_MARKER,
  BUNDLE_MEMBER_VERDICT_MARKER,
  REVIEW_BUNDLE_LABEL,
  eventToReviewBundle,
  eventToReviewBundleVerdict,
  verdictCoversHeads,
} from "./reviewBundles.ts";

const OWNER = "a".repeat(64);
const REVIEWER = "b".repeat(64);
const PR_A = "1".repeat(64);
const PR_B = "2".repeat(64);
const HEAD_A = "3".repeat(40);
const HEAD_B = "4".repeat(40);
const REPO = `30617:${OWNER}:demo`;

function note(tags, overrides = {}) {
  return {
    id: "e".repeat(64),
    pubkey: OWNER,
    kind: 1,
    created_at: 1_700_000_000,
    content: "",
    sig: "",
    tags,
    ...overrides,
  };
}

function bundleRoot(extra = [], overrides = {}) {
  return note(
    [
      ["a", REPO],
      ["subject", "DEV-14335 stack acceptance"],
      ["t", REVIEW_BUNDLE_LABEL],
      ["e", PR_A, "", BUNDLE_MEMBER_MARKER],
      ["bookmark", PR_A, "feature/DEV-14335-stack-acceptance-a"],
      ["e", PR_B, "", BUNDLE_MEMBER_MARKER],
      ["p", OWNER],
      ["p", REVIEWER],
      ["workspace", "e0241e0e"],
      ["r", "https://linear.app/verticalint/issue/DEV-14335/"],
      ...extra,
    ],
    overrides,
  );
}

test("a bundle root keeps member order, bookmarks and context", () => {
  const bundle = eventToReviewBundle(bundleRoot());
  assert.ok(bundle);
  assert.equal(bundle.subject, "DEV-14335 stack acceptance");
  assert.equal(bundle.repository, REPO);
  assert.deepEqual(bundle.members, [
    { pullRequest: PR_A, bookmark: "feature/DEV-14335-stack-acceptance-a" },
    { pullRequest: PR_B, bookmark: null },
  ]);
  assert.deepEqual(bundle.reviewers, [OWNER, REVIEWER]);
  assert.equal(bundle.workspace, "e0241e0e");
  assert.equal(
    bundle.linearIssue,
    "https://linear.app/verticalint/issue/DEV-14335/",
  );
});

test("a bundle root needs exactly one role label and two distinct members", () => {
  assert.equal(eventToReviewBundle(bundleRoot([["t", "approval"]])), null);
  assert.equal(
    eventToReviewBundle(bundleRoot([["e", PR_A, "", BUNDLE_MEMBER_MARKER]])),
    null,
  );
  const single = note([
    ["a", REPO],
    ["subject", "one"],
    ["t", REVIEW_BUNDLE_LABEL],
    ["e", PR_A, "", BUNDLE_MEMBER_MARKER],
  ]);
  assert.equal(eventToReviewBundle(single), null);
  assert.equal(eventToReviewBundle(bundleRoot([], { kind: 1618 })), null);
  // A bookmark for a pull request outside the bundle is malformed, not ignored.
  assert.equal(
    eventToReviewBundle(bundleRoot([["bookmark", "f".repeat(64), "x"]])),
    null,
  );
});

test("a verdict pins every member head and names member verdicts", () => {
  const verdict = eventToReviewBundleVerdict(
    note(
      [
        ["e", "e".repeat(64), "", "root"],
        ["a", REPO],
        ["p", OWNER],
        ["t", BUNDLE_APPROVAL_LABEL],
        ["member-head", PR_A, HEAD_A.toUpperCase()],
        ["member-head", PR_B, HEAD_B],
        ["e", "c".repeat(64), "", BUNDLE_MEMBER_VERDICT_MARKER],
      ],
      { pubkey: REVIEWER },
    ),
  );
  assert.ok(verdict);
  assert.equal(verdict.decision, "approval");
  assert.equal(verdict.author, REVIEWER);
  assert.deepEqual(verdict.memberHeads, [
    { pullRequest: PR_A, commit: HEAD_A },
    { pullRequest: PR_B, commit: HEAD_B },
  ]);
  assert.deepEqual(verdict.memberVerdicts, ["c".repeat(64)]);
  const heads = new Map([
    [PR_A, HEAD_A],
    [PR_B, HEAD_B],
  ]);
  assert.equal(verdictCoversHeads(verdict, heads), true);
  heads.set(PR_B, "5".repeat(40));
  assert.equal(verdictCoversHeads(verdict, heads), false);
});

test("a verdict without a root, heads or a single role is rejected", () => {
  const base = [
    ["a", REPO],
    ["t", BUNDLE_APPROVAL_LABEL],
    ["member-head", PR_A, HEAD_A],
  ];
  assert.equal(eventToReviewBundleVerdict(note(base)), null);
  assert.equal(
    eventToReviewBundleVerdict(
      note([
        ["e", "e".repeat(64), "", "root"],
        ["a", REPO],
        ["t", BUNDLE_APPROVAL_LABEL],
      ]),
    ),
    null,
  );
  assert.equal(
    eventToReviewBundleVerdict(
      note([
        ["e", "e".repeat(64), "", "root"],
        ...base,
        ["t", "bundle-changes-requested"],
      ]),
    ),
    null,
  );
  assert.equal(
    eventToReviewBundleVerdict(
      note([
        ["e", "e".repeat(64), "", "root"],
        ...base,
        ["member-head", PR_A, HEAD_B],
      ]),
    ),
    null,
  );
});
