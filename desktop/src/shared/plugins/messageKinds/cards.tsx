import type * as React from "react";
import { HuddleAttachment } from "@/features/huddle/components/HuddleAttachment";
import { DiffMessageCard } from "@/features/messages/ui/DiffMessageCard";
import type { TimelineMessage } from "@/features/messages/types";
import { getMessageKindPolicy, type MessageKindPluginId } from "./policies";

export type MessageKindCardProps = {
  message: TimelineMessage;
  channelId: string | null;
  searchQuery?: string;
};

type MessageKindCard = React.ComponentType<MessageKindCardProps>;

function HuddleStartedCard({ message, channelId }: MessageKindCardProps) {
  return (
    <HuddleAttachment
      channelId={channelId}
      className="mt-2"
      message={message}
    />
  );
}

/** One card per registered policy; a missing entry is a type error. */
const MESSAGE_KIND_CARDS: Record<MessageKindPluginId, MessageKindCard> = {
  diff: DiffMessageCard,
  "huddle-started": HuddleStartedCard,
};

export function getMessageKindCard(
  kind: number | undefined,
): MessageKindCard | undefined {
  const policy = getMessageKindPolicy(kind);
  return policy ? MESSAGE_KIND_CARDS[policy.id] : undefined;
}
