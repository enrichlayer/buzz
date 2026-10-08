import type { ReactNode } from "react";
import type { Channel } from "@/shared/api/types";
import type { useSendMessageMutation } from "@/features/messages/hooks";
import type { TimelineMessage } from "@/features/messages/types";
import { AnnotationSubmitProvider } from "@/shared/ui/annotations";

type SendMessage = ReturnType<typeof useSendMessageMutation>["mutateAsync"];

/** Channel-level destination for selections outside a more specific thread. */
export function ChannelAnnotationScope({
  channel,
  messages,
  onSend,
  children,
}: {
  channel: Channel | null;
  messages: readonly TimelineMessage[];
  onSend: SendMessage;
  children: ReactNode;
}) {
  if (!channel) return children;
  return (
    <AnnotationSubmitProvider
      scope={{
        id: `channel:${channel.id}`,
        channelId: channel.id,
        label: `#${channel.name}`,
        priority: 10,
      }}
      onSubmit={async (request) => {
        if (
          !channel.isMember ||
          channel.archivedAt ||
          request.destination?.channelId !== channel.id
        ) {
          throw new Error("This conversation is not available for comments.");
        }
        const source = messages.find(
          (message) =>
            message.id === request.anchor.sourceId && !message.pending,
        );
        await onSend({
          channelId: channel.id,
          content: request.message,
          mentionPubkeys: source?.pubkey ? [source.pubkey] : [],
          parentEventId: source?.id,
        });
      }}
    >
      {children}
    </AnnotationSubmitProvider>
  );
}
