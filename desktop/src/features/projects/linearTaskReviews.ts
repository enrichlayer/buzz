import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { eventToProjectPullRequest } from "./projectPullRequests.mjs";
import { sessionReviewContext } from "./sessionReviewContext";

/** Resolve signed task associations, independently of local conversation history. */
export async function fetchLinearTaskReviews(
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>,
  address: string,
) {
  const limit = 200;
  const roots = await fetchEvents({ kinds: [1618], "#a": [address], limit });
  if (roots.length >= limit)
    throw new Error(
      "Task review history exceeds the summary limit. Open Reviews for the full history.",
    );
  const scoped = roots.filter(
    (event) =>
      event.kind === 1618 &&
      sessionReviewContext(event)?.taskAddress === address,
  );
  if (!scoped.length) return [];
  const ids = scoped.map((event) => event.id);
  const [updates, statuses] = await Promise.all([
    fetchEvents({ kinds: [1619], "#E": ids, limit }),
    fetchEvents({ kinds: [1630, 1631, 1632, 1633], "#e": ids, limit }),
  ]);
  if (updates.length >= limit || statuses.length >= limit)
    throw new Error(
      "Task review updates exceed the summary limit. Open Reviews for the full history.",
    );
  return scoped.map((event) =>
    eventToProjectPullRequest(event, updates, [], statuses),
  );
}

/** Discover canonical coding roots through signed metadata rather than prose search. */
export async function fetchLinearTaskThreads(
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>,
  address: string,
  channelId: string,
) {
  const events = await fetchEvents({
    kinds: [9, 11],
    "#a": [address],
    "#h": [channelId],
    limit: 200,
  });
  if (events.length >= 200)
    throw new Error("Task conversation history exceeds the summary limit.");
  return events
    .filter((event) => {
      const tasks = event.tags.filter(
        (tag) => tag[0] === "a" && tag[3] === "buzz-task",
      );
      const channels = event.tags.filter((tag) => tag[0] === "h");
      return (
        [9, 11].includes(event.kind) &&
        tasks.length === 1 &&
        tasks[0].length === 4 &&
        tasks[0][1] === address &&
        channels.length === 1 &&
        channels[0][1] === channelId &&
        !event.tags.some(
          (tag) =>
            tag[0] === "e" &&
            (tag[3] === "root" || tag[3] === "reply" || !tag[3]),
        )
      );
    })
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id));
}
