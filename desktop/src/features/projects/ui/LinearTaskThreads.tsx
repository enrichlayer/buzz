import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useIdentityQuery } from "@/shared/api/hooks";
import { relayClient } from "@/shared/api/relayClient";
import { useRelayOrigin } from "@/shared/lib/useRelayOrigin";
import { Button } from "@/shared/ui/button";
import { splitProjectDetailAgentContext } from "../lib/projectDetailAgentContext";
import { fetchLinearTaskThreads } from "../linearTaskReviews";
import { useRefreshingReviewQuery } from "../useRefreshingReviewQuery";

/** Open the actual root; never infer a session from adjacent activity. */
export function LinearTaskThreads({
  address,
  channelId,
}: {
  address: string;
  channelId: string;
}) {
  const origin = useRelayOrigin();
  const identity = useIdentityQuery();
  const { goChannel } = useAppNavigation();
  const query = useRefreshingReviewQuery({
    queryKey: [
      "linear-task-threads",
      origin,
      identity.data?.pubkey,
      address,
      channelId,
    ],
    enabled: Boolean(origin && identity.data?.pubkey),
    retry: 1,
    queryFn: ({ signal }) =>
      fetchLinearTaskThreads(
        async (filter) => {
          signal.throwIfAborted();
          const events = await relayClient.fetchEvents(filter);
          signal.throwIfAborted();
          return events;
        },
        address,
        channelId,
      ),
  });
  if (query.isError)
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>Task conversations could not be fully loaded.</p>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Retry conversations
        </Button>
      </div>
    );
  if (query.isLoading)
    return (
      <p role="status" className="text-sm text-muted-foreground">
        Loading task conversations…
      </p>
    );
  return query.data?.length ? (
    <div className="space-y-2">
      {query.data.map((event) => (
        <Button
          key={event.id}
          variant="outline"
          className="h-auto w-full justify-start whitespace-normal p-3 text-left"
          onClick={() =>
            void goChannel(channelId, {
              thread: event.id,
            })
          }
        >
          <span>
            <span className="block text-sm">
              {splitProjectDetailAgentContext(event.content).message.slice(
                0,
                160,
              ) || "Open coding thread"}
            </span>
            <span className="block text-xs text-muted-foreground">
              {new Date(event.created_at * 1000).toLocaleString()}
            </span>
          </span>
        </Button>
      ))}
    </div>
  ) : (
    <p className="text-sm text-muted-foreground">
      No coding threads are linked yet.
    </p>
  );
}
