import type { RelayEvent } from "@/shared/api/types";
import type { ProjectPullRequest } from "./projectPullRequests.mjs";
import {
  eventToReviewBundleVerdict,
  verdictCoversHeads,
  type ReviewBundle,
  type ReviewBundleVerdict,
} from "./reviewBundles";
import { projectReviewThreads } from "./reviewThreads";
import { parseSessionLinearIssue } from "./sessionReviewContext";

// The bundle card's view of one jj stack: the signed contract from
// `reviewBundles.ts` joined with each member's pull request state. Trust is
// decided here, once, so the thread card, the project route and the e2e
// fixtures agree on which roots and verdicts count.

export type ReviewBundleMemberRow = {
  /** 1-based stack position, base first. */
  position: number;
  pullRequest: ProjectPullRequest;
  bookmark: string | null;
  /** The member root's own `r … linear-issue` tag; a mirrored root has no session thread. */
  linearIssue: { url: string; id: string } | null;
  /** The GitLab merge request the member mirrors (`r … mirror-of`), when any. */
  mirrorOf: string | null;
  /** Current-head decision on the member by its trusted reviewers. */
  decision: "approved" | "changes-requested" | null;
  /** Unresolved inline-comment threads on the member's current head. */
  openFindings: number;
};

export type ReviewBundleState = {
  bundle: ReviewBundle;
  owner: string;
  members: ReviewBundleMemberRow[];
  /** Latest head-covering verdict per trusted reviewer, oldest first. */
  verdicts: ReviewBundleVerdict[];
  decision: "approved" | "changes-requested" | null;
  /** A trusted verdict exists, but every one of them predates a member push. */
  stale: boolean;
  umbrellaIssue: { url: string; id: string } | null;
};

const HEX64 = /^[0-9a-f]{64}$/;

export function repoOwnerOfAddress(address: string | null | undefined) {
  const owner = (address ?? "").split(":")[1]?.toLowerCase() ?? "";
  return HEX64.test(owner) ? owner : null;
}

function same(a: string, b: string) {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * A bundle root is trusted when its signer may administer every member: the
 * repository owner, or the author of each member pull request. A root signed
 * by anyone else may list someone else's reviews and must drive nothing.
 */
export function isTrustedReviewBundle(
  bundle: Pick<ReviewBundle, "author" | "repository">,
  members: readonly Pick<ProjectPullRequest, "author">[],
) {
  const owner = repoOwnerOfAddress(bundle.repository);
  if (owner && same(bundle.author, owner)) return true;
  return (
    members.length > 0 &&
    members.every((member) => same(member.author, bundle.author))
  );
}

/** Who may approve the bundle: the owner, or a requested reviewer of every member who authored none of them. */
export function canReviewBundle(
  owner: string,
  members: readonly Pick<ProjectPullRequest, "author" | "reviewers">[],
  viewer: string | null | undefined,
) {
  if (!viewer || members.length === 0) return false;
  if (members.some((member) => same(member.author, viewer))) return false;
  if (same(owner, viewer)) return true;
  return members.every((member) =>
    member.reviewers.some((reviewer) => same(reviewer, viewer)),
  );
}

/** Who may request a bundle review: the author or the owner, on every member. */
export function canRequestBundleReview(
  owner: string,
  members: readonly Pick<ProjectPullRequest, "author">[],
  viewer: string | null | undefined,
) {
  if (!viewer || members.length === 0) return false;
  if (same(owner, viewer)) return true;
  return members.every((member) => same(member.author, viewer));
}

function memberDecision(pullRequest: ProjectPullRequest) {
  if (pullRequest.changeRequests.length > 0) return "changes-requested";
  if (pullRequest.approvals.length > 0) return "approved";
  return null;
}

function openFindings(pullRequest: ProjectPullRequest, owner: string) {
  return projectReviewThreads(pullRequest, owner).filter(
    (thread) =>
      thread.root.isInlineComment &&
      thread.root.inlineCommentStatus === "current" &&
      !thread.resolved,
  ).length;
}

function later(a: ReviewBundleVerdict, b: ReviewBundleVerdict) {
  return (
    a.createdAt > b.createdAt || (a.createdAt === b.createdAt && a.id > b.id)
  );
}

/**
 * Join a trusted bundle root with its members and verdicts. Null when a
 * member is missing, sits in another repository, or the root's signer may
 * not administer the members.
 */
export function reviewBundleState(
  bundle: ReviewBundle,
  pullRequests: ReadonlyMap<string, ProjectPullRequest>,
  verdictEvents: readonly RelayEvent[],
): ReviewBundleState | null {
  const owner = repoOwnerOfAddress(bundle.repository);
  if (!owner) return null;
  const members: ProjectPullRequest[] = [];
  for (const member of bundle.members) {
    const pullRequest = pullRequests.get(member.pullRequest);
    if (!pullRequest || pullRequest.repoAddress !== bundle.repository)
      return null;
    members.push(pullRequest);
  }
  if (!isTrustedReviewBundle(bundle, members)) return null;
  const heads = new Map<string, string>();
  for (const member of members)
    if (member.commit) heads.set(member.id, member.commit);
  const latestByReviewer = new Map<string, ReviewBundleVerdict>();
  for (const event of verdictEvents) {
    const verdict = eventToReviewBundleVerdict(event);
    if (
      !verdict ||
      verdict.bundle !== bundle.id ||
      verdict.repository !== bundle.repository ||
      !canReviewBundle(owner, members, verdict.author)
    )
      continue;
    const key = verdict.author.toLowerCase();
    const previous = latestByReviewer.get(key);
    if (!previous || later(verdict, previous))
      latestByReviewer.set(key, verdict);
  }
  const covering = [...latestByReviewer.values()]
    .filter((verdict) => verdictCoversHeads(bundle, verdict, heads))
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return {
    bundle,
    owner,
    members: members.map((pullRequest, index) => ({
      position: index + 1,
      pullRequest,
      bookmark: bundle.members[index].bookmark,
      linearIssue: pullRequest.linearIssue,
      mirrorOf: pullRequest.mirrorOf,
      decision: memberDecision(pullRequest),
      openFindings: openFindings(pullRequest, owner),
    })),
    verdicts: covering,
    decision: covering.some(
      (verdict) => verdict.decision === "changes-requested",
    )
      ? "changes-requested"
      : covering.length > 0
        ? "approved"
        : null,
    stale: latestByReviewer.size > 0 && covering.length === 0,
    umbrellaIssue: bundle.linearIssue
      ? parseSessionLinearIssue(bundle.linearIssue)
      : null,
  };
}
