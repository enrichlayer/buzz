import type { UserProfileLookup } from "@/features/profile/lib/identity";
import { getArtifactTypeCard } from "@/shared/plugins/artifactTypes/cards";

import { useRootArtifacts } from "./channelArtifactSubscriptions";

/** Cards for the registered artifacts anchored to one message. */
export function ArtifactAttachments({
  channelId,
  currentPubkey,
  profiles,
  rootId,
}: {
  channelId: string;
  currentPubkey?: string;
  profiles?: UserProfileLookup;
  rootId: string;
}) {
  const artifacts = useRootArtifacts(channelId, rootId);
  if (artifacts.length === 0) return null;
  return (
    <div className="mt-2 flex flex-col gap-2">
      {artifacts.map((artifact) => {
        const Card = getArtifactTypeCard(artifact.type);
        return Card ? (
          <Card
            artifact={artifact}
            channelId={channelId}
            currentPubkey={currentPubkey}
            key={artifact.d}
            profiles={profiles}
          />
        ) : null;
      })}
    </div>
  );
}
