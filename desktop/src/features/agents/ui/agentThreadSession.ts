import type { TimelineMessage } from "@/features/messages/types";
import { normalizePubkey } from "@/shared/lib/pubkey";
import type { TranscriptItem } from "./agentSessionTypes";
import { getSentMessageLink } from "./AgentSessionToolItem/messageLinks";

export type AgentThreadCandidate = {
  pubkey: string;
};

export type ThreadSessionTranscriptSelection = {
  items: TranscriptItem[];
  sessionIds: Set<string>;
  turnIds: Set<string>;
};

export function canStopAgentThreadSession({
  canInterruptTurn,
  isDirectMessage,
  sessionPolicy,
}: {
  canInterruptTurn: boolean;
  isDirectMessage: boolean;
  sessionPolicy?: "channel" | "thread";
}): boolean {
  return canInterruptTurn && !isDirectMessage && sessionPolicy === "thread";
}

export function shouldOfferOlderThreadSessionActivity({
  hasBoundTurn,
  hasOlderArchived,
  publishedMessageCount,
}: {
  hasBoundTurn: boolean;
  hasOlderArchived: boolean;
  publishedMessageCount: number;
}): boolean {
  return !hasBoundTurn && hasOlderArchived && publishedMessageCount > 0;
}

/**
 * Resolve agents that actually participate in a thread. Authored agent
 * messages are authoritative; message recipient tags are the fallback for a
 * newly-opened thread whose mentioned agent has not published a reply yet.
 * Intersecting with the known agent roster prevents ordinary human p-tags from
 * turning a human thread into an agent session.
 */
export function selectThreadAgentCandidates<T extends AgentThreadCandidate>(
  messages: readonly TimelineMessage[],
  agents: readonly T[],
): T[] {
  if (messages.length === 0 || agents.length === 0) return [];

  const known = new Map(
    agents.map((agent) => [normalizePubkey(agent.pubkey), agent] as const),
  );
  const authored = new Set<string>();
  const addressed = new Set<string>();

  for (const message of messages) {
    const authorKey = normalizePubkey(message.pubkey ?? "");
    if (
      known.has(authorKey) &&
      (message.isAgent === true || message.role === "bot")
    ) {
      authored.add(authorKey);
    }

    for (const tag of message.tags ?? []) {
      if (tag[0] !== "p" && tag[0] !== "mention") continue;
      const mentionedKey = normalizePubkey(tag[1] ?? "");
      if (known.has(mentionedKey)) addressed.add(mentionedKey);
    }
  }

  return agents.filter((agent) => {
    const key = normalizePubkey(agent.pubkey);
    return authored.has(key) || addressed.has(key);
  });
}

/**
 * Select one thread's ACP transcript from a channel-scoped observer stream.
 *
 * The observer envelope does not currently carry a thread root. The production
 * seam that binds activity to a thread is the triggering published message id
 * carried by the user prompt. We then admit only items with one of those exact
 * turn ids. A session id alone is deliberately insufficient: channel-policy
 * harnesses reuse one session across several threads, so widening by session
 * would leak neighboring work into this thread. Session-only setup therefore
 * remains in the standalone activity viewer until the native observer protocol
 * carries an explicit thread scope.
 *
 * Published user prompts and successful send-message tool rows are removed
 * when their event already exists in the visible thread. The ordinary message
 * timeline remains the authority for published messages and question cards;
 * the transcript contributes the otherwise invisible coding activity.
 */
export function selectThreadSessionTranscript(
  items: readonly TranscriptItem[],
  threadMessages: readonly TimelineMessage[],
  channelId: string,
  includePublicationReceipts = false,
): ThreadSessionTranscriptSelection {
  const publishedMessageIds = new Set(
    threadMessages.map((message) => message.id.toLowerCase()),
  );
  const channelItems = items.filter((item) => item.channelId === channelId);
  const sessionIds = new Set<string>();
  const candidateTurnIds = new Set<string>();

  for (const item of channelItems) {
    if (
      item.type !== "message" ||
      item.role !== "user" ||
      !item.messageId ||
      !publishedMessageIds.has(item.messageId.toLowerCase())
    ) {
      continue;
    }
    if (item.turnId) candidateTurnIds.add(item.turnId);
  }

  // A channel-policy turn may batch prompts from several threads. A single
  // matching prompt is therefore insufficient: reject the whole turn if any
  // user prompt in it cannot be proven to belong to the visible thread.
  const turnIds = new Set(
    [...candidateTurnIds].filter((turnId) => {
      const turnPrompts = channelItems.filter(
        (item): item is Extract<TranscriptItem, { type: "message" }> =>
          item.turnId === turnId &&
          item.type === "message" &&
          item.role === "user",
      );
      return (
        turnPrompts.length > 0 &&
        turnPrompts.every(
          (item) =>
            item.type === "message" &&
            item.messageId != null &&
            publishedMessageIds.has(item.messageId.toLowerCase()),
        )
      );
    }),
  );

  for (const item of channelItems) {
    if (item.turnId && turnIds.has(item.turnId) && item.sessionId) {
      sessionIds.add(item.sessionId);
    }
  }

  const selectedItems = channelItems.filter((item) => {
    const belongsToSelection = item.turnId != null && turnIds.has(item.turnId);
    if (!belongsToSelection) return false;

    if (
      item.type === "message" &&
      item.messageId &&
      publishedMessageIds.has(item.messageId.toLowerCase())
    ) {
      return false;
    }

    if (item.type === "tool" && !includePublicationReceipts) {
      const sentMessage = getSentMessageLink(item);
      if (
        sentMessage?.channelId === channelId &&
        publishedMessageIds.has(sentMessage.messageId.toLowerCase())
      ) {
        return false;
      }
    }

    return true;
  });

  return { items: selectedItems, sessionIds, turnIds };
}
