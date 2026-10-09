import { getSentMessageLink } from "@/features/agents/ui/AgentSessionToolItem/messageLinks";
import { PublicationReceipt } from "@/features/agents/ui/PublicationReceipt";
import * as React from "react";
import { CircleAlert, Octagon, Radio } from "lucide-react";
import { toast } from "sonner";

import { useExactActiveAgentTurns } from "@/features/agents/activeAgentTurnsStore";
import { awaitCancelTurnOutcome } from "@/features/agents/lib/cancelTurnOutcome";
import {
  ensureRelayObserverSubscription,
  subscribeControlResults,
} from "@/features/agents/observerRelayStore";
import {
  mergeObserverEventWindows,
  scopeByChannel,
} from "@/features/agents/ui/agentSessionPanelLayout";
import {
  canStopAgentThreadSession,
  selectThreadSessionTranscript,
  shouldOfferOlderThreadSessionActivity,
} from "@/features/agents/ui/agentThreadSession";
import { TranscriptActivityItem } from "@/features/agents/ui/activityRenderClasses/TranscriptActivityItem";
import { SessionChanges } from "@/features/agents/ui/SessionChanges";
import { SessionViewControl } from "@/features/agents/ui/SessionViewControl";
import { SessionPermissionPolicy } from "@/features/agents/ui/SessionPermissionPolicy";
import {
  visibleSessionItems,
  sessionActivityAnchor,
  sessionOutcome,
  type SessionView,
} from "@/features/agents/ui/threadSessionPresentation";
import {
  useThreadActivityFragments,
  useThreadVisibleMessageIds,
} from "@/features/messages/ui/ThreadSessionTimeline";
import { buildTranscriptState } from "@/features/agents/ui/agentSessionTranscript";
import {
  useArchivedChannelEvents,
  useObserverEvents,
} from "@/features/agents/ui/useObserverEvents";
import type { ChannelAgentSessionAgent } from "@/features/channels/ui/useChannelAgentSessions";
import type { TimelineMessage } from "@/features/messages/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { cancelManagedAgentTurn } from "@/shared/api/agentControl";
import { Button } from "@/shared/ui/button";
import {
  AnnotationSubmitProvider,
  type AnnotationSubmitRequest,
} from "@/shared/ui/annotations";

type AgentThreadSessionActivityProps = {
  agent: ChannelAgentSessionAgent;
  archiveError: string | null;
  channelId: string;
  hasOlderArchived: boolean;
  isDirectMessage: boolean;
  profiles?: UserProfileLookup;
  onLoadOlderArchived: () => Promise<void>;
  onSendFeedback: (message: string, agentPubkey: string) => Promise<void>;
  threadMessages: readonly TimelineMessage[];
  threadRootId: string;
};

/**
 * Thread-local projection of one agent's observer transcript. Published
 * messages remain owned by MessageThreadPanel; this section contributes only
 * the coding activity tied to exact turns triggered by this thread.
 */
