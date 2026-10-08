import { parseArtifactRevision } from "@/features/artifacts/artifactEnvelope";
import type { RelayEvent } from "@/shared/api/types";

/**
 * Mock NIP-AR head lock for one channel's stored events. Mirrors the relay:
 * create needs an unused `d`, every later revision must name the current
 * head as `prev`, and resubmitting the head is a no-op success. The store
 * keeps only current heads, so channel replay returns current state.
 *
 * Returns the relay's rejection message, or null when accepted.
 */
export function applyMockArtifactRevision(
  store: RelayEvent[],
  event: RelayEvent,
): string | null {
  const revision = parseArtifactRevision(event);
  if (!revision) return "invalid: malformed artifact envelope";
  const headIndex = store.findIndex(
    (stored) => parseArtifactRevision(stored)?.d === revision.d,
  );
  const head = headIndex >= 0 ? store[headIndex] : null;
  if (head?.id === event.id) return null;
  if (revision.op === "create") {
    if (head) return "invalid: artifact identity already in use";
    store.push(event);
    return null;
  }
  if (!head || revision.prev !== head.id) {
    return "conflict: artifact head changed";
  }
  store.splice(headIndex, 1, event);
  return null;
}
