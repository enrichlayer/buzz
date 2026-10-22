import type { RelayEvent } from "@/shared/api/types";
import { getAllTags, getTag } from "./projectIssues.mjs";
import {
  PR_APPROVAL_LABEL,
  PR_CHANGES_REQUESTED_LABEL,
  PR_REVIEW_REQUEST_LABEL,
} from "./projectPullRequests.mjs";

// A review bundle is the Buzz identity of one jj stack: several related pull
// requests authored together in one workspace and reviewed as a unit. The
// bundle root and its verdicts are kind:1 notes labeled with a `t` tag, the
// same convention as review requests and approvals, so any client reads them
// as ordinary comments. `crates/buzz-cli/src/commands/pr_bundle.rs` emits
// these notes; this module is the desktop's mirror of that contract.
export const REVIEW_BUNDLE_LABEL = "review-bundle";
export const BUNDLE_APPROVAL_LABEL = "bundle-approval";
export const BUNDLE_CHANGES_REQUESTED_LABEL = "bundle-changes-requested";
export const BUNDLE_MEMBER_MARKER = "bundle-member";
export const BUNDLE_MEMBER_VERDICT_MARKER = "member-verdict";

const HEX64 = /^[0-9a-f]{64}$/;
// Full git object ids, SHA-1 or SHA-256, kept exactly as the pull request
// carries them: the desktop compares a verdict's commit with the PR's exactly.
const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

// One signed note has one authoritative semantic role, the same rule
// `eventToPullRequestComment` applies; unknown labels stay harmless.
const ROLE_LABELS = [
  REVIEW_BUNDLE_LABEL,
  BUNDLE_APPROVAL_LABEL,
  BUNDLE_CHANGES_REQUESTED_LABEL,
  PR_REVIEW_REQUEST_LABEL,
  PR_APPROVAL_LABEL,
  PR_CHANGES_REQUESTED_LABEL,
  "review-thread-resolve",
  "review-thread-reopen",
];

export type ReviewBundleMember = {
  /** Kind 1618 pull request event id, in stack order (base first). */
  pullRequest: string;
  /** jj bookmark the member was pushed from, when the author recorded it. */
  bookmark: string | null;
};

export type ReviewBundle = {
  id: string;
  author: string;
  createdAt: number;
  subject: string;
  /** Repository `a` address (`30617:<owner>:<d>`). */
  repository: string;
  members: ReviewBundleMember[];
  /**
   * Pubkeys the root notifies (`p` tags: the repo owner and the reviewers the
   * author asked for). Who may approve a member is decided per member by
   * `projectPullRequests` (the repo owner or that member's requested
   * reviewers), never by this list.
   */
  recipients: string[];
  /** Factory workspace that holds the stack, when recorded. */
  workspace: string | null;
  /** Linear issue URL from the `r … linear-issue` tag, when recorded. */
  linearIssue: string | null;
};

export type ReviewBundleVerdict = {
  id: string;
  author: string;
  createdAt: number;
  bundle: string;
  repository: string;
  decision: "approval" | "changes-requested";
  /** The exact member heads the verdict covers; a later push invalidates it. */
  memberHeads: { pullRequest: string; commit: string }[];
  /** Per-member verdict notes the reviewer posted on the member PRs. */
  memberVerdicts: string[];
};

function lowerHex(value: string | undefined, pattern: RegExp): string | null {
  if (typeof value !== "string") return null;
  const lower = value.toLowerCase();
  return pattern.test(lower) ? lower : null;
}

function roleLabel(event: RelayEvent): string | null {
  const roles = getAllTags(event, "t")
    .map((label) => label.toLowerCase())
    .filter((label) => ROLE_LABELS.includes(label));
  return roles.length === 1 ? roles[0] : null;
}

