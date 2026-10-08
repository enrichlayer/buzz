import type { RelayEvent } from "@/shared/api/types";

/** NIP-AR channel artifact revision (see docs/nips/NIP-AR.md). */
export const KIND_ARTIFACT = 45010;
/** Relay-signed marker that an artifact moved out of a channel. */
export const KIND_ARTIFACT_REMOVAL = 45011;

export type ArtifactOp = "create" | "update" | "move" | "delete" | "restore";

/** One accepted revision of an artifact, with its envelope tags parsed. */
export type ArtifactRevision = {
  id: string;
  pubkey: string;
  createdAt: number;
  d: string;
  h: string;
  type: string;
  op: ArtifactOp;
  /** Absent only on `delete`. */
  title: string | null;
  root: string | null;
  /** Absent only on `create`. */
  prev: string | null;
  content: string;
  tags: string[][];
};

const OPS: ReadonlySet<string> = new Set([
  "create",
  "update",
  "move",
  "delete",
  "restore",
]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NIL_UUID = "00000000-0000-0000-0000-000000000000";
const EVENT_ID_RE = /^[0-9a-f]{64}$/;
const TYPE_RE = /^[a-z][a-z0-9_-]*(\.[a-z][a-z0-9_-]*)*$/;
const MAX_TITLE_BYTES = 512;
const ENVELOPE_TAGS = ["ar", "d", "h", "type", "op", "title", "root", "prev"];

function singleTag(tags: string[][], name: string): string | null | false {
  const matches = tags.filter((tag) => tag[0] === name);
  if (matches.length === 0) return null;
  if (matches.length > 1 || matches[0].length !== 2) return false;
  return matches[0][1];
}

/**
 * Parse a kind-45010 event's envelope. Returns null for anything the relay
 * should have rejected, so a malformed event can never reach a card.
 */
export function parseArtifactRevision(
  event: RelayEvent,
): ArtifactRevision | null {
  if (event.kind !== KIND_ARTIFACT) return null;
  const values = new Map<string, string | null>();
  for (const name of ENVELOPE_TAGS) {
    const value = singleTag(event.tags, name);
    if (value === false) return null;
    values.set(name, value);
  }
  const d = values.get("d");
  const h = values.get("h");
  const type = values.get("type");
  const op = values.get("op");
  const title = values.get("title") ?? null;
  const root = values.get("root") ?? null;
  const prev = values.get("prev") ?? null;
  if (values.get("ar") !== "1") return null;
  if (!d || !UUID_RE.test(d) || d === NIL_UUID) return null;
  if (!h || !type || type.length > 128 || !TYPE_RE.test(type)) return null;
  if (!op || !OPS.has(op)) return null;
  if (op === "delete" ? title !== null : !isValidTitle(title)) return null;
  if (op === "create" ? prev !== null : !prev || !EVENT_ID_RE.test(prev)) {
    return null;
  }
  if (root !== null && !EVENT_ID_RE.test(root)) return null;
  return {
    id: event.id,
    pubkey: event.pubkey,
    createdAt: event.created_at,
    d,
    h,
    type,
    op: op as ArtifactOp,
    title,
    root,
    prev,
    content: event.content,
    tags: event.tags,
  };
}

function isValidTitle(title: string | null): title is string {
  return (
    title !== null &&
    title.trim().length > 0 &&
    new TextEncoder().encode(title).length <= MAX_TITLE_BYTES
  );
}

/**
 * Tags for the next revision of `head`: the same envelope with `op=update`
 * and `prev=head.id`, keeping client annotation tags (NIP-AR: editors must
 * preserve them). NIP-OA `auth` tags are dropped: they attest the previous
 * signer, not this one.
 */
export function buildArtifactUpdateTags(head: ArtifactRevision): string[][] {
  const tags: string[][] = [
    ["ar", "1"],
    ["d", head.d],
    ["h", head.h],
    ["type", head.type],
    ["title", head.title ?? ""],
    ["op", "update"],
    ["prev", head.id],
  ];
  if (head.root) tags.push(["root", head.root]);
  for (const tag of head.tags) {
    if (!ENVELOPE_TAGS.includes(tag[0]) && tag[0] !== "auth") {
      tags.push([...tag]);
    }
  }
  return tags;
}