export function AgentThreadSessionActivity({
  agent,
  archiveError,
  channelId,
  hasOlderArchived,
  isDirectMessage,
  profiles,
  onLoadOlderArchived,
  onSendFeedback,
  threadMessages,
  threadRootId,
}: AgentThreadSessionActivityProps) {
  const hasObserver = agent.status === "running" || agent.status === "deployed";
  const { errorMessage, events, connectionState } = useObserverEvents(
    hasObserver,
    agent.pubkey,
  );
  const archivedEvents = useArchivedChannelEvents(agent.pubkey, channelId);
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const [view, setView] = React.useState<SessionView>(
    agent.outputMode === "summary" ? "conversation" : "activity",
  );

  const channelEvents = React.useMemo(
    () => scopeByChannel(events, channelId),
    [channelId, events],
  );
  const combinedEvents = React.useMemo(
    () => mergeObserverEventWindows(channelEvents, archivedEvents),
    [archivedEvents, channelEvents],
  );
  const transcript = React.useMemo(
    () => buildTranscriptState(combinedEvents).items,
    [combinedEvents],
  );
  const selection = React.useMemo(
    () =>
      selectThreadSessionTranscript(
        transcript,
        threadMessages,
        channelId,
        true,
      ),
    [channelId, threadMessages, transcript],
  );
  const visibleItems = React.useMemo(
    () => visibleSessionItems(selection.items, view),
    [selection.items, view],
  );
  const exactActiveTurns = useExactActiveAgentTurns(agent.pubkey);
  const isTurnLive = exactActiveTurns.some(
    (turn) =>
      turn.channelId === channelId && selection.turnIds.has(turn.turnId),
  );
  const hasBoundTurn = selection.turnIds.size > 0;
  const hasExactThreadControl = canStopAgentThreadSession({
    canInterruptTurn: agent.canInterruptTurn,
    isDirectMessage,
    sessionPolicy: agent.sessionPolicy,
  });
  const canStopCurrentTurn =
    hasBoundTurn && isTurnLive && hasExactThreadControl;
  const offerOlderActivity = shouldOfferOlderThreadSessionActivity({
    hasBoundTurn,
    hasOlderArchived,
    publishedMessageCount: threadMessages.length,
  });
  const handleAnnotationSubmit = React.useCallback(
    async (request: AnnotationSubmitRequest) => {
      await onSendFeedback(request.message, agent.pubkey);
    },
    [agent.pubkey, onSendFeedback],
  );

  const visibleMessageIds = useThreadVisibleMessageIds();
  const anchorMessages = React.useMemo(
    () =>
      visibleMessageIds
        ? threadMessages.filter((message) =>
            visibleMessageIds.includes(message.id),
          )
        : threadMessages,
    [threadMessages, visibleMessageIds],
  );
  const fragments = React.useMemo(
    () =>
      visibleItems.flatMap((item) => {
        const afterMessageId = sessionActivityAnchor(item, anchorMessages);
        if (!afterMessageId) return [];
        const publication =
          item.type === "tool" ? getSentMessageLink(item) : null;
        const isPublished =
          publication?.channelId === channelId &&
          threadMessages.some(
            (message) =>
              message.id.toLowerCase() === publication.messageId.toLowerCase(),
          );
        const activity =
          isPublished && item.type === "tool" ? (
            <PublicationReceipt key={item.id} item={item} />
          ) : (
            <TranscriptActivityItem
              key={item.id}
              agentAvatarUrl={
                profiles?.[agent.pubkey.toLowerCase()]?.avatarUrl ?? null
              }
              agentName={agent.name}
              agentPubkey={agent.pubkey}
              profiles={profiles}
              item={item}
            />
          );
        const diagnostic =
          item.type === "metadata" ||
          (item.type === "lifecycle" &&
            [
              "Mode",
              "Commands",
              "Usage",
              "Session ready",
              "Turn started",
            ].includes(item.title));
        return [
          {
            id: `${agent.pubkey}:${item.id}`,
            agentName: agent.name,
            agentId: agent.pubkey,
            turnId: item.turnId,
            afterMessageId,
            timestamp: item.timestamp,
            content: (
              <AnnotationSubmitProvider
                onSubmit={handleAnnotationSubmit}
                scope={{
                  id: `agent-thread:${channelId}:${threadRootId}:${agent.pubkey}:${item.id}`,
                  channelId,
                  label: `${agent.name} in this thread`,
                }}
              >
                <div
                  data-session-event={item.id}
                  data-session-supporting={
                    view !== "full" && item.type === "message"
                      ? "true"
                      : undefined
                  }
                  className="min-w-0"
                >
                  <span className="sr-only">{agent.name}: </span>
                  {diagnostic ? (
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">
                        Diagnostics · {item.title}
                      </summary>
                      {activity}
                    </details>
                  ) : (
                    activity
                  )}
                </div>
              </AnnotationSubmitProvider>
            ),
          },
        ];
      }),
    [
      visibleItems,
      view,
      threadMessages,
      channelId,
      anchorMessages,
      profiles,
      agent.pubkey,
      agent.name,
      handleAnnotationSubmit,
      threadRootId,
    ],
  );
  useThreadActivityFragments(agent.pubkey, fragments);
  const outcome = sessionOutcome(
    combinedEvents,
    selection.turnIds,
    isTurnLive,
    connectionState === "closed" || connectionState === "error",
  );

  const handleInterruptTurn = React.useCallback(async () => {
    if (!canStopCurrentTurn) return;

    try {
      const requestId = crypto.randomUUID();
      const outcome = await awaitCancelTurnOutcome({
        requestId,
        channelId,
        threadRootEventId: threadRootId,
        subscribe: (listener) =>
          subscribeControlResults(agent.pubkey, listener),
        sendCancel: async () => {
          await ensureRelayObserverSubscription();
          await cancelManagedAgentTurn(
            agent.pubkey,
            channelId,
            requestId,
            threadRootId,
          );
        },
        scheduleTimeout: (onTimeout) => {
          const timeout = window.setTimeout(onTimeout, 8_000);
          return () => window.clearTimeout(timeout);
        },
      });

      if (outcome === "ambiguous_target") {
        toast.error(
          "This coding session could not be targeted safely, so nothing was stopped.",
        );
        return;
      }
      if (outcome === "no_active_turn") {
        toast.info("No active turn exists for this thread.");
        return;
      }
      if (outcome === "unconfirmed") {
        toast.info("Stop requested, but the agent hasn't confirmed it.");
        return;
      }
      toast.success(
        `Stop signal sent to ${agent.name}. It may take a moment to respond.`,
      );
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : `Failed to stop ${agent.name}'s current turn.`,
      );
    }
  }, [agent.name, agent.pubkey, canStopCurrentTurn, channelId, threadRootId]);

  const handleLoadOlder = React.useCallback(async () => {
    if (isLoadingOlder) return;
    setIsLoadingOlder(true);
    try {
      await onLoadOlderArchived();
    } finally {
      setIsLoadingOlder(false);
    }
  }, [isLoadingOlder, onLoadOlderArchived]);

  if (!hasBoundTurn) {
    if (!offerOlderActivity) return null;
    return (
      <section
        aria-label={`${agent.name} older coding session activity`}
        className="border-y border-border/70 bg-muted/15 px-3 py-3"
        data-testid="agent-thread-session-recovery"
      >
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-medium">Older coding session</h3>
            <p className="text-xs text-muted-foreground">
              Load older activity to reconnect this thread to its coding turn.
            </p>
          </div>
          <Button
            disabled={isLoadingOlder}
            onClick={() => void handleLoadOlder()}
            size="sm"
            type="button"
            variant="outline"
          >
            {isLoadingOlder ? "Loading…" : "Load older"}
          </Button>
        </div>
        {archiveError ? (
          <p
            className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            role="alert"
          >
            <CircleAlert
              aria-hidden="true"
              className="mt-0.5 h-4 w-4 shrink-0"
            />
            <span>{archiveError}</span>
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section
      aria-label={`${agent.name} coding session`}
      className="border-y border-border/70 bg-muted/15 px-3 py-3"
      data-testid="agent-thread-session-activity"
    >
      <div className="mb-3 flex items-center gap-2">
        <Radio
          aria-hidden="true"
          className={
            isTurnLive
              ? "h-3.5 w-3.5 text-primary"
              : "h-3.5 w-3.5 text-muted-foreground"
          }
        />
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-sm font-medium">Coding session</h3>
          <p className="truncate text-xs text-muted-foreground">
            {agent.name} · <span role="status">{outcome}</span>
          </p>
        </div>
        <Button
          aria-label={`Stop ${agent.name}'s turn in this thread`}
          disabled={!canStopCurrentTurn}
          onClick={() => void handleInterruptTurn()}
          size="sm"
          title={
            canStopCurrentTurn
              ? "Stop the current turn in this thread"
              : !agent.canInterruptTurn
                ? "Only locally managed agents can be interrupted here."
                : !hasExactThreadControl
                  ? isDirectMessage
                    ? "Direct-message sessions cannot be stopped from a thread safely."
                    : "This agent shares one session across the channel, so thread-specific Stop is unavailable."
                  : "Available while this thread's turn is working."
          }
          type="button"
          variant="ghost"
        >
          <Octagon aria-hidden="true" className="h-3.5 w-3.5" />
          Stop
        </Button>
      </div>

      <SessionViewControl value={view} onChange={setView} />
      <SessionPermissionPolicy
        events={combinedEvents.filter(
          (event) =>
            event.turnId != null && selection.turnIds.has(event.turnId),
        )}
      />
      <SessionChanges items={selection.items} />
      <p className="text-xs text-muted-foreground">
        Activity appears between messages. Select any text or code to comment;
        Command/Ctrl+Shift+M opens feedback.
      </p>

      {errorMessage ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </p>
      ) : null}
    </section>
  );
}