/** `undefined` when absent, `null` when present but malformed (the note is rejected). */
function linearIssueUrl(event: RelayEvent): string | null | undefined {
  const tag = event.tags.find(
    (item) => item[0] === "r" && item[2] === "linear-issue",
  );
  if (!tag) return undefined;
  if (typeof tag[1] !== "string") return null;
  try {
    const url = new URL(tag[1]);
    return url.protocol === "https:" && url.host === "linear.app"
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Parse a bundle root note; null when the event is not a well-formed bundle. */
export function eventToReviewBundle(event: RelayEvent): ReviewBundle | null {
  if (event.kind !== 1) return null;
  if (roleLabel(event) !== REVIEW_BUNDLE_LABEL) return null;
  const repository = getTag(event, "a");
  const subject = getTag(event, "subject")?.trim();
  if (!repository || !subject) return null;
  const members: ReviewBundleMember[] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "e" || tag[3] !== BUNDLE_MEMBER_MARKER) continue;
    const pullRequest = lowerHex(tag[1], HEX64);
    if (!pullRequest || seen.has(pullRequest)) return null;
    seen.add(pullRequest);
    members.push({ pullRequest, bookmark: null });
  }
  if (members.length < 2) return null;
  for (const tag of event.tags) {
    if (tag[0] !== "bookmark") continue;
    const pullRequest = lowerHex(tag[1], HEX64);
    const member = members.find((item) => item.pullRequest === pullRequest);
    if (!member || typeof tag[2] !== "string" || !tag[2]) return null;
    member.bookmark = tag[2];
  }
  // Malformed tags reject the note rather than being skipped, the policy the
  // member and member-head tags follow above.
  const recipients: string[] = [];
  for (const pubkey of getAllTags(event, "p")) {
    const lower = lowerHex(pubkey, HEX64);
    if (!lower) return null;
    if (!recipients.includes(lower)) recipients.push(lower);
  }
  const workspace = getTag(event, "workspace") ?? null;
  if (workspace !== null && (!workspace || /\s/.test(workspace))) return null;
  const linearIssue = linearIssueUrl(event);
  if (linearIssue === null) return null;
  return {
    id: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    subject,
    repository,
    members,
    recipients,
    workspace,
    linearIssue: linearIssue ?? null,
  };
}

/** Parse a bundle verdict note; null when it is not a well-formed verdict. */
export function eventToReviewBundleVerdict(
  event: RelayEvent,
): ReviewBundleVerdict | null {
  if (event.kind !== 1) return null;
  const role = roleLabel(event);
  const decision =
    role === BUNDLE_APPROVAL_LABEL
      ? "approval"
      : role === BUNDLE_CHANGES_REQUESTED_LABEL
        ? "changes-requested"
        : null;
  if (!decision) return null;
  const root = event.tags.find((tag) => tag[0] === "e" && tag[3] === "root");
  const bundle = lowerHex(root?.[1], HEX64);
  const repository = getTag(event, "a");
  if (!bundle || !repository) return null;
  const memberHeads: ReviewBundleVerdict["memberHeads"] = [];
  const seen = new Set<string>();
  for (const tag of event.tags) {
    if (tag[0] !== "member-head") continue;
    const pullRequest = lowerHex(tag[1], HEX64);
    const commit =
      typeof tag[2] === "string" && COMMIT.test(tag[2]) ? tag[2] : null;
    if (!pullRequest || !commit || seen.has(pullRequest)) return null;
    seen.add(pullRequest);
    memberHeads.push({ pullRequest, commit });
  }
  if (memberHeads.length === 0) return null;
  const memberVerdicts: string[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== "e" || tag[3] !== BUNDLE_MEMBER_VERDICT_MARKER) continue;
    const id = lowerHex(tag[1], HEX64);
    if (!id) return null;
    memberVerdicts.push(id);
  }
  return {
    id: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    bundle,
    repository,
    decision,
    memberHeads,
    memberVerdicts,
  };
}

/**
 * A verdict covers a bundle only while it pins every member of that bundle,
 * pins nothing outside it, and every pinned member still sits at the head it
 * reviewed. A member pushed after the verdict, or a verdict over a partial
 * stack, needs a new verdict.
 */
export function verdictCoversHeads(
  bundle: ReviewBundle,
  verdict: ReviewBundleVerdict,
  heads: ReadonlyMap<string, string>,
): boolean {
  if (verdict.bundle !== bundle.id) return false;
  const pinned = new Map(
    verdict.memberHeads.map((member) => [member.pullRequest, member.commit]),
  );
  if (pinned.size !== bundle.members.length) return false;
  return bundle.members.every((member) => {
    const commit = pinned.get(member.pullRequest);
    return commit !== undefined && heads.get(member.pullRequest) === commit;
  });
}
