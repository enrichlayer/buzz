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

export function shellCommandTags(
  text: string,
  recipients: string[],
  agentPubkeys: string[],
  hasAttachments = false,
  addressNames: string[] = [],
): string[][] {
  const command = shellCommand(text, addressNames);
  if (command == null) return [];
  if (
    !command ||
    new TextEncoder().encode(command).length > 16_000 ||
    command.includes("\0")
  )
    throw new Error("Enter a Bash command of 1–16000 bytes after !.");
  if (recipients.length !== 1 || !agentPubkeys.includes(recipients[0]))
    throw new Error("Address exactly one agent to run a Bash command.");
  if (hasAttachments)
    throw new Error("Send attachments separately from Bash commands.");
  return [["buzz.shell", "1", recipients[0], command]];
}
