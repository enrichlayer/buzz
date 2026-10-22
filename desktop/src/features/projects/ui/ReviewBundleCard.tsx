import { toast } from "sonner";

import {
  parseEntityLink,
  type ParsedEntityLink,
} from "@/shared/lib/entityLink";
import { Button } from "@/shared/ui/button";
import { PubKey } from "@/shared/ui/PubKey";
import { useRequestReviewBundleReviewMutation } from "../reviewBundleRequests";
import {
  canRequestBundleReview,
  type ReviewBundleMemberRow,
  type ReviewBundleState,
} from "../reviewBundleState";

function decisionLabel(decision: "approved" | "changes-requested" | null) {
  return decision === "approved"
    ? "Approved"
    : decision === "changes-requested"
      ? "Changes requested"
      : null;
}

function memberLink(state: ReviewBundleState, row: ReviewBundleMemberRow) {
  const match = /^30617:([a-f0-9]{64}):(.+)$/.exec(state.bundle.repository);
  if (!match) return null;
  const parsed = parseEntityLink(
    `buzz://pr?id=${row.pullRequest.id}&owner=${match[1]}&d=${encodeURIComponent(match[2])}`,
  );
  return parsed.ok ? parsed.value : null;
}

/**
 * One jj stack as the reviewer sees it: the members in stack order, each
 * with its own review entry point, and the bundle verdict on top. The card
 * never shows a diff of its own; a member's "Review changes" opens the
 * existing review workspace, and a mirrored member links its merge request.
 */
export function ReviewBundleCard({
  state,
  viewerPubkey,
  onOpenReview,
  onOpenUrl,
}: {
  state: ReviewBundleState;
  viewerPubkey: string | null | undefined;
  onOpenReview: (link: ParsedEntityLink) => void;
  onOpenUrl: (url: string) => void;
}) {
  const request = useRequestReviewBundleReviewMutation();
  const members = state.members.map((row) => row.pullRequest);
  const mayRequest = canRequestBundleReview(state.owner, members, viewerPubkey);
  const decision = decisionLabel(state.decision);
  const { umbrellaIssue } = state;
  return (
    <article
      aria-label={`Review stack: ${state.bundle.subject}`}
      data-testid="review-bundle-card"
      className="mt-2 rounded-md border border-border/70 p-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <p className="break-words text-sm font-medium">
            {state.bundle.subject}
          </p>
          <p className="text-xs text-muted-foreground">
            Stack of {state.members.length} ·{" "}
            {decision ? (
              <span data-testid="review-bundle-decision">{decision}</span>
            ) : state.stale ? (
              <span data-testid="review-bundle-decision">
                Verdict outdated by a newer push
              </span>
            ) : (
              <span data-testid="review-bundle-decision">Awaiting verdict</span>
            )}
            {umbrellaIssue ? (
              <>
                {" "}
                ·{" "}
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => onOpenUrl(umbrellaIssue.url)}
                >
                  {umbrellaIssue.id}
                </Button>
              </>
            ) : null}
          </p>
          <p className="text-xs text-muted-foreground">
            Stack signed by <PubKey pubkey={state.bundle.author} />
          </p>
        </div>
        {mayRequest ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={request.isPending}
            onClick={() =>
              request.mutate(
                { state },
                {
                  onSuccess: ({ requested }) =>
                    toast.success(
                      `Review requested on ${requested.length} stack members.`,
                    ),
                  onError: (error) =>
                    toast.error(
                      error instanceof Error
                        ? error.message
                        : "Failed to request the stack review.",
                    ),
                },
              )
            }
          >
            Request stack review
          </Button>
        ) : null}
      </div>
      <ol className="mt-1 space-y-1">
        {state.members.map((row) => {
          const link = memberLink(state, row);
          const memberDecision = decisionLabel(row.decision);
          const { linearIssue, mirrorOf } = row;
          return (
            <li
              key={row.pullRequest.id}
              data-testid="review-bundle-member"
              className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-1"
            >
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">
                  <span className="text-muted-foreground">{row.position}.</span>{" "}
                  {row.pullRequest.title}
                </p>
                <p className="break-all text-xs text-muted-foreground">
                  {row.bookmark ??
                    row.pullRequest.branchName ??
                    "Review branch"}
                  {row.pullRequest.commit ? (
                    <span title={row.pullRequest.commit}>
                      {" "}
                      · {row.pullRequest.commit.slice(0, 12)}
                    </span>
                  ) : null}
                  {" · "}
                  {row.pullRequest.status}
                  {memberDecision ? ` · ${memberDecision}` : ""}
                  {row.openFindings
                    ? ` · ${row.openFindings} open finding${row.openFindings === 1 ? "" : "s"}`
                    : ""}
                </p>
                <p className="flex flex-wrap gap-2 text-xs">
                  {linearIssue ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => onOpenUrl(linearIssue.url)}
                    >
                      {linearIssue.id}
                    </Button>
                  ) : null}
                  {mirrorOf ? (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto p-0 text-xs"
                      onClick={() => onOpenUrl(mirrorOf)}
                    >
                      Merge request
                    </Button>
                  ) : null}
                </p>
              </div>
              {link ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`Review changes: ${row.pullRequest.title}`}
                  onClick={() => onOpenReview(link)}
                >
                  Review changes
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
    </article>
  );
}
