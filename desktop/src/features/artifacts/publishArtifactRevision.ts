import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";

import {
  type ArtifactRevision,
  buildArtifactUpdateTags,
  KIND_ARTIFACT,
} from "./artifactEnvelope";
import { ingestArtifactEvent } from "./channelArtifactSubscriptions";

/** Relay rejection when `prev` is no longer the artifact's current head. */
export function isArtifactConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("conflict:");
}

/**
 * Publish the next revision of `head` with new content. Rejects with the
 * relay's message; a stale `prev` rejects with a `conflict:` error.
 */
export async function publishArtifactUpdate(
  head: ArtifactRevision,
  content: string,
) {
  const event = await signRelayEvent({
    kind: KIND_ARTIFACT,
    content,
    tags: buildArtifactUpdateTags(head),
  });
  const accepted = await relayClient.publishEvent(
    event,
    "Timed out while saving the answer.",
    "Failed to save the answer.",
  );
  ingestArtifactEvent(head.h, accepted);
  return accepted;
}
