import { diffPolicy } from "./diff";
import { huddleStartedPolicy } from "./huddleStarted";
import type { MessageKindPolicy } from "./types";

/**
 * Registered message-kind plugins. Adding a card type means adding its policy
 * here and its card in `cards.tsx`; the type checker rejects a policy without
 * a card.
 */
export const MESSAGE_KIND_POLICIES = [diffPolicy, huddleStartedPolicy] as const;

type RegisteredPolicy = (typeof MESSAGE_KIND_POLICIES)[number];
export type MessageKindPluginId = RegisteredPolicy["id"];

const POLICY_BY_KIND: ReadonlyMap<number, RegisteredPolicy> = new Map(
  MESSAGE_KIND_POLICIES.map((policy) => [policy.kind, policy]),
);

export function getMessageKindPolicy(
  kind: number | undefined,
): RegisteredPolicy | undefined {
  return kind === undefined ? undefined : POLICY_BY_KIND.get(kind);
}

function kindsWhere(
  predicate: (policy: MessageKindPolicy) => boolean,
): number[] {
  return MESSAGE_KIND_POLICIES.filter(predicate).map((policy) => policy.kind);
}

/** Every plugin kind; each renders its own timeline row. */
export const PLUGIN_TIMELINE_KINDS = kindsWhere(() => true);
export const PLUGIN_NON_UNREAD_KINDS = kindsWhere((p) => !p.countsAsUnread);
export const PLUGIN_DM_NOTIFIABLE_KINDS = kindsWhere((p) => p.notifiesInDm);
export const PLUGIN_TYPING_COMPLETION_KINDS = kindsWhere((p) => p.endsTyping);
export const PLUGIN_WORKFLOW_PICKABLE_KINDS = kindsWhere(
  (p) => p.workflowPickable,
);

export function isSystemCardKind(kind: number | undefined): boolean {
  return getMessageKindPolicy(kind)?.systemCard ?? false;
}
