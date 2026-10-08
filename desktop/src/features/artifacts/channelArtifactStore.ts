import type { RelayEvent } from "@/shared/api/types";

import {
  type ArtifactRevision,
  KIND_ARTIFACT_REMOVAL,
  parseArtifactRevision,
} from "./artifactEnvelope";

type ArtifactEntry = {
  /** Null once the artifact left this channel (moved out, or gone on refetch). */
  head: ArtifactRevision | null;
  /** Revision ids some known revision names as `prev`: never a head again. */
  superseded: Set<string>;
};

/**
 * Superseded ids kept per artifact. Older ids only matter for a late,
 * long-stale delivery, which then loses on `created_at` instead.
 */
const MAX_SUPERSEDED = 64;
const EMPTY: readonly ArtifactRevision[] = Object.freeze([]);

/**
 * Current artifacts of one channel, fed by every revision the relay sends.
 *
 * Replay sends current heads and live delivery sends every accepted
 * revision, in no guaranteed order, so the head is chosen by the `prev`
 * chain: a revision another revision names as `prev` is stale. Only when two
 * revisions are unlinked (a gap) does the newer `created_at` win. Only
 * registered types are kept.
 *
 * Heads are indexed by `root`. Per-root arrays keep their identity until that
 * root changes, so `useSyncExternalStore` readers of other roots do not
 * re-render.
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

  /** Live (undeleted, still in this channel) artifacts on a root. */
  getForRoot(rootId: string): readonly ArtifactRevision[] {
    return this.byRoot.get(rootId) ?? EMPTY;
  }

  getHead(d: string): ArtifactRevision | undefined {
    return this.entries.get(d)?.head ?? undefined;
  }

  /** Returns true when the event changed what this channel shows. */
  ingest(event: RelayEvent): boolean {
    if (event.kind === KIND_ARTIFACT_REMOVAL) return this.ingestRemoval(event);
    const revision = parseArtifactRevision(event);
    if (!revision || revision.h !== this.channelId) return false;
    if (!this.isRegisteredType(revision.type)) return false;
    const entry = this.entries.get(revision.d);
    if (!entry) {
      const superseded = new Set(revision.prev ? [revision.prev] : []);
      this.entries.set(revision.d, { head: revision, superseded });
      this.reindex(null, revision);
      return true;
    }
    if (
      revision.id === entry.head?.id ||
      (entry.head && revision.type !== entry.head.type) ||
      entry.superseded.has(revision.id)
    ) {
      return false;
    }
    if (revision.prev) supersede(entry, revision.prev);
    const head = entry.head;
    if (head && !entry.superseded.has(head.id) && !isNewer(revision, head)) {
      return false;
    }
    entry.head = revision;
    this.reindex(head, revision);
    return true;
  }

  /** Forget an artifact's head, e.g. when a refetch finds it gone. */
  remove(d: string) {
    const entry = this.entries.get(d);
    if (!entry?.head) return;
    const head = entry.head;
    supersede(entry, head.id);
    entry.head = null;
    this.reindex(head, null);
  }

  /**
   * A relay removal marker (kind 45011: `d`, source `h`, replaced `prev`)
   * says the artifact moved out of this channel.
   */
  private ingestRemoval(event: RelayEvent): boolean {
    const tag = (name: string) => event.tags.find((t) => t[0] === name)?.[1];
    const d = tag("d");
    const replaced = tag("prev");
    const entry = d ? this.entries.get(d) : undefined;
    if (!entry || !replaced || tag("h") !== this.channelId) return false;
    if (entry.head?.id !== replaced) {
      supersede(entry, replaced);
      return false;
    }
    this.remove(entry.head.d);
    return true;
  }

  private reindex(
    previous: ArtifactRevision | null,
    next: ArtifactRevision | null,
  ) {
    const d = (next ?? previous)?.d;
    const touched = new Set<string>();
    if (previous?.root) touched.add(previous.root);
    if (next?.root) touched.add(next.root);
    for (const root of touched) {
      const current = this.byRoot.get(root) ?? EMPTY;
      const position = current.findIndex((artifact) => artifact.d === d);
      const kept = current.filter((artifact) => artifact.d !== d);
      if (next && root === next.root && next.op !== "delete") {
        kept.splice(position < 0 ? kept.length : position, 0, next);
      }
      if (kept.length === 0) this.byRoot.delete(root);
      else this.byRoot.set(root, kept);
    }
    for (const listener of this.listeners) listener();
  }
}

function supersede(entry: ArtifactEntry, id: string) {
  entry.superseded.delete(id);
  entry.superseded.add(id);
  if (entry.superseded.size > MAX_SUPERSEDED) {
    const oldest = entry.superseded.values().next().value;
    if (oldest !== undefined) entry.superseded.delete(oldest);
  }
}

function isNewer(candidate: ArtifactRevision, current: ArtifactRevision) {
  return (
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.id > current.id)
  );
}
