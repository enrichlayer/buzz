import { agentPromptPolicy } from "./agentPrompt";

/**
 * Registered artifact-type plugins. Adding a card type means adding its
 * policy here and its card in `cards.tsx`; the type checker rejects a policy
 * without a card.
 */
export const ARTIFACT_TYPE_POLICIES = [agentPromptPolicy] as const;

type RegisteredPolicy = (typeof ARTIFACT_TYPE_POLICIES)[number];
export type ArtifactTypePluginId = RegisteredPolicy["id"];

const POLICY_BY_TYPE: ReadonlyMap<string, RegisteredPolicy> = new Map(
  ARTIFACT_TYPE_POLICIES.map((policy) => [policy.type, policy]),
);

export function getArtifactTypePolicy(
  type: string | undefined,
): RegisteredPolicy | undefined {
  return type === undefined ? undefined : POLICY_BY_TYPE.get(type);
}

export function isRegisteredArtifactType(type: string): boolean {
  return POLICY_BY_TYPE.has(type);
}
