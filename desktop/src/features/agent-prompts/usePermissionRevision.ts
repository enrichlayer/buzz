import * as React from "react";

import type { ArtifactRevision } from "@/features/artifacts/artifactEnvelope";
import { fetchArtifactRevisions } from "@/features/artifacts/channelArtifactSubscriptions";

import {
  MAX_PERMISSION_CHAIN,
  needsPermissionChain,
  resolvePermissionRevision,
} from "./permissionRevision";

type Resolved = { headId: string; revision: ArtifactRevision };

/**
 * The revision a card should render: the head itself, unless it may be a
 * member's revision on a permission card, in which case the chain-resolved
 * revision. `undefined` while that chain is loading.
 */
export function usePermissionRevision(
  artifact: ArtifactRevision,
  channelId: string,
): ArtifactRevision | undefined {
  const needsChain = React.useMemo(
    () => needsPermissionChain(artifact),
    [artifact],
  );
  const [resolved, setResolved] = React.useState<Resolved | null>(null);
  React.useEffect(() => {
    if (!needsChain) return;
    let live = true;
    const settle = (revision: ArtifactRevision | null) => {
      // Not a resolvable permission chain: show the head, as before.
      if (live)
        setResolved({ headId: artifact.id, revision: revision ?? artifact });
    };
    fetchArtifactRevisions(
      channelId,
      artifact.d,
      MAX_PERMISSION_CHAIN + 1,
    ).then(
      (revisions) => settle(resolvePermissionRevision(artifact, revisions)),
      () => settle(null),
    );
    return () => {
      live = false;
    };
  }, [artifact, channelId, needsChain]);
  if (!needsChain) return artifact;
  return resolved?.headId === artifact.id ? resolved.revision : undefined;
}
