import type { RelayEvent } from "@/shared/api/types";
import { getAllTags, getTag } from "./projectIssues.mjs";

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
const HEX40 = /^[0-9a-f]{40}$/;

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
  reviewers: string[];
  /** Factory workspace that holds the stack, when recorded. */
  workspace: string | null;
  /** Linear issue URL from the `r` tag, when recorded. */
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

function labels(event: RelayEvent): string[] {
  return getAllTags(event, "t").map((label) => label.toLowerCase());
}

/** Parse a bundle root note; null when the event is not a well-formed bundle. */
export function eventToReviewBundle(event: RelayEvent): ReviewBundle | null {
  if (event.kind !== 1) return null;
  // One signed note has one semantic role, as for PR review labels.
  const roles = labels(event);
  if (roles.length !== 1 || roles[0] !== REVIEW_BUNDLE_LABEL) return null;
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
  const reviewers = [
    ...new Set(
      getAllTags(event, "p")
        .map((pubkey) => lowerHex(pubkey, HEX64))
        .filter((pubkey): pubkey is string => pubkey !== null),
    ),
  ];
  return {
    id: event.id,
    author: event.pubkey,
    createdAt: event.created_at,
    subject,
    repository,
    members,
    reviewers,
    workspace: getTag(event, "workspace") ?? null,
    linearIssue: getTag(event, "r") ?? null,
  };
}

/** Parse a bundle verdict note; null when it is not a well-formed verdict. */
export function eventToReviewBundleVerdict(
  event: RelayEvent,
): ReviewBundleVerdict | null {
  if (event.kind !== 1) return null;
  const roles = labels(event);
  if (roles.length !== 1) return null;
  const decision =
    roles[0] === BUNDLE_APPROVAL_LABEL
      ? "approval"
      : roles[0] === BUNDLE_CHANGES_REQUESTED_LABEL
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
    const commit = lowerHex(tag[2], HEX40);
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
 * A verdict is current only while every member it pinned still sits at the
 * head it reviewed. A bundle member pushed after the verdict needs a new one.
 */
export function verdictCoversHeads(
  verdict: ReviewBundleVerdict,
  heads: ReadonlyMap<string, string>,
): boolean {
  return verdict.memberHeads.every(
    (member) => heads.get(member.pullRequest)?.toLowerCase() === member.commit,
  );
}
