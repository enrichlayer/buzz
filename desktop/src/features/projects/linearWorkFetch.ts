import type { RelayEvent } from "@/shared/api/types";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import {
  KIND_LINEAR_PROJECT,
  KIND_LINEAR_TASK,
  linearEventToWork,
  type LinearWorkRecord,
} from "./linearWorkModels";

/** Exhaust SQL-pushed kinds before deriving source projects; never filter pages by source labels. */
export async function fetchLinearWork(
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>,
  signal?: AbortSignal,
): Promise<LinearWorkRecord[]> {
  const seen = new Map<string, RelayEvent>();
  let bytes = 0;
  let until: number | undefined;
  let limit = 500;
  for (let pageNumber = 0; pageNumber < 50; pageNumber++) {
    signal?.throwIfAborted();
    const page = await fetchEvents({
      kinds: [KIND_LINEAR_PROJECT, KIND_LINEAR_TASK],
      limit,
      ...(until === undefined ? {} : { until }),
    });
    signal?.throwIfAborted();
    for (const event of page) {
      if (seen.has(event.id)) continue;
      bytes += new TextEncoder().encode(event.content).length;
      if (bytes > 64 * 1024 * 1024)
        throw new Error("Linear work exceeds the 64 MiB query budget.");
      seen.set(event.id, event);
    }
    if (seen.size > 20_000) break;
    if (page.length < limit) {
      const records = [...seen.values()].map(linearEventToWork);
      if (records.some((record) => record === null))
        throw new Error(
          "A Linear mirror record is malformed. Ask the sync operator to repair it.",
        );
      const latest = new Map<
        string,
        { event: RelayEvent; record: LinearWorkRecord }
      >();
      for (const event of seen.values()) {
        const record = linearEventToWork(event);
        if (!record) continue;
        const previous = latest.get(record.address);
        if (
          !previous ||
          event.created_at > previous.event.created_at ||
          (event.created_at === previous.event.created_at &&
            event.id < previous.event.id)
        )
          latest.set(record.address, { event, record });
      }
      return [...latest.values()]
        .map(({ record }) => record)
        .filter((record): record is LinearWorkRecord => record !== null);
    }
    const oldest = Math.min(...page.map((event) => event.created_at));
    if (until === undefined || oldest < until) {
      until = oldest;
      continue;
    }
    if (limit < 1_000) {
      limit = 1_000;
      continue;
    }
    throw new Error(
      "Linear work could not be fully loaded: a relay timestamp page is saturated.",
    );
  }
  throw new Error(
    "Linear work exceeds the supported query budget; the list is incomplete.",
  );
}
