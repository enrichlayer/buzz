import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { isRegisteredArtifactType } from "@/shared/plugins/artifactTypes/policies";

import type { ArtifactRevision } from "./artifactEnvelope";
import { createChannelArtifactRegistry } from "./channelArtifactRegistry";
import type { ChannelArtifactStore } from "./channelArtifactStore";

const registry = createChannelArtifactRegistry({
  subscribeLive: (filter, onEvent) =>
    relayClient.subscribeLive(filter, onEvent),
  fetchEvents: (filter) => relayClient.fetchEvents(filter),
  isRegisteredType: isRegisteredArtifactType,
  releaseGraceMs: 1_000,
});

export const refreshArtifactHead = registry.refreshHead;
export const ingestArtifactEvent = registry.ingest;

/** Community switch: drop every channel store and its live subscription. */
export function resetChannelArtifactSubscriptions() {
  registry.reset();
}

const NO_ARTIFACTS: readonly ArtifactRevision[] = Object.freeze([]);
const NO_STORE_SUBSCRIPTION = () => () => {};

/** Registered artifacts anchored to `rootId`, live for this channel. */
export function useRootArtifacts(
  channelId: string,
  rootId: string,
): readonly ArtifactRevision[] {
  const [store, setStore] = React.useState<ChannelArtifactStore | null>(null);
  React.useEffect(() => {
    const acquired = registry.acquire(channelId);
    setStore(acquired);
    return () => {
      registry.release(channelId, acquired);
      setStore(null);
    };
  }, [channelId]);
  const getSnapshot = React.useCallback(
    () => store?.getForRoot(rootId) ?? NO_ARTIFACTS,
    [store, rootId],
  );
  return React.useSyncExternalStore(
    store?.subscribe ?? NO_STORE_SUBSCRIPTION,
    getSnapshot,
  );
}
