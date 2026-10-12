import type { TimelineMessage } from "../types";

/** Advisory output from the shared suggest-next-prompts skill, never a command. */
export type PromptSuggestion = { label: string; prompt: string };
export type PromptSuggestionSource = {
  messageId: string;
  author: string;
  pubkey: string;
  suggestions: PromptSuggestion[];
};

const FOOTER_FENCE = "```suggested-prompts\n";
// An `@` at a token start can become a recipient on Send (plain-text mentions
// resolve against channel members), and suggestions must never choose one.
const MENTION_START = /(?<![\p{L}\p{N}])@/u;

/** Only consume a complete, bounded footer; malformed content stays visible. */
export function parsePromptSuggestions(body: string): {
  body: string;
  suggestions: PromptSuggestion[];
} | null {
  if (!body.includes(FOOTER_FENCE)) return null;
  const match = /(?:^|\n)```suggested-prompts\n([\s\S]{1,6000})\n```\s*$/.exec(
    body,
  );
  if (!match) return null;
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    return null; // Untrusted message content is ordinary Markdown on parse failure.
  }
  if (!value || typeof value !== "object") return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.version !== 1 ||
    !Array.isArray(payload.suggestions) ||
    payload.suggestions.length > 3
  )
    return null;
  const suggestions: PromptSuggestion[] = [];
  const seen = new Set<string>();
  for (const entry of payload.suggestions) {
    if (!entry || typeof entry !== "object") return null;
    const { label, prompt } = entry as Record<string, unknown>;
    if (typeof label !== "string" || typeof prompt !== "string") return null;
    if (
      !label.trim() ||
      label.length > 64 ||
      !prompt.trim() ||
      prompt.length > 1000
    )
      return null;
    if (
      /[\p{Cf}\p{Zl}\p{Zp}]/u.test(label) ||
      /[\p{Cf}\p{Zl}\p{Zp}]/u.test(prompt) ||
      [...label].some(
        (char) =>
          char.charCodeAt(0) < 32 ||
          (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
      ) ||
      [...prompt].some(
        (char) =>
          (char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t") ||
          (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
      )
    )
      return null;
    if (label.includes("```") || prompt.includes("```")) return null;
    if (MENTION_START.test(label) || MENTION_START.test(prompt)) return null;
    const key = prompt.trim().toLowerCase();
    if (seen.has(key)) return null;
    seen.add(key);
    suggestions.push({ label: label.trim(), prompt: prompt.trim() });
  }
  return { body: body.slice(0, match.index).trimEnd(), suggestions };
}

/** Only a known signing agent may supply hidden presentation metadata. */
export function stripPromptSuggestionFooter(
  body: string,
  authorIsAgent: boolean,
): string {
  return authorIsAgent ? (parsePromptSuggestions(body)?.body ?? body) : body;
}

/** Any newer message supersedes the previous turn's suggestions. */
export function latestPromptSuggestions(
  messages: readonly TimelineMessage[],
): PromptSuggestionSource | null {
  const latest = messages.reduce<TimelineMessage | null>(
    (current, message) =>
      !current || message.createdAt >= current.createdAt ? message : current,
    null,
  );
  // formatTimelineMessages strips the footer from agent bodies and keeps the
  // parsed suggestions on the message.
  if (!latest?.isAgent || latest.pending || !latest.pubkey) return null;
  if (!latest.promptSuggestions?.length) return null;
  return {
    messageId: latest.id,
    author: latest.author,
    pubkey: latest.pubkey,
    suggestions: [...latest.promptSuggestions],
  };
}
