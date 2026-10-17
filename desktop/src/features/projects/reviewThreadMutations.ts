import { useMutation } from "@tanstack/react-query";
import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { getIdentity } from "@/shared/api/tauriIdentity";
import type { Repository } from "./projectModels";
import type { ProjectPullRequest } from "./projectPullRequests.mjs";
import { useProjectPullRequestWriteInvalidation } from "./pullRequestReviews";
import { reviewThreadEventInput } from "./reviewThreads";

/** Publish one signed discussion operation, invalidating only after relay acknowledgement. */
export function useReviewThreadMutation(project: Repository) {
  const invalidate = useProjectPullRequestWriteInvalidation(project);
  return useMutation({
    mutationFn: async ({
      pullRequest,
      threadId,
      content,
      action,
    }: {
      pullRequest: ProjectPullRequest;
      threadId: string;
      content?: string;
      action?: "resolve" | "reopen";
    }) => {
      if (project.repoAddress !== pullRequest.repoAddress)
        throw new Error("Review does not belong to this repository.");
      const identity = await getIdentity();
      const input = reviewThreadEventInput({
        pullRequest,
        threadId,
        content,
        action,
        owner: project.owner,
        viewer: identity.pubkey,
        now: Math.floor(Date.now() / 1000),
      });
      const event = await signRelayEvent(input);
      await relayClient.publishEvent(
        event,
        "Timed out saving discussion. Try again.",
        "Could not save discussion. Try again.",
      );
    },
    onSuccess: invalidate,
  });
}
