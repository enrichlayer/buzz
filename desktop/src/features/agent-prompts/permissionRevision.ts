import type { ArtifactRevision } from "@/features/artifacts/artifactEnvelope";

import { parseAgentPrompt } from "./agentPromptContent";
import { parsePermissionRequest } from "./permissionContent";

/** Upper bound on revisions walked from a card's head to its creation. */
export const MAX_PERMISSION_CHAIN = 64;

/** A revision past creation needs its chain checked before it is trusted. */
export function needsPermissionChain(head: ArtifactRevision): boolean {
  if (head.op === "create") return false;
  const prompt = parseAgentPrompt(head.content, head.pubkey);
  // An unreadable head may be another member's revision on a permission card.
  return prompt == null || prompt.raw.permission !== undefined;
}

/**
 * The revision a permission card shows. Any channel member may append a
 * revision, so the head alone proves nothing: walk `prev` from the head back
 * to the agent's original card, then take the first revision, nearest the
 * original, that leaves the request unchanged and is either the owner's
 * answer or the agent's withdrawal. Without one the original is still open.
 * Returns null when the chain does not resolve to a permission card.
 */
export function resolvePermissionRevision(
  head: ArtifactRevision,
  revisions: readonly ArtifactRevision[],
): ArtifactRevision | null {
  const byId = new Map(revisions.map((revision) => [revision.id, revision]));
  const chain: ArtifactRevision[] = [];
  let cursor: ArtifactRevision | undefined = head;
  while (cursor && cursor.op !== "create") {
    if (chain.length >= MAX_PERMISSION_CHAIN || !cursor.prev) return null;
    chain.push(cursor);
    cursor = byId.get(cursor.prev);
  }
  if (!cursor) return null;
  const original = parseAgentPrompt(cursor.content, cursor.pubkey);
  const permission = parsePermissionRequest(original?.raw.permission);
  if (original?.state !== "open" || !permission) return null;
  const request = requestKey(original.raw);
  for (const revision of chain.reverse()) {
    if (revision.op !== "update") continue;
    const prompt = parseAgentPrompt(revision.content, revision.pubkey);
    if (!prompt || requestKey(prompt.raw) !== request) continue;
    const signer = revision.pubkey.toLowerCase();
    if (
      (prompt.state === "answered" && signer === permission.ownerPubkey) ||
      (prompt.state === "cancelled" && signer === permission.agentPubkey)
    )
      return revision;
  }
  return cursor;
}

/** The request without its decision fields, in a key-order-free form. */
function requestKey(raw: Record<string, unknown>): string {
  const { state: _state, answer: _answer, answeredBy: _by, ...request } = raw;
  return JSON.stringify(sortKeys(request));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, entry]) => [key, sortKeys(entry)]),
  );
}
