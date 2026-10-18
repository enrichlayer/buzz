import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import type {
  ProjectPullRequest,
  ProjectPullRequestComment,
} from "./projectPullRequests.mjs";

export type ReviewThread = {
  root: ProjectPullRequestComment;
  replies: ProjectPullRequestComment[];
  resolved: boolean;
  stateEvent: ProjectPullRequestComment | null;
};

/** Only the discussion starter, review author, or repository owner controls resolution. */
export function canResolveReviewThread(
  viewer: string | null | undefined,
  owner: string,
  author: string,
  root: ProjectPullRequestComment,
) {
  return Boolean(
    viewer &&
      [owner, author, root.author].some(
        (actor) => actor.toLowerCase() === viewer.toLowerCase(),
      ),
  );
}

/** Materialize flat, root-addressed replies without recursion or cross-review/revision attachment. */
export function projectReviewThreads(
  pullRequest: ProjectPullRequest,
  owner: string,
): ReviewThread[] {
  const roots = pullRequest.comments.filter(
    (comment) =>
      !comment.replyTo &&
      !comment.threadAction &&
      !comment.isReviewRequest &&
      !comment.isApproval,
  );
  const byRoot = new Map(
    roots.map((root) => [
      root.id,
      { root, replies: [], resolved: false, stateEvent: null } as ReviewThread,
    ]),
  );
  for (const comment of pullRequest.comments) {
    const thread = comment.replyTo ? byRoot.get(comment.replyTo) : undefined;
    if (
      !thread ||
      comment.repoAddress !== pullRequest.repoAddress ||
      comment.commit !== thread.root.commit
    )
      continue;
    if (JSON.stringify(comment.anchor) !== JSON.stringify(thread.root.anchor))
      continue;
    if (comment.threadAction) {
      if (
        !canResolveReviewThread(
          comment.author,
          owner,
          pullRequest.author,
          thread.root,
        )
      )
        continue;
      const previous = thread.stateEvent;
      if (
        !previous ||
        comment.createdAt > previous.createdAt ||
        (comment.createdAt === previous.createdAt && comment.id > previous.id)
      ) {
        thread.stateEvent = comment;
        thread.resolved = comment.threadAction === "resolve";
      }
    } else if (!comment.isReviewRequest && !comment.reviewDecision)
      thread.replies.push(comment);
  }
  for (const thread of byRoot.values())
    thread.replies.sort(
      (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
  return [...byRoot.values()];
}

/** Reply and status events keep the PR root for existing history queries and a separate reply marker. */
export function reviewThreadEventInput({
  pullRequest,
  owner,
  viewer,
  threadId,
  content,
  action,
  now,
}: {
  pullRequest: ProjectPullRequest;
  owner: string;
  viewer: string;
  threadId: string;
  content?: string;
  action?: "resolve" | "reopen";
  now: number;
}) {
  const thread = projectReviewThreads(pullRequest, owner).find(
    (item) => item.root.id === threadId,
  );
  if (!thread)
    throw new Error(
      "This discussion is no longer available. Refresh the review.",
    );
  if (
    action &&
    !canResolveReviewThread(viewer, owner, pullRequest.author, thread.root)
  )
    throw new Error(
      "Only the discussion starter, review author, or repository owner can resolve or reopen it.",
    );
  const body = action
    ? action === "resolve"
      ? "Resolved this discussion."
      : "Reopened this discussion."
    : content?.trim();
  if (!body) throw new Error("Reply cannot be empty.");
  if (body.length > 60_000) throw new Error("Reply is too long.");
  const anchor = thread.root.anchor;
  return {
    kind: KIND_TEXT_NOTE,
    content: body,
    createdAt: Math.max(
      now,
      (thread.stateEvent?.createdAt ?? thread.root.createdAt) + 1,
    ),
    tags: [
      ["e", pullRequest.id, "", "root"],
      ["e", thread.root.id, "", "reply"],
      ["a", pullRequest.repoAddress ?? ""],
      ...[...new Set([owner, pullRequest.author, thread.root.author])].map(
        (pubkey) => ["p", pubkey],
      ),
      ...(thread.root.commit ? [["c", thread.root.commit]] : []),
      ...(anchor
        ? [
            ["t", "inline-comment"],
            ["file", anchor.path],
            ["side", anchor.side],
            ["line", String(anchor.line)],
          ]
        : []),
      ...(action ? [["t", `review-thread-${action}`]] : []),
    ],
  };
}
