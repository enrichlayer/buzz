import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { Button } from "@/shared/ui/button";
import { useOpenEntityLink } from "@/shared/ui/markdown/entityLinks";
import type { Repository } from "../projectModels";
import { fetchReviewBundle } from "../reviewBundleFetch";
import { useRefreshingReviewQuery } from "../useRefreshingReviewQuery";
import { ReviewBundleCard } from "./ReviewBundleCard";

/**
 * The Reviews tab's view of one `buzz://bundle` link. A member's "Review
 * changes" selects that pull request in place, so the stack stays one
 * route away while each member is reviewed in the existing workspace.
 */
export function ProjectReviewBundlePanel({
  bundleId,
  onSelectPullRequest,
  repository,
}: {
  bundleId: string;
  onSelectPullRequest: (pullRequestId: string | null) => void;
  repository: Repository;
}) {
  const origin = useRelayOrigin();
  const identity = useIdentityQuery();
  const openEntityLink = useOpenEntityLink();
  const query = useRefreshingReviewQuery({
    queryKey: ["review-bundle", origin, identity.data?.pubkey, bundleId],
    enabled: Boolean(origin && identity.data?.pubkey),
    queryFn: ({ signal }) =>
      fetchReviewBundle(
        async (filter) => {
          signal.throwIfAborted();
          const events = await relayClient.fetchEvents(filter);
          signal.throwIfAborted();
          return events;
        },
        bundleId,
        signal,
      ),
    retry: 1,
  });
  const state = query.data ?? null;
  const foreign =
    state !== null && state.bundle.repository !== repository.repoAddress;
  return (
    <section
      aria-label="Review stack"
      data-testid="project-review-bundle"
      className="border-b border-border/70 px-3 py-2"
    >
      {query.isError ? (
        <div role="alert" className="text-sm text-destructive">
          <p>
            {query.error instanceof Error
              ? query.error.message
              : "The review stack could not be loaded."}
          </p>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry
          </Button>
        </div>
      ) : query.isPending ? (
        <p className="text-sm text-muted-foreground">Loading review stack…</p>
      ) : state === null || foreign ? (
        <p className="text-sm text-muted-foreground" role="status">
          {foreign
            ? "This review stack belongs to another repository."
            : "No trusted review stack was found under this link."}
        </p>
      ) : (
        <ReviewBundleCard
          state={state}
          viewerPubkey={identity.data?.pubkey}
          onOpenReview={(link) =>
            link.type === "pr" && link.owner === repository.owner
              ? onSelectPullRequest(link.id)
              : openEntityLink(link)
          }
          onOpenUrl={(url) =>
            void openUrl(url).catch(() =>
              toast.error("Could not open the link."),
            )
          }
        />
      )}
    </section>
  );
}
