import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import type { RelaySubscriptionFilter } from "@/shared/api/relayClientShared";
import { isRegisteredArtifactType } from "@/shared/plugins/artifactTypes/policies";

import { type ArtifactRevision, KIND_ARTIFACT } from "./artifactEnvelope";
import { ChannelArtifactStore } from "./channelArtifactStore";

/** Relay replay returns current heads only; this bounds one channel's set. */
const ARTIFACT_REPLAY_LIMIT = 500;
/** Rows remount as the timeline virtualizes; don't churn the REQ meanwhile. */
const RELEASE_GRACE_MS = 1_000;

type Entry = {
  store: ChannelArtifactStore;
  refs: number;
  releaseTimer: number | null;
  /** Resolves to the subscription's disposer; null when it failed. */
  subscription: Promise<(() => Promise<void>) | null> | null;
};

const entries = new Map<string, Entry>();

/**
 * One `{kinds:[45010], #h:[channel]}` subscription per channel, separate from
 * the timeline's: artifact revisions are state, not rows, and must not spend
 * the timeline's history limits (docs/plans/question-card.md).
 */
export function buildChannelArtifactFilter(
  channelId: string,
): RelaySubscriptionFilter {
  return {
    kinds: [KIND_ARTIFACT],
    "#h": [channelId],
    limit: ARTIFACT_REPLAY_LIMIT,
  };
}

function getEntry(channelId: string): Entry {
  let entry = entries.get(channelId);
  if (!entry) {
    entry = {
      store: new ChannelArtifactStore(channelId, isRegisteredArtifactType),
      refs: 0,
      releaseTimer: null,
      subscription: null,
    };
    entries.set(channelId, entry);
  }
  return entry;
}

function acquire(channelId: string) {
  const entry = getEntry(channelId);
  entry.refs += 1;
  if (entry.releaseTimer !== null) {
    window.clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
  }
  if (entry.subscription) return;
  entry.subscription = relayClient
    .subscribeLive(buildChannelArtifactFilter(channelId), (event) => {
      entry.store.ingest(event);
    })
    .catch((error) => {
      console.error("[artifacts] subscription failed:", channelId, error);
      // Let the next acquire retry instead of pinning a dead entry.
      if (entries.get(channelId) === entry) entry.subscription = null;
      return null;
    });
}

function release(channelId: string) {
  const entry = entries.get(channelId);
  if (!entry) return;
  entry.refs = Math.max(0, entry.refs - 1);
  if (entry.refs > 0 || entry.releaseTimer !== null) return;
  entry.releaseTimer = window.setTimeout(() => {
    entry.releaseTimer = null;
    if (entry.refs > 0 || entries.get(channelId) !== entry) return;
    entries.delete(channelId);
    void entry.subscription?.then((dispose) => dispose?.());
  }, RELEASE_GRACE_MS);
}

/**
 * Fetch an artifact's current head straight from the relay and fold it into
 * the channel store. Used after a write conflict, when the competing revision
 * may not have arrived live yet.
 */
export async function refreshArtifactHead(
  channelId: string,
  d: string,
): Promise<ArtifactRevision | undefined> {
  const entry = getEntry(channelId);
  const events = await relayClient.fetchEvents({
    kinds: [KIND_ARTIFACT],
    "#h": [channelId],
    "#d": [d],
    limit: 10,
  });
  for (const event of events) entry.store.ingest(event);
  return entry.store.getHead(d);
}

/** Fold a revision this client just published into the channel store. */
export function ingestArtifactEvent(
  channelId: string,
  event: Parameters<ChannelArtifactStore["ingest"]>[0],
) {
  getEntry(channelId).store.ingest(event);
}

/** Registered artifacts anchored to `rootId`, live for this channel. */
export function useRootArtifacts(
  channelId: string | null,
  rootId: string,
): readonly ArtifactRevision[] {
  const store = channelId ? getEntry(channelId).store : null;
  React.useEffect(() => {
    if (!channelId) return;
    acquire(channelId);
    return () => release(channelId);
  }, [channelId]);
  const subscribe = React.useCallback(
    (listener: () => void) => store?.subscribe(listener) ?? (() => {}),
    [store],
  );
  const getSnapshot = React.useCallback(
    () => store?.getForRoot(rootId) ?? NO_ARTIFACTS,
    [store, rootId],
  );
  return React.useSyncExternalStore(subscribe, getSnapshot);
}

const NO_ARTIFACTS: readonly ArtifactRevision[] = Object.freeze([]);
