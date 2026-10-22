import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { allowedActorsForRoot } from "./projectIssues.mjs";
import { eventToProjectPullRequest } from "./projectPullRequests.mjs";
import {
  fetchCompleteReviewEvents,
  fetchTrustedReviewUpdates,
} from "./projectReviewFetch";
import { eventToReviewBundle, type ReviewBundle } from "./reviewBundles";
import { reviewBundleState, type ReviewBundleState } from "./reviewBundleState";

type FetchEvents = (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
const STATUS_LIMIT = 200;

/**
 * Bundles that list any of the given pull request roots, with their complete
 * member state. A thread finds its stack this way: the bundle root carries no
 * `h` or session tag, only `bundle-member` references to the members.
 */
export async function fetchReviewBundlesForReviews(
  fetchEvents: FetchEvents,
  roots: readonly RelayEvent[],
  signal?: AbortSignal,
): Promise<ReviewBundleState[]> {
  if (!roots.length) return [];
  const notes = await fetchCompleteReviewEvents(
    { kinds: [1], "#e": roots.map((root) => root.id) },
    fetchEvents,
    signal,
  );
  const bundles = new Map<string, ReviewBundle>();
  for (const note of notes) {
    const bundle = eventToReviewBundle(note);
    if (bundle) bundles.set(bundle.id, bundle);
  }
  return assembleBundles(fetchEvents, [...bundles.values()], roots, signal);
}

/** One bundle by root id (a `buzz://bundle` link), or null when the relay holds no trusted bundle under it. */
export async function fetchReviewBundle(
  fetchEvents: FetchEvents,
  bundleId: string,
  signal?: AbortSignal,
): Promise<ReviewBundleState | null> {
  const id = bundleId.toLowerCase();
  const events = await fetchEvents({ kinds: [1], ids: [id], limit: 1 });
  const root = events.find((event) => event.id === id);
  const bundle = root ? eventToReviewBundle(root) : null;
  if (!bundle) return null;
  const states = await assembleBundles(fetchEvents, [bundle], [], signal);
  return states[0] ?? null;
}

async function assembleBundles(
  fetchEvents: FetchEvents,
  bundles: ReviewBundle[],
  knownRoots: readonly RelayEvent[],
  signal?: AbortSignal,
): Promise<ReviewBundleState[]> {
  if (!bundles.length) return [];
  const roots = new Map(knownRoots.map((root) => [root.id, root]));
  const missing = [
    ...new Set(
      bundles
        .flatMap((bundle) => bundle.members.map((member) => member.pullRequest))
        .filter((id) => !roots.has(id)),
    ),
  ];
  if (missing.length) {
    // `ids` is pushed into SQL, so one page proves which members exist.
    const fetched = await fetchEvents({
      kinds: [1618],
      ids: missing,
      limit: missing.length,
    });
    signal?.throwIfAborted();
    for (const root of fetched)
      if (root.kind === 1618) roots.set(root.id, root);
  }
  // A bundle whose members are unknown, live in another repository, or were
  // not authored by someone the root's signer may speak for is dropped here,
  // before any member history is fetched on its behalf.
  const complete = bundles.filter((bundle) =>
    bundle.members.every((member) => {
      const root = roots.get(member.pullRequest);
      return Boolean(
        root?.tags.some(
          (tag) => tag[0] === "a" && tag[1] === bundle.repository,
        ) && trustedSigner(bundle, root),
      );
    }),
  );
  if (!complete.length) return [];
  const memberRoots = [
    ...new Map(
      complete
        .flatMap((bundle) => bundle.members)
        .flatMap((member) => {
          const root = roots.get(member.pullRequest);
          return root ? [[member.pullRequest, root] as const] : [];
        }),
    ).values(),
  ];
  const memberIds = memberRoots.map((root) => root.id);
  const [updates, statuses, comments, verdicts] = await Promise.all([
    fetchTrustedReviewUpdates(memberRoots, fetchEvents, signal),
    fetchEvents({
      kinds: [1630, 1631, 1632, 1633],
      "#e": memberIds,
      limit: STATUS_LIMIT,
    }),
    fetchCompleteReviewEvents(
      { kinds: [1], "#e": memberIds },
      fetchEvents,
      signal,
    ),
    fetchCompleteReviewEvents(
      { kinds: [1], "#e": complete.map((bundle) => bundle.id) },
      fetchEvents,
      signal,
    ),
  ]);
  if (statuses.length >= STATUS_LIMIT)
    throw new Error(
      "This stack's review history is too large for a summary. Open Projects for the full review.",
    );
  const pullRequests = new Map(
    memberRoots.map((root) => [
      root.id,
      eventToProjectPullRequest(root, updates, comments, statuses),
    ]),
  );
  return complete
    .map((bundle) => reviewBundleState(bundle, pullRequests, verdicts))
    .filter((state): state is ReviewBundleState => state !== null)
    .sort((a, b) => b.bundle.createdAt - a.bundle.createdAt);
}

function trustedSigner(bundle: ReviewBundle, memberRoot: RelayEvent) {
  return allowedActorsForRoot(memberRoot).has(bundle.author.toLowerCase());
}
