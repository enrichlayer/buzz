import type * as React from "react";
import { AgentPromptCard } from "@/features/agent-prompts/AgentPromptCard";
import type { ArtifactRevision } from "@/features/artifacts/artifactEnvelope";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { type ArtifactTypePluginId, getArtifactTypePolicy } from "./policies";

export type ArtifactTypeCardProps = {
  /** The artifact's current revision. */
  artifact: ArtifactRevision;
  channelId: string;
  currentPubkey?: string;
  profiles?: UserProfileLookup;
};

type ArtifactTypeCard = React.ComponentType<ArtifactTypeCardProps>;

/** One card per registered policy; a missing entry is a type error. */
const ARTIFACT_TYPE_CARDS: Record<ArtifactTypePluginId, ArtifactTypeCard> = {
  "agent-prompt": AgentPromptCard,
};

export function getArtifactTypeCard(
  type: string | undefined,
): ArtifactTypeCard | undefined {
  const policy = getArtifactTypePolicy(type);
  return policy ? ARTIFACT_TYPE_CARDS[policy.id] : undefined;
}
