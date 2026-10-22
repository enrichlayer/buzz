import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import {
  eventToProjectPullRequest,
  type ProjectPullRequest,
} from "./projectPullRequests.mjs";
import { fetchTrustedReviewUpdates } from "./projectReviewFetch";
import { fetchReviewBundlesForReviews } from "./reviewBundleFetch";
import type { ReviewBundleState } from "./reviewBundleState";
import { sessionReviewContext } from "./sessionReviewContext";

type FetchEvents = (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
const LIMIT = 200;

export type ThreadReviewSurface = {
  reviews: ProjectPullRequest[];
  /** Stacks that list at least one of this thread's reviews, newest first. */
  bundles: ReviewBundleState[];
};

/** Fetch the thread's durable reviews independently of live agent transcripts. */
export async function fetchThreadReviews(
  fetchEvents: FetchEvents,
  channelId: string,
  threadRootId: string,
) {
  return (await fetchThreadReviewSurface(fetchEvents, channelId, threadRootId))
    .reviews;
}

/** The thread's reviews plus the bundles (jj stacks) they belong to. */
export async function fetchThreadReviewSurface(
  fetchEvents: FetchEvents,
  channelId: string,
  threadRootId: string,
): Promise<ThreadReviewSurface> {
  // Match the Rust CLI's normalization so an uppercase hex id from the UI
  // still finds the signed lowercase marker (pr_session.rs lowercases).
  const wantedThreadRootId = threadRootId.toLowerCase();
  const roots = await fetchEvents({
    kinds: [1618],
    // NIP-34 events are stored globally; their h-tag is signed provenance,
    // not channel storage. Scope by the canonical thread and verify h below.
    "#e": [wantedThreadRootId],
    limit: LIMIT,
  });
  if (roots.length >= LIMIT)
    throw new Error(
      "Too many reviews in this thread. Open Projects to browse all reviews.",
    );
  const scoped = roots.filter(
    (root) =>
      root.kind === 1618 &&
      root.tags.some((tag) => tag[0] === "h" && tag[1] === channelId) &&
      sessionReviewContext(root)?.threadRootId === wantedThreadRootId,
  );
  if (!scoped.length) return { reviews: [], bundles: [] };
  const ids = scoped.map((root) => root.id);
  const [updates, statuses, bundles] = await Promise.all([
    // Uppercase #E is filtered after the relay's SQL LIMIT, so a capped #E
    // query silently drops this review's updates once other reviews have
    // more recent ones. Walk the trusted signers' updates instead.
    fetchTrustedReviewUpdates(scoped, fetchEvents),
    fetchEvents({
      kinds: [1630, 1631, 1632, 1633],
      "#e": ids,
      limit: LIMIT,
    }),
    fetchReviewBundlesForReviews(fetchEvents, scoped),
  ]);
  if (statuses.length >= LIMIT)
    throw new Error(
      "This thread's review history is too large for a summary. Open Projects for the full review.",
    );
  return {
    reviews: scoped.map((root) =>
      eventToProjectPullRequest(root, updates, [], statuses),
    ),
    bundles,
  };
}
