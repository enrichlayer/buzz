import * as React from "react";
import type { MessageThreadPanel } from "./MessageThreadPanel";
import type { AnnotationSubmitRequest } from "@/shared/ui/annotations";

type Props = Pick<
  React.ComponentProps<typeof MessageThreadPanel>,
  | "disabled"
  | "isSending"
  | "channelId"
  | "threadHead"
  | "threadReplies"
  | "onSend"
>;

/** Capture the thread destination independently of the selected content's author. */
export function useThreadAnnotationSubmit({
  disabled,
  isSending,
  channelId,
  threadHead,
  threadReplies,
  onSend,
}: Props) {
  const threadHeadId = threadHead?.id ?? null;
  return React.useCallback(
    async (request: AnnotationSubmitRequest) => {
      const source = [
        threadHead,
        ...threadReplies.map((entry) => entry.message),
      ].find((message) => message?.id === request.anchor.sourceId);
      if (
        disabled ||
        isSending ||
        !channelId ||
        !threadHeadId ||
        (request.destination?.channelId ?? request.anchor.channelId) !==
          channelId
      ) {
        throw new Error(
          "This response is no longer available for feedback in this thread.",
        );
      }
      await onSend(
        request.message,
        source?.pubkey ? [source.pubkey] : [],
        undefined,
        channelId,
        {
          parentEventId: source?.id ?? threadHeadId,
          threadHeadId,
        },
      );
    },
    [
      channelId,
      disabled,
      isSending,
      onSend,
      threadHead,
      threadHeadId,
      threadReplies,
    ],
  );
}
