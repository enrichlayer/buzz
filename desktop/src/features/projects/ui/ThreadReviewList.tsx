import type { ProjectPullRequest } from "../projectPullRequests.mjs";
import {
  parseEntityLink,
  type ParsedEntityLink,
} from "@/shared/lib/entityLink";
import { Button } from "@/shared/ui/button";
import { parseSessionLinearIssue } from "../sessionReviewContext";

/** Compact session entry points into the existing full review workspace. */
export function ThreadReviewList({
  reviews,
  onOpenReview,
  onOpenIssue,
}: {
  reviews: readonly ProjectPullRequest[];
  onOpenReview: (link: ParsedEntityLink) => void;
  onOpenIssue: (url: string) => void;
}) {
  return (
    <>
      {reviews.map((review) => {
        const match = /^30617:([a-f0-9]{64}):(.+)$/.exec(
          review.repoAddress ?? "",
        );
        if (!match) return null;
        const parsed = parseEntityLink(
          `buzz://pr?id=${review.id}&owner=${match[1]}&d=${encodeURIComponent(match[2])}`,
        );
        if (!parsed.ok) return null;
        const issue = review.sessionContext?.linearIssueUrl
          ? parseSessionLinearIssue(review.sessionContext.linearIssueUrl)
          : null;
        return (
          <div
            key={review.id}
            className="mt-2 flex flex-wrap items-center gap-2"
          >
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm">{review.title}</p>
              <p className="break-all text-xs text-muted-foreground">
                {match[2]} · {review.branchName ?? "Review branch"} ·{" "}
                {review.status}
                {review.commit ? (
                  <span title={review.commit}>
                    {" "}
                    · {review.commit.slice(0, 12)}
                  </span>
                ) : null}
              </p>
              <p className="break-all text-xs text-muted-foreground">
                Association claimed by reviewer: <span>{review.author}</span>
              </p>
              {issue ? (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={() => onOpenIssue(issue.url)}
                >
                  {issue.id}
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label={`Review changes: ${review.title}`}
              onClick={() => onOpenReview(parsed.value)}
            >
              Review changes
            </Button>
          </div>
        );
      })}
    </>
  );
}
