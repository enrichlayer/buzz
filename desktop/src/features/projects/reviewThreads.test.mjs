import assert from "node:assert/strict";
import test from "node:test";
import { eventToProjectPullRequest } from "./projectPullRequests.mjs";
import {
  projectReviewThreads,
  reviewThreadEventInput,
} from "./reviewThreads.ts";
const owner = "a".repeat(64),
  author = "b".repeat(64),
  reviewer = "c".repeat(64),
  attacker = "d".repeat(64);
const repo = `30617:${owner}:review`;
const pr = {
  id: "p".repeat(64),
  kind: 1618,
  pubkey: author,
  content: "Review",
  created_at: 100,
  tags: [
    ["a", repo],
    ["c", "1".repeat(40)],
    ["p", reviewer],
  ],
};
const root = {
  id: "root",
  kind: 1,
  pubkey: reviewer,
  content: "Check this line",
  created_at: 101,
  tags: [
    ["e", pr.id, "", "root"],
    ["a", repo],
    ["c", "1".repeat(40)],
    ["file", "a.ts"],
    ["side", "old"],
    ["line", "2"],
  ],
};
const parse = (events, updates = []) =>
  eventToProjectPullRequest(pr, updates, events);
const operation = (events, options = {}) => {
  const input = reviewThreadEventInput({
    pullRequest: parse(events),
    owner,
    viewer: reviewer,
    threadId: root.id,
    content: "Reply",
    now: 102,
    ...options,
  });
  return {
    id: `op-${events.length}`,
    pubkey: options.viewer ?? reviewer,
    kind: input.kind,
    content: input.content,
    tags: input.tags,
    created_at: input.createdAt,
  };
};
test("production parser and event builder round trip independent threads on the same old-side line", () => {
  const second = { ...root, id: "second" };
  const reply = operation([root, second]);
  const threads = projectReviewThreads(parse([root, second, reply]), owner);
  assert.equal(threads[0].replies[0].content, "Reply");
  assert.equal(threads[1].replies.length, 0);
  assert.deepEqual(
    reply.tags.find((t) => t[3] === "reply"),
    ["e", "root", "", "reply"],
  );
  assert.deepEqual(threads[0].replies[0].anchor, {
    path: "a.ts",
    side: "old",
    line: 2,
  });
});
test("resolve/reopen remains deterministic in one second and never creates approval", () => {
  const resolve = operation([root], { action: "resolve", now: 102 });
  const reopen = operation([root, resolve], { action: "reopen", now: 102 });
  assert.ok(reopen.created_at > resolve.created_at);
  for (const events of [
    [root, resolve, reopen],
    [reopen, root, resolve],
  ]) {
    const parsed = parse(events);
    assert.equal(projectReviewThreads(parsed, owner)[0].resolved, false);
    assert.equal(parsed.approvals.length, 0);
  }
  assert.equal(
    projectReviewThreads(parse([root, resolve]), owner)[0].resolved,
    true,
  );
});
test("unauthorized resolution is rejected on write and ignored on read", () => {
  assert.throws(
    () => operation([root], { action: "resolve", viewer: attacker }),
    /Only the discussion/,
  );
  const forged = {
    ...operation([root], { action: "resolve" }),
    pubkey: attacker,
  };
  assert.equal(
    projectReviewThreads(parse([root, forged]), owner)[0].resolved,
    false,
  );
  for (const viewer of [owner, author, reviewer])
    assert.doesNotThrow(() => operation([root], { action: "resolve", viewer }));
});
test("cross-revision, cross-repository, missing-parent and wrong-side replies do not attach", () => {
  const reply = operation([root]);
  const variants = [
    reply.tags.map((t) => (t[0] === "c" ? ["c", "2".repeat(40)] : t)),
    reply.tags.map((t) => (t[0] === "a" ? ["a", "another-repo"] : t)),
    reply.tags.map((t) =>
      t[3] === "reply" ? ["e", "missing", "", "reply"] : t,
    ),
    reply.tags.map((t) => (t[0] === "side" ? ["side", "new"] : t)),
  ];
  for (const tags of variants)
    assert.equal(
      projectReviewThreads(parse([root, { ...reply, tags }]), owner)[0].replies
        .length,
      0,
    );
});
test("outdated discussions remain replyable and preserve original commit", () => {
  const update = {
    id: "update",
    kind: 1619,
    pubkey: author,
    created_at: 200,
    content: "",
    tags: [
      ["E", pr.id],
      ["c", "2".repeat(40)],
    ],
  };
  const parsed = parse([root], [update]);
  const input = reviewThreadEventInput({
    pullRequest: parsed,
    owner,
    viewer: reviewer,
    threadId: root.id,
    content: "Old context",
    now: 201,
  });
  assert.deepEqual(
    input.tags.find((t) => t[0] === "c"),
    ["c", "1".repeat(40)],
  );
  assert.equal(
    projectReviewThreads(parsed, owner)[0].root.inlineCommentStatus,
    "outdated",
  );
});
test("equal timestamp states use event id ordering independent of input order", () => {
  const resolved = { ...operation([root], { action: "resolve" }), id: "z" };
  const reopened = { ...operation([root], { action: "reopen" }), id: "a" };
  for (const events of [
    [root, resolved, reopened],
    [reopened, resolved, root],
  ])
    assert.equal(projectReviewThreads(parse(events), owner)[0].resolved, true);
});
test("empty replies and missing thread writes fail", () => {
  assert.throws(() => operation([root], { content: "  " }), /empty/);
  assert.throws(() => operation([], {}), /no longer available/);
});

test("a reply cannot borrow a discussion from a different PR root", () => {
  const reply = operation([root]);
  reply.tags = reply.tags.map((tag) =>
    tag[3] === "root" ? ["e", "other-pr", "", "root"] : tag,
  );
  // Referencing this PR as another e tag must not confer root scope.
  reply.tags.push(["e", pr.id, "", "mention"]);
  assert.equal(
    projectReviewThreads(parse([root, reply]), owner)[0].replies.length,
    0,
  );
});

test("mixed discussion and review roles never change authoritative state", () => {
  const labels = [
    "review-request",
    "approval",
    "changes-requested",
    "review-thread-resolve",
    "review-thread-reopen",
  ];
  for (let i = 0; i < labels.length; i++) {
    for (const other of labels.slice(i + 1)) {
      const event = operation([root], { action: "resolve" });
      event.tags = event.tags.filter((tag) => tag[0] !== "t");
      event.tags.push(["t", labels[i]], ["t", other], ["p", attacker]);
      const parsed = parse([root, event]);
      assert.equal(
        projectReviewThreads(parsed, owner)[0].resolved,
        false,
        `${labels[i]} + ${other}`,
      );
      assert.equal(parsed.approvals.length, 0);
      assert.equal(parsed.changeRequests.length, 0);
      assert.equal(
        parsed.comments.find((comment) => comment.id === event.id)
          .isReviewRequest,
        false,
      );
    }
  }
});
