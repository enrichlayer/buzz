import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import type { RelayEvent } from "@/shared/api/types";

import {
  type ArtifactRevision,
  KIND_ARTIFACT,
  KIND_ARTIFACT_REMOVAL,
} from "./artifactEnvelope";
import { ChannelArtifactStore } from "./channelArtifactStore";

/** Relay replay returns current heads only; this bounds one channel's set. */
const ARTIFACT_REPLAY_LIMIT = 500;
const CLOSED_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

type Dispose = () => Promise<void> | void;

export type ChannelArtifactRegistryDeps = {
  subscribeLive: (
    filter: RelaySubscriptionFilter,
    onEvent: (event: RelayEvent) => void,
    onTerminalClosed: (message: string) => void,
  ) => Promise<Dispose>;
  fetchEvents: (filter: RelaySubscriptionFilter) => Promise<RelayEvent[]>;
  isRegisteredType: (type: string) => boolean;
  /** Rows remount as the timeline virtualizes; don't churn the REQ meanwhile. */
  releaseGraceMs: number;
  /** Only tests override the bounded terminal-CLOSED retry schedule. */
  closedRetryDelaysMs?: readonly number[];
};

type Entry = {
  store: ChannelArtifactStore;
  refs: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
  retryTimer: ReturnType<typeof setTimeout> | null;
  retryAttempt: number;
  /** Resolves to the subscription's disposer; null when it failed. */
  subscription: Promise<Dispose | null> | null;
};

/**
 * One `{kinds:[45010,45011], #h:[channel]}` subscription per channel,
 * separate from the timeline's: artifact revisions are state, not rows, and
 * must not spend the timeline's history limits (docs/plans/question-card.md).
 */
export function buildChannelArtifactFilter(
  channelId: string,
): RelaySubscriptionFilter {
  return {
    kinds: [KIND_ARTIFACT, KIND_ARTIFACT_REMOVAL],
    "#h": [channelId],
    limit: ARTIFACT_REPLAY_LIMIT,
  };
}

/**
 * Reference-counted channel artifact stores. Community-scoped: `reset()`
 * must run on every community switch, because `relayClient.disconnect()`
 * kills live subscriptions without telling their owners.
 */
export function createChannelArtifactRegistry(
  deps: ChannelArtifactRegistryDeps,
) {
  const entries = new Map<string, Entry>();

  function dispose(entry: Entry) {
    if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
    if (entry.retryTimer !== null) clearTimeout(entry.retryTimer);
    entry.releaseTimer = null;
    entry.retryTimer = null;
    void entry.subscription?.then((close) => close?.()).catch(() => {});
    entry.subscription = null;
  }

  function subscribe(channelId: string, entry: Entry) {
    if (entry.subscription || entries.get(channelId) !== entry) return;
    let guarded: Promise<Dispose | null>;
    const pending = deps.subscribeLive(
      buildChannelArtifactFilter(channelId),
      (event) => {
        entry.retryAttempt = 0;
        entry.store.ingest(event);
      },
      (message) => {
        if (entries.get(channelId) !== entry || entry.subscription !== guarded)
          return;
        entry.subscription = null;
        void pending.then((close) => close?.()).catch(() => {});
        if (entry.refs === 0 || entry.retryTimer !== null) return;
        const delay = (deps.closedRetryDelaysMs ?? CLOSED_RETRY_DELAYS_MS)[
          entry.retryAttempt++
        ];
        if (delay === undefined) {
          console.error(
            "[artifacts] terminal CLOSED exhausted retries:",
            channelId,
            message,
          );
          return;
        }
        entry.retryTimer = setTimeout(() => {
          entry.retryTimer = null;
          if (entry.refs > 0 && entries.get(channelId) === entry)
            subscribe(channelId, entry);
        }, delay);
      },
    );
    guarded = pending.catch((error) => {
      console.error("[artifacts] subscription failed:", channelId, error);
      if (entries.get(channelId) === entry && entry.subscription === guarded) {
        entry.subscription = null;
      }
      return null;
    });
    entry.subscription = guarded;
  }

  function acquire(channelId: string): ChannelArtifactStore {
    let entry = entries.get(channelId);
    if (!entry) {
      entry = {
        store: new ChannelArtifactStore(channelId, deps.isRegisteredType),
        refs: 0,
        releaseTimer: null,
        retryTimer: null,
        retryAttempt: 0,
        subscription: null,
      };
      entries.set(channelId, entry);
    }
    const owned = entry;
    owned.refs += 1;
    if (owned.releaseTimer !== null) {
      clearTimeout(owned.releaseTimer);
      owned.releaseTimer = null;
    }
    if (!owned.subscription && owned.retryTimer === null)
      subscribe(channelId, owned);
    return owned.store;
  }

  function release(channelId: string, store: ChannelArtifactStore) {
    const entry = entries.get(channelId);
    // A reset already disposed the entry this caller acquired.
    if (!entry || entry.store !== store) return;
    entry.refs = Math.max(0, entry.refs - 1);
    if (entry.refs > 0 || entry.releaseTimer !== null) return;
    entry.releaseTimer = setTimeout(() => {
      entry.releaseTimer = null;
      if (entry.refs > 0 || entries.get(channelId) !== entry) return;
      entries.delete(channelId);
      dispose(entry);
    }, deps.releaseGraceMs);
  }

  /**
   * Fetch an artifact's current head straight from the relay into the
   * channel store, after a write conflict when the competing revision may
   * not have arrived live yet. A missing head (moved, deleted, redacted)
   * removes the artifact from view.
   */
  async function refreshHead(
    channelId: string,
    d: string,
  ): Promise<ArtifactRevision | undefined> {
    const store = entries.get(channelId)?.store;
    if (!store) return undefined;
    const headBeforeFetch = store.getHead(d)?.id;
    const events = await deps.fetchEvents({
      kinds: [KIND_ARTIFACT],
      "#h": [channelId],
      "#d": [d],
      limit: 10,
    });
    // A community switch or release may have replaced this channel's store
    // while the request was in flight. Its result belongs to the old store.
    if (entries.get(channelId)?.store !== store) return undefined;
    for (const event of events) store.ingest(event);
    const found = events.some((event) =>
      event.tags.some((tag) => tag[0] === "d" && tag[1] === d),
    );
    // An empty refetch cannot erase a newer revision delivered live while it
    // was in flight. The live result is the freshest state we have.
    if (!found && store.getHead(d)?.id === headBeforeFetch) store.remove(d);
    return store.getHead(d);
  }

  return {
    acquire,
    release,
    refreshHead,
    /** Fold a revision this client just published into its channel store. */
    ingest(channelId: string, event: RelayEvent) {
      entries.get(channelId)?.store.ingest(event);
    },
    reset() {
      for (const entry of entries.values()) dispose(entry);
      entries.clear();
    },
    size: () => entries.size,
  };
}
