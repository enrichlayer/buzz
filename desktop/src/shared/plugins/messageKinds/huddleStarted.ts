import type { MessageKindPolicy } from "./types";

export const KIND_HUDDLE_STARTED = 48100;

/** The visible huddle session card. In a DM the card is the invite. */
export const huddleStartedPolicy = {
  id: "huddle-started",
  kind: KIND_HUDDLE_STARTED,
  countsAsUnread: false,
  notifiesInDm: true,
  endsTyping: false,
  workflowPickable: false,
  systemCard: true,
} as const satisfies MessageKindPolicy;
