/** Leading ! is explicit human execution intent; existing agent controls stay controls. */
export function shellCommand(
  text: string,
  addressNames: string[] = [],
): string | null {
  let value = text.trimStart();
  // Address chips are serialized before authored text. Strip only known,
  // identity-bound names, never an arbitrary @-looking shell argument.
  for (const name of [...addressNames].sort((a, b) => b.length - a.length)) {
    const prefix = `@${name}`;
    if (value.startsWith(prefix) && /^\s/.test(value.slice(prefix.length)))
      value = value.slice(prefix.length).trimStart();
  }
  if (
    !value.startsWith("!") ||
    /^!(cancel|rotate|shutdown)(?:\s|$)/.test(value)
  )
    return null;
  return value.slice(1).trim();
}

/** A direct command needs exactly one addressed agent; anything else is chat. */
export function directCommandAgent(
  recipients: readonly string[],
  agentPubkeys: readonly string[],
): string | null {
  const unique = [...new Set(recipients)];
  return unique.length === 1 && agentPubkeys.includes(unique[0])
    ? unique[0]
    : null;
}

/** Composer preview of the send path's rule: one addressed agent, leading !. */
export function composerShellCommand(
  text: string,
  mentionRefs: readonly {
    displayName: string;
    pubkey: string;
    isAgent: boolean;
  }[],
  addressedAgentPubkeys: readonly string[],
): string | null {
  const key = (pubkey: string) => pubkey.trim().toLowerCase();
  const recipients = [
    ...addressedAgentPubkeys,
    ...mentionRefs.map((ref) => ref.pubkey),
  ].map(key);
  const agents = [
    ...addressedAgentPubkeys,
    ...mentionRefs.filter((ref) => ref.isAgent).map((ref) => ref.pubkey),
  ].map(key);
  return directCommandAgent(recipients, agents) == null
    ? null
    : shellCommand(
        text,
        mentionRefs.map((ref) => ref.displayName),
      );
}

export function shellCommandTags(
  text: string,
  recipients: string[],
  agentPubkeys: string[],
  hasAttachments = false,
  addressNames: string[] = [],
): string[][] {
  const agent = directCommandAgent(recipients, agentPubkeys);
  const command = agent == null ? null : shellCommand(text, addressNames);
  if (agent == null || command == null) return [];
  if (
    !command ||
    new TextEncoder().encode(command).length > 16_000 ||
    command.includes("\0")
  )
    throw new Error("Enter a Bash command of 1–16000 bytes after !.");
  if (hasAttachments)
    throw new Error("Send attachments separately from Bash commands.");
  return [["buzz.shell", "1", agent, command]];
}
