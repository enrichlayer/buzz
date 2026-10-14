import * as React from "react";

import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { effectiveCloneUrls } from "./lib/projectCloneUrl";
import type { ProjectRepoHost } from "./lib/projectRepoHost";
import type { Repository } from "./projectModels";

/** Resolve implicit Git URLs reactively before passing a repository to queries. */
export function useResolvedProjectRepository(
  repository: Repository | null | undefined,
): Repository | null | undefined {
  const relayOrigin = useRelayOrigin();
  return React.useMemo(() => {
    if (!repository) return repository;
    // Event tags distinguish explicit URLs from a default derived for an older
    // relay origin. Older read models without tags retain their known URLs.
    const advertised = repository.eventTags
      ? (repository.eventTags
          .find((tag) => tag[0] === "clone")
          ?.slice(1)
          .filter(Boolean) ?? [])
      : repository.cloneUrls;
    const cloneUrls = effectiveCloneUrls(
      advertised,
      relayOrigin,
      repository.owner,
      repository.dtag,
    );
    return cloneUrls.length === repository.cloneUrls.length &&
      cloneUrls.every((url, index) => url === repository.cloneUrls[index])
      ? repository
      : { ...repository, cloneUrls };
  }, [repository, relayOrigin]);
}

/** Disabled external snapshots are intentional; unresolved relay discovery is not. */
export function projectRepositorySnapshotLoading(
  host: ProjectRepoHost,
  isPending: boolean,
): boolean {
  return host.kind !== "external" && isPending;
}
