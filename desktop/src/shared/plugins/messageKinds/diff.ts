import type { MessageKindPolicy } from "./types";

export const KIND_STREAM_MESSAGE_DIFF = 40008;

/** Code diffs posted with `buzz messages send-diff`. */
export const diffPolicy = {
  id: "diff",
  kind: KIND_STREAM_MESSAGE_DIFF,
  countsAsUnread: true,
  notifiesInDm: false,
  endsTyping: true,
  workflowPickable: true,
  systemCard: false,
} as const satisfies MessageKindPolicy;
