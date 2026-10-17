import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { eventToProjectPullRequest } from "./projectPullRequests.mjs";
import { sessionReviewContext } from "./sessionReviewContext";

type FetchEvents = (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
const LIMIT = 200;

/** Fetch the thread's durable reviews independently of live agent transcripts. */
export async function fetchThreadReviews(
  fetchEvents: FetchEvents,
  channelId: string,
  threadRootId: string,
) {
  const roots = await fetchEvents({
    kinds: [1618],
    // NIP-34 events are stored globally; their h-tag is signed provenance,
    // not channel storage. Scope by the canonical thread and verify h below.
    "#e": [threadRootId],
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
      sessionReviewContext(root)?.threadRootId === threadRootId,
  );
  if (!scoped.length) return [];
  const ids = scoped.map((root) => root.id);
  const [updates, statuses] = await Promise.all([
    fetchEvents({ kinds: [1619], "#E": ids, limit: LIMIT }),
    fetchEvents({
      kinds: [1630, 1631, 1632, 1633],
      "#e": ids,
      limit: LIMIT,
    }),
  ]);
  if (updates.length >= LIMIT || statuses.length >= LIMIT)
    throw new Error(
      "This thread's review history is too large for a summary. Open Projects for the full review.",
    );
  return scoped.map((root) =>
    eventToProjectPullRequest(root, updates, [], statuses),
  );
}
