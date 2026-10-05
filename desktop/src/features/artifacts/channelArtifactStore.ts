import type { RelayEvent } from "@/shared/api/types";

import {
  type ArtifactRevision,
  parseArtifactRevision,
} from "./artifactEnvelope";

type ArtifactEntry = {
  head: ArtifactRevision;
  /** Revision ids some known revision names as `prev`: never a head again. */
  superseded: Set<string>;
};

const EMPTY: readonly ArtifactRevision[] = Object.freeze([]);

/**
 * Current artifacts of one channel, fed by every revision the relay sends.
 *
 * Replay sends current heads and live delivery sends every accepted
 * revision, in no guaranteed order, so the head is chosen by the `prev`
 * chain: a revision another revision names as `prev` is stale. Only when two
 * revisions are unlinked (a gap) does the newer `created_at` win.
 *
 * Heads of registered types are indexed by `root`. Per-root arrays keep their
 * identity until that root changes, so `useSyncExternalStore` readers of
 * other roots do not re-render.
 */
export class ChannelArtifactStore {
  private readonly entries = new Map<string, ArtifactEntry>();
  private readonly byRoot = new Map<string, readonly ArtifactRevision[]>();
  private readonly listeners = new Set<() => void>();

  private readonly channelId: string;
  private readonly isRegisteredType: (type: string) => boolean;

  constructor(channelId: string, isRegisteredType: (type: string) => boolean) {
    this.channelId = channelId;
    this.isRegisteredType = isRegisteredType;
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Registered, live (undeleted, still in this channel) artifacts on a root. */
  getForRoot(rootId: string): readonly ArtifactRevision[] {
    return this.byRoot.get(rootId) ?? EMPTY;
  }

  getHead(d: string): ArtifactRevision | undefined {
    return this.entries.get(d)?.head;
  }

  /** Returns true when the event changed a head. */
  ingest(event: RelayEvent): boolean {
    const revision = parseArtifactRevision(event);
    if (!revision || revision.h !== this.channelId) return false;
    const entry = this.entries.get(revision.d);
    if (!entry) {
      this.entries.set(revision.d, {
        head: revision,
        superseded: new Set(revision.prev ? [revision.prev] : []),
      });
      this.reindex(undefined, revision);
      return true;
    }
    if (
      revision.type !== entry.head.type ||
      revision.id === entry.head.id ||
      entry.superseded.has(revision.id)
    ) {
      return false;
    }
    if (revision.prev) entry.superseded.add(revision.prev);
    const linked = entry.superseded.has(entry.head.id);
    if (!linked && !isNewer(revision, entry.head)) return false;
    const previous = entry.head;
    entry.head = revision;
    this.reindex(previous, revision);
    return true;
  }

  private reindex(
    previous: ArtifactRevision | undefined,
    next: ArtifactRevision,
  ) {
    const touched = new Set<string>();
    if (previous?.root) touched.add(previous.root);
    if (next.root) touched.add(next.root);
    for (const root of touched) {
      const kept = (this.byRoot.get(root) ?? EMPTY).filter(
        (artifact) => artifact.d !== next.d,
      );
      const position = (this.byRoot.get(root) ?? EMPTY).findIndex(
        (artifact) => artifact.d === next.d,
      );
      if (root === next.root && this.isVisible(next)) {
        kept.splice(position < 0 ? kept.length : position, 0, next);
      }
      if (kept.length === 0) this.byRoot.delete(root);
      else this.byRoot.set(root, kept);
    }
    for (const listener of this.listeners) listener();
  }

  private isVisible(revision: ArtifactRevision) {
    return (
      revision.op !== "delete" &&
      revision.h === this.channelId &&
      this.isRegisteredType(revision.type)
    );
  }
}

function isNewer(candidate: ArtifactRevision, current: ArtifactRevision) {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  );
}
