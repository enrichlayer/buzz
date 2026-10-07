/**
 * Everything the desktop needs to know about one message kind, outside of
 * how its card looks. Each flag replaces a hand-maintained kind check that
 * used to be scattered across the timeline, unread, typing, DM-notification,
 * workflow and message-action code.
 *
 * Kept free of React so constants, query builders and node tests can import
 * it. The card component lives in `cards.tsx`, keyed by the same `id`.
 */
export type MessageKindPolicy = {
  /** Stable plugin name; `cards.tsx` must register a card under it. */
  id: string;
  /** The event kind this plugin owns. Rendered as its own timeline row. */
  kind: number;
  /** Counts toward the channel's unread pill. */
  countsAsUnread: boolean;
  /** Fires a desktop notification when it arrives in a DM. */
  notifiesInDm: boolean;
  /** Clears the author's typing indicator when it arrives. */
  endsTyping: boolean;
  /** Offered as a message to pick when configuring a workflow. */
  workflowPickable: boolean;
  /**
   * A card rather than an authored message: it cannot be copied, linked,
   * reported, edited or deleted, and never shows a thread summary.
   */
  systemCard: boolean;
};
