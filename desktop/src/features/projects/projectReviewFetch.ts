import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { projectPullRequestEventsToPullRequests } from "./projectPullRequests.mjs";

type FetchEvents = (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;

/** Load complete review discussions, or report an error instead of partial state. */
export async function fetchProjectPullRequests(
  project: { repoAddress: string },
  fetchEvents: FetchEvents = relayClient.fetchEvents.bind(relayClient),
  signal?: AbortSignal,
) {
  const roots = await fetchEvents({
    kinds: [1618],
    "#a": [project.repoAddress],
    limit: 200,
  });
  if (roots.length >= 200)
    throw new Error("Too many reviews to load a complete review list.");
  if (!roots.length) return [];
  const ids = roots.map((root) => root.id);
  const [updates, statuses, comments] = await Promise.all([
    fetchEvents({ kinds: [1619], "#E": ids, limit: 500 }),
    fetchEvents({ kinds: [1630, 1631, 1632, 1633], "#e": ids, limit: 500 }),
    fetchReviewComments(ids, fetchEvents, signal),
  ]);
  if (updates.length >= 500 || statuses.length >= 500)
    throw new Error(
      "Review update history exceeds the supported limit. Review state is incomplete.",
    );
  return projectPullRequestEventsToPullRequests(
    roots,
    updates,
    comments,
    statuses,
  );
}

async function fetchReviewComments(
  ids: string[],
  fetchEvents: FetchEvents,
  signal?: AbortSignal,
) {
  const seen = new Map<string, RelayEvent>();
  let until: number | undefined;
  let limit = 500;
  // A hard bound prevents hostile history from keeping a refresh alive forever.
  for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
    signal?.throwIfAborted();
    // #e is pushed into SQL before LIMIT. #a/#t are post-filtered and cannot
    // establish exhaustion, so repository and semantic roles are checked by
    // the production projection instead.
    const page = await fetchEvents({
      kinds: [1],
      "#e": ids,
      limit,
      ...(until === undefined ? {} : { until }),
    });
    signal?.throwIfAborted();
    for (const event of page) seen.set(event.id, event);
    if (seen.size > 20_000) break;
    if (page.length < limit) return [...seen.values()];
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (until === undefined || oldest < until) {
      until = oldest;
      continue;
    }
    // NIP-01 only has a seconds cursor. Never skip a saturated second: widen
    // once to the relay's hard clamp, then visibly fail if still saturated.
    if (limit < 1_000) {
      limit = 1_000;
      continue;
    }
    throw new Error(
      "Review discussions are incomplete: too many comments share one timestamp.",
    );
  }
  throw new Error("Review discussions exceed the supported history limit.");
}
