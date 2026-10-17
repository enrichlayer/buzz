/** Permission payloads stay literal; neither Markdown nor plugins execute them. */
export type PermissionRequest = {
  version: 1;
  ownerPubkey: string;
  agentPubkey: string;
  cwd: string;
  command: string | null;
  toolCall: Record<string, unknown>;
};

export function parsePermissionRequest(
  value: unknown,
): PermissionRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const p = value as Record<string, unknown>;
  const key = /^[0-9a-f]{64}$/;
  if (
    p.version !== 1 ||
    typeof p.ownerPubkey !== "string" ||
    !key.test(p.ownerPubkey) ||
    typeof p.agentPubkey !== "string" ||
    !key.test(p.agentPubkey) ||
    typeof p.cwd !== "string" ||
    !p.cwd ||
    p.cwd.length > 4096 ||
    Array.from(p.cwd).some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    ) ||
    (p.command !== null &&
      (typeof p.command !== "string" || p.command.length > 64000)) ||
    !p.toolCall ||
    typeof p.toolCall !== "object" ||
    Array.isArray(p.toolCall)
  )
    return null;
  return p as PermissionRequest;
}
