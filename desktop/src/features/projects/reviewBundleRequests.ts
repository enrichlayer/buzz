import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";

import { relayClient } from "@/shared/api/relayClient";
import { signRelayEvent } from "@/shared/api/tauri";
import { KIND_TEXT_NOTE } from "@/shared/constants/kinds";
import { normalizePubkey } from "@/shared/lib/pubkey";
import { PR_REVIEW_REQUEST_LABEL } from "./projectPullRequests.mjs";
import type { ReviewBundleState } from "./reviewBundleState";

// A bundle review request is one `review-request` note per member, the same
// shape `requestProjectPullRequestReview` signs for a single pull request, so
// `projectPullRequests` already trusts it when the PR author or repo owner
// signs. The bundle root itself is not re-signed: its `p` tags name who the
// author asked for; this fan-out is how that ask reaches each member.

export type ReviewBundleReviewRequest = {
  pullRequest: string;
  title: string;
  reviewers: string[];
  content: string;
  tags: string[][];
};

/**
 * The notes a bundle review request publishes, one per member. `reviewers`
 * defaults to the bundle root's recipients; each member's own author is left
 * out, since nobody reviews their own change. A member left with no reviewer
 * rejects the whole request rather than publishing a partial stack.
 */
export function reviewBundleReviewRequests(
  state: ReviewBundleState,
  reviewers: readonly string[] = state.bundle.recipients,
): ReviewBundleReviewRequest[] {
  const wanted = [...new Set(reviewers.map(normalizePubkey))];
  if (!wanted.length) throw new Error("Select at least one reviewer.");
  return state.members.map(({ pullRequest }) => {
    const author = normalizePubkey(pullRequest.author);
    const memberReviewers = wanted.filter((pubkey) => pubkey !== author);
    if (!memberReviewers.length)
      throw new Error(
        `No reviewer for “${pullRequest.title}”: its author cannot review it.`,
      );
    return {
      pullRequest: pullRequest.id,
      title: pullRequest.title,
      reviewers: memberReviewers,
      content: `Requested a review of the stack “${state.bundle.subject}”`,
      tags: [
        ["e", pullRequest.id, "", "root"],
        ["a", state.bundle.repository],
        ...memberReviewers.map((pubkey) => ["p", pubkey]),
        ["t", PR_REVIEW_REQUEST_LABEL],
      ],
    };
  });
}

/**
 * Publish the request on every member in stack order. Members already
 * requested stay requested when a later one fails; the error names the
 * members still missing so the user can retry just those by re-requesting.
 */
export async function requestReviewBundleReview(
  state: ReviewBundleState,
  reviewers?: readonly string[],
  publish: (
    request: ReviewBundleReviewRequest,
  ) => Promise<void> = publishRequest,
): Promise<{ requested: string[] }> {
  const requests = reviewBundleReviewRequests(state, reviewers);
  const requested: string[] = [];
  const failed: string[] = [];
  for (const request of requests) {
    try {
      await publish(request);
      requested.push(request.pullRequest);
    } catch (error) {
      failed.push(
        `${request.title} (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
  if (failed.length)
    throw new Error(
      `Requested a review on ${requested.length} of ${requests.length} members; not requested: ${failed.join("; ")}`,
    );
  return { requested };
}

async function publishRequest(request: ReviewBundleReviewRequest) {
  const event = await signRelayEvent({
    kind: KIND_TEXT_NOTE,
    content: request.content,
    tags: request.tags,
  });
  await relayClient.publishEvent(
    event,
    "Timed out requesting review.",
    "Failed to request review.",
  );
}

/** Request a bundle review from the thread card; the viewer signs as themself. */
export function useRequestReviewBundleReviewMutation() {
  const queryClient = useQueryClient();
  const invalidate = React.useCallback(() => {
    // The thread card and every project surface read the member PRs; prefix
    // keys cover them without knowing the project route id here.
    for (const queryKey of [["thread-reviews"], ["project"], ["projects"]])
      void queryClient.invalidateQueries({ queryKey });
  }, [queryClient]);
  return useMutation({
    mutationFn: ({
      state,
      reviewers,
    }: {
      state: ReviewBundleState;
      reviewers?: readonly string[];
    }) => requestReviewBundleReview(state, reviewers),
    onSettled: invalidate,
  });
}
