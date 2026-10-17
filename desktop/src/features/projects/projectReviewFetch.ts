import { relayClient } from "@/shared/api/relayClient";
import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { allowedActorsForRoot } from "./projectIssues.mjs";
import { projectPullRequestEventsToPullRequests } from "./projectPullRequests.mjs";

type FetchEvents = (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;

/** Load complete review discussions, or report an error instead of partial state. */
export async function fetchProjectPullRequests(
  project: { repoAddress: string },
  fetchEvents: FetchEvents = relayClient.fetchEvents.bind(relayClient),
  signal?: AbortSignal,
) {
  // #a and uppercase #E are filtered AFTER the relay's SQL LIMIT. Walk
  // SQL-pushed kinds first, then scope locally so a short page proves exhaustion.
  const candidates = await fetchCompleteReviewEvents(
    { kinds: [1618] },
    fetchEvents,
    signal,
  );
  const roots = candidates.filter((event) =>
    event.tags.some((tag) => tag[0] === "a" && tag[1] === project.repoAddress),
  );
  if (roots.length > 200)
    throw new Error("Too many reviews to load a complete review list.");
  if (!roots.length) return [];
  const ids = roots.map((root) => root.id);
  const [updates, statuses, comments] = await Promise.all([
    fetchTrustedReviewUpdates(roots, fetchEvents, signal),
    fetchCompleteReviewEvents(
      { kinds: [1630, 1631, 1632, 1633], "#e": ids },
      fetchEvents,
      signal,
    ),
    fetchCompleteReviewEvents({ kinds: [1], "#e": ids }, fetchEvents, signal),
  ]);
  return projectPullRequestEventsToPullRequests(
    roots,
    updates,
    comments,
    statuses,
  );
}

/**
 * Updates are honored only from a review's author or repository owner, and
 * `authors` is pushed into SQL before LIMIT while uppercase `#E` is not. Scope
 * the walk to those signers so unrelated relay-wide updates cannot exhaust it.
 */
export function fetchTrustedReviewUpdates(
  roots: RelayEvent[],
  fetchEvents: FetchEvents,
  signal?: AbortSignal,
) {
  const authors = [
    ...new Set(roots.flatMap((root) => [...allowedActorsForRoot(root)])),
  ].sort();
  return fetchCompleteReviewEvents(
    { kinds: [1619], authors },
    fetchEvents,
    signal,
  );
}

/** Walk SQL-pushed filters to exhaustion; post-LIMIT tag filters cannot prove completeness. */
export async function fetchCompleteReviewEvents(
  filter: { kinds: number[]; "#e"?: string[]; authors?: string[] },
  fetchEvents: FetchEvents,
  signal?: AbortSignal,
) {
  const seen = new Map<string, RelayEvent>();
  let until: number | undefined;
  let limit = 500;
  // A hard bound prevents hostile history from keeping a refresh alive forever.
  for (let pageNumber = 0; pageNumber < 40; pageNumber++) {
    signal?.throwIfAborted();
    // #e and authors are pushed into SQL before LIMIT. #a/#t are post-filtered and cannot
    // establish exhaustion, so repository and semantic roles are checked by
    // the production projection instead.
    const page = await fetchEvents({
      ...filter,
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
      "Review history is incomplete: too many events share one timestamp.",
    );
  }
  throw new Error("Review history exceeds the supported history limit.");
}
