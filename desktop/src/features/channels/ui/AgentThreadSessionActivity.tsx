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
import { AgentSessionTranscriptList } from "@/features/agents/ui/AgentSessionTranscriptList";
import { AgentSessionOutputModeControl } from "@/features/agents/ui/AgentSessionOutputModeControl";
import { presentAgentSessionTranscript } from "@/features/agents/ui/agentSessionOutputMode";
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
  const { errorMessage, events } = useObserverEvents(hasObserver, agent.pubkey);
  const archivedEvents = useArchivedChannelEvents(agent.pubkey, channelId);
  const [isLoadingOlder, setIsLoadingOlder] = React.useState(false);
  const [showDetails, setShowDetails] = React.useState(false);

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
    () => selectThreadSessionTranscript(transcript, threadMessages, channelId),
    [channelId, threadMessages, transcript],
  );
  const presentation = React.useMemo(
    () =>
      presentAgentSessionTranscript(
        selection.items,
        agent.outputMode,
        showDetails,
      ),
    [agent.outputMode, selection.items, showDetails],
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
            {agent.name} · {isTurnLive ? "Working" : "Session activity"}
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

      <div
        className="mb-2 flex justify-end"
        data-testid="agent-session-output-mode"
      >
        <AgentSessionOutputModeControl
          hiddenCount={presentation.hiddenCount}
          onShowDetailsChange={setShowDetails}
          outputMode={agent.outputMode}
          showDetails={showDetails}
        />
      </div>

      <AnnotationSubmitProvider
        onSubmit={handleAnnotationSubmit}
        scope={{
          id: `agent-thread:${channelId}:${threadRootId}:${agent.pubkey}`,
          channelId,
          label: `${agent.name} in this thread`,
        }}
      >
        <AgentSessionTranscriptList
          agentAvatarUrl={
            profiles?.[agent.pubkey.toLowerCase()]?.avatarUrl ?? null
          }
          agentName={agent.name}
          agentPubkey={agent.pubkey}
          channelId={channelId}
          contentContainerClassName="gap-3"
          emptyDescription={
            presentation.hiddenCount > 0
              ? "Routine activity is hidden in summary view."
              : `Waiting for ${agent.name}'s next session update.`
          }
          isTurnLive={isTurnLive}
          items={presentation.items}
          profiles={profiles}
          scrollScopeKey={`${agent.pubkey}:${channelId}:${threadRootId}`}
        />
      </AnnotationSubmitProvider>

      {errorMessage ? (
        <p className="mt-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </p>
      ) : null}
    </section>
  );
}
