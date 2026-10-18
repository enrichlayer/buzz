import { linearWorkLinkFromAddress } from "../../shared/lib/linearWorkLink.ts";
import type { RelayEvent } from "@/shared/api/types";

/** A signed author's association, not proof of Linear ownership or status. */
export type SessionReviewContext = {
  taskAddress?: string | null;
  threadRootId: string;
  linearIssueUrl: string | null;
  linearIssueId: string | null;
};

/** Only canonical HTTPS Linear issue links may become session navigation. */
export function parseSessionLinearIssue(value: string) {
  try {
    const url = new URL(value);
    const match =
      /^\/[^/]+\/issue\/([A-Za-z][A-Za-z0-9]*-\d+)(?:\/[^/]*)?\/?$/.exec(
        url.pathname,
      );
    if (
      url.protocol !== "https:" ||
      url.hostname !== "linear.app" ||
      url.port ||
      url.username ||
      url.password ||
      !match
    )
      return null;
    url.search = "";
    url.hash = "";
    return { url: url.href, id: match[1].toUpperCase() };
  } catch {
    return null;
  }
}

/** Ignore ambiguous or malformed associations instead of guessing a thread. */
export function sessionReviewContext(
  event: Pick<RelayEvent, "tags">,
): SessionReviewContext | null {
  const roots = event.tags.filter(
    (tag) => tag[0] === "e" && tag[3] === "buzz-session",
  );
  if (roots.length !== 1 || !/^[a-f0-9]{64}$/.test(roots[0][1] ?? ""))
    return null;
  const issues = event.tags.filter(
    (tag) => tag[0] === "r" && tag[2] === "linear-issue",
  );
  if (issues.length > 1) return null;
  const issue = issues.length
    ? parseSessionLinearIssue(issues[0][1] ?? "")
    : null;
  if (issues.length && !issue) return null;
  const tasks = event.tags.filter(
    (tag) => tag[0] === "a" && tag[3] === "buzz-task",
  );
  if (
    tasks.length > 1 ||
    (tasks.length === 1 &&
      (tasks[0].length !== 4 ||
        !tasks[0][1]?.startsWith("30624:") ||
        !linearWorkLinkFromAddress(tasks[0][1])))
  )
    return null;
  return {
    ...(tasks.length ? { taskAddress: tasks[0][1] } : {}),
    threadRootId: roots[0][1],
    linearIssueUrl: issue?.url ?? null,
    linearIssueId: issue?.id ?? null,
  };
}
