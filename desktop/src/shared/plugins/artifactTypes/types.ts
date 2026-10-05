/**
 * Everything the desktop needs to know about one artifact type (NIP-AR
 * kind 45010 `type` tag), outside of how its card looks.
 *
 * Artifact revisions are state changes, not messages: they never add
 * timeline rows, unreads or reply counts. A registered type instead renders
 * a card under its `root` message, keyed by the same `id` in `cards.tsx`.
 *
 * Kept free of React so stores and node tests can import it.
 */
export type ArtifactTypePolicy = {
  /** Stable plugin name; `cards.tsx` must register a card under it. */
  id: string;
  /** The namespaced artifact `type` this plugin owns. */
  type: string;
};
