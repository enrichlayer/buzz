import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { useOpenEntityLink } from "@/shared/ui/markdown/entityLinks";
import { Button } from "@/shared/ui/button";
import { fetchThreadReviewSurface } from "../threadReviews";
import { useRefreshingReviewQuery } from "../useRefreshingReviewQuery";
import { ReviewBundleCard } from "./ReviewBundleCard";
import { ThreadReviewList } from "./ThreadReviewList";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

/** Durable review access remains available when a coding agent is offline. */
export function ThreadReviews({
  channelId,
  threadRootId,
}: {
  channelId: string;
  threadRootId: string;
}) {
  const origin = useRelayOrigin();
  const identity = useIdentityQuery();
  const openReview = useOpenEntityLink();
  const query = useRefreshingReviewQuery({
    queryKey: [
      "thread-reviews",
      origin,
      identity.data?.pubkey,
      channelId,
      threadRootId,
    ],
    enabled: Boolean(origin && identity.data?.pubkey),
    queryFn: ({ signal }) =>
      fetchThreadReviewSurface(
        async (filter) => {
          signal.throwIfAborted();
          const events = await relayClient.fetchEvents(filter);
          signal.throwIfAborted();
          return events;
        },
        channelId,
        threadRootId,
      ),
    retry: 1,
  });
  const bundles = query.data?.bundles ?? [];
  // A review that belongs to a stack is shown inside its card, in stack order.
  const bundled = new Set(
    bundles.flatMap((state) => state.members.map((row) => row.pullRequest.id)),
  );
  const reviews = (query.data?.reviews ?? []).filter(
    (review) => !bundled.has(review.id),
  );
  const openIssue = (url: string) =>
    void openUrl(url).catch(() => toast.error("Could not open the link."));
  if (!query.data?.reviews.length && !query.isError) return null;
  return (
    <section
      aria-label="Coding session reviews"
      className="border-b border-border/70 px-3 py-3"
    >
      <h3 className="text-sm font-medium">Review changes</h3>
      {query.isError ? (
        <div role="alert" className="my-2 text-sm text-destructive">
          <p>
            {query.error instanceof Error
              ? query.error.message
              : "Reviews could not be loaded."}
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
      ) : null}
      {bundles.map((state) => (
        <ReviewBundleCard
          key={state.bundle.id}
          state={state}
          viewerPubkey={identity.data?.pubkey}
          onOpenReview={openReview}
          onOpenUrl={openIssue}
        />
      ))}
      <ThreadReviewList
        reviews={reviews}
        onOpenReview={openReview}
        onOpenIssue={openIssue}
      />
    </section>
  );
}
