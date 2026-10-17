import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { useOpenEntityLink } from "@/shared/ui/markdown/entityLinks";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { fetchLinearTaskReviews } from "../linearTaskReviews";
import { useRefreshingReviewQuery } from "../useRefreshingReviewQuery";
import { ThreadReviewList } from "./ThreadReviewList";

/** Reviews remain discoverable after the originating agent has stopped. */
export function LinearTaskReviews({ address }: { address: string }) {
  const origin = useRelayOrigin();
  const identity = useIdentityQuery();
  const openReview = useOpenEntityLink();
  const query = useRefreshingReviewQuery({
    queryKey: ["linear-task-reviews", origin, identity.data?.pubkey, address],
    enabled: Boolean(origin && identity.data?.pubkey),
    retry: 1,
    queryFn: ({ signal }) =>
      fetchLinearTaskReviews(async (filter) => {
        signal.throwIfAborted();
        const result = await relayClient.fetchEvents(filter);
        signal.throwIfAborted();
        return result;
      }, address),
  });
  return (
    <section aria-label="Task reviews" className="space-y-3">
      <h2 className="text-base font-semibold">Reviews</h2>
      {query.isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>Reviews could not be fully loaded.</p>
          <Button
            variant="outline"
            disabled={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Retry reviews
          </Button>
        </div>
      ) : query.isLoading ? (
        <p role="status" className="text-sm text-muted-foreground">
          Loading reviews…
        </p>
      ) : query.data?.length ? (
        <ThreadReviewList
          reviews={query.data}
          onOpenReview={openReview}
          onOpenIssue={(url) =>
            void openUrl(url).catch(() => toast.error("Could not open Linear."))
          }
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          No reviews are linked yet. Reviews published by an agent working in
          this task’s coding thread appear here with their commit and review
          state.
        </p>
      )}
    </section>
  );
}
