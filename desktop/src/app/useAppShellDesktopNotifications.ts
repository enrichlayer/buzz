import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useKnownAgentPubkeys } from "@/features/agents/useKnownAgentPubkeys";
import { channelMembersQueryKey } from "@/features/channels/rosterFreshness";
import { isKnownAgentAuthor } from "@/features/messages/lib/promptSuggestions";
import {
  usersBatchEntryKey,
  type UsersBatchEntry,
} from "@/features/profile/hooks";

import {
  activateDesktopNotificationTarget,
  createDesktopNotificationActivationQueue,
  shouldBounceForChannelNotification,
} from "@/app/AppShell.helpers";
import { useCommunityJoinAlerts } from "@/features/community-members/useCommunityJoinAlerts";
import { hasMentionForEvent } from "@/features/notifications/lib/shouldNotify";
import type { NotificationSettings } from "@/features/notifications/hooks";
import {
  listenForDesktopNotificationActions,
  requestDockBounce,
  revealDesktopAppWindow,
  sendDesktopNotification,
} from "@/features/notifications/lib/desktop";
import { formatMessageNotification } from "@/features/notifications/lib/notificationFormat";
import { buildEventNotificationTarget } from "@/features/notifications/lib/target";
import {
  playNotificationSound,
  resolveSlotSound,
  shouldPlayNotificationSound,
} from "@/features/notifications/lib/sound";
import { useNotificationSenderName } from "@/features/notifications/useNotificationSenderName";
import type { Channel, ChannelMember, RelayEvent } from "@/shared/api/types";

export function useAppShellDesktopNotifications({
  channels,
  enabled,
  goChannel,
  goHome,
  notificationSettings,
  openSearchHit,
  pubkey,
  silentChannelIds,
}: {
  channels: Channel[];
  enabled: boolean;
  goChannel: (
    channelId: string,
    options?: { force?: boolean },
  ) => Promise<unknown>;
  goHome: () => Promise<unknown>;
  notificationSettings: NotificationSettings;
  openSearchHit: (
    hit: import("@/shared/api/types").SearchHit,
    behavior?: { force?: boolean },
  ) => Promise<unknown>;
  pubkey?: string;
  silentChannelIds?: ReadonlySet<string>;
}) {
  // Roster alerts are owner/admin-only and self-gating; mounted here because
  // it shares this hook's "desktop notifications are on" precondition and
  // AppShell sits at the file-size ratchet ceiling.
  useCommunityJoinAlerts({
    enabled: enabled && notificationSettings.desktopEnabled,
  });

  const resolveSenderName = useNotificationSenderName();
  const queryClient = useQueryClient();
  const knownAgentPubkeys = useKnownAgentPubkeys();
  // Same agent provenance as the timeline formatter: known agents, the
  // profile flag, or a bot-role (or agent-flagged) member of this channel.
  const isAgentAuthor = (channelId: string, authorPubkey: string) => {
    const key = authorPubkey.toLowerCase();
    return isKnownAgentAuthor(authorPubkey, {
      agentPubkeys: knownAgentPubkeys,
      profiles: {
        [key]:
          queryClient.getQueryData<UsersBatchEntry>(usersBatchEntryKey(key))
            ?.summary ?? undefined,
      },
      members: queryClient.getQueryData<ChannelMember[]>(
        channelMembersQueryKey(channelId),
      ),
    });
  };

  const handleChannelNotification = React.useEffectEvent(
    (_channelId: string, event: RelayEvent) => {
      if (!enabled) return;
      if (!shouldBounceForChannelNotification(event.tags)) return;
      if (!notificationSettings.desktopEnabled) return;
      void requestDockBounce();
    },
  );

  const handleDmNotification = React.useEffectEvent(
    (event: RelayEvent, channel: Channel) => {
      if (!enabled) return;
      if (
        !notificationSettings.desktopEnabled ||
        !notificationSettings.slotAlertsEnabled.dm
      ) {
        return;
      }

      const channelName = channel.name?.trim() || "Direct message";
      const { title, body } = formatMessageNotification({
        source: "dm",
        senderName: resolveSenderName(event.pubkey),
        channelName,
        content: event.content,
        authorIsAgent: isAgentAuthor(channel.id, event.pubkey),
      });

      void sendDesktopNotification({
        title,
        body,
        target: buildEventNotificationTarget(event, {
          id: channel.id,
          name: channelName,
        }),
      }).then((didSend) => {
        if (!didSend) return;
        if (shouldPlayNotificationSound(channel.id, silentChannelIds)) {
          playNotificationSound(resolveSlotSound(notificationSettings, "dm"));
        }
        void requestDockBounce();
      });
    },
  );

  const handleThreadReplyDesktopNotification = React.useEffectEvent(
    (channelId: string, event: RelayEvent) => {
      if (!enabled) return;
      if (
        !notificationSettings.desktopEnabled ||
        !notificationSettings.slotAlertsEnabled.thread_reply
      ) {
        return;
      }

      // Replies that @-mention the user are owned by the home-feed mention
      // path — skip them here so they don't notify (and sound) twice.
      const normalizedPubkey = pubkey?.trim().toLowerCase() ?? "";
      if (hasMentionForEvent(event, normalizedPubkey)) {
        return;
      }

      const resolvedChannel = channels.find((c) => c.id === channelId);
      const channelName = resolvedChannel?.name?.trim() ?? null;
      const { title, body } = formatMessageNotification({
        source: "thread_reply",
        senderName: resolveSenderName(event.pubkey),
        channelName,
        content: event.content,
        authorIsAgent: isAgentAuthor(channelId, event.pubkey),
      });

      void sendDesktopNotification({
        title,
        body,
        target: buildEventNotificationTarget(event, {
          id: channelId,
          name: channelName,
        }),
      }).then((didSend) => {
        if (!didSend) return;
        if (shouldPlayNotificationSound(channelId, silentChannelIds)) {
          playNotificationSound(
            resolveSlotSound(notificationSettings, "thread_reply"),
          );
        }
        void requestDockBounce();
      });
    },
  );

  const handleDesktopNotificationAction = React.useEffectEvent(
    async (
      target: import("@/features/notifications/lib/desktop").DesktopNotificationTarget,
      signal: AbortSignal,
    ) => {
      await activateDesktopNotificationTarget(
        target,
        {
          goChannel,
          goHome,
          openSearchHit,
          revealWindow: revealDesktopAppWindow,
        },
        signal,
      );
    },
  );

  React.useEffect(() => {
    if (!enabled) return;
    let isCancelled = false;
    let cleanup = () => {};
    const activationQueue = createDesktopNotificationActivationQueue(
      (target, signal) => handleDesktopNotificationAction(target, signal),
      (error) => {
        console.error("Failed to activate desktop notification", error);
      },
    );

    void listenForDesktopNotificationActions((target) => {
      if (isCancelled) {
        return;
      }

      activationQueue.enqueue(target);
    }).then((dispose) => {
      if (isCancelled) {
        dispose();
        return;
      }

      cleanup = dispose;
    });

    return () => {
      isCancelled = true;
      activationQueue.cancel();
      cleanup();
    };
  }, [enabled]);

  return {
    handleChannelNotification,
    handleDmNotification,
    handleThreadReplyDesktopNotification,
  };
}
