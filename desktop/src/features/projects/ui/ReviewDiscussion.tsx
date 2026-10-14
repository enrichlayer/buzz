import * as React from "react";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { normalizePubkey, truncateNpub } from "@/shared/lib/pubkey";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type { ReviewThread } from "../reviewThreads";
import { relativeTime } from "../lib/projectsViewHelpers";
import { ProjectRichContent } from "./ProjectRichContent";

export type DiscussionControls = {
  threads: ReviewThread[];
  canResolve: (thread: ReviewThread) => boolean;
  onReply: (threadId: string, content: string) => Promise<unknown>;
  onResolve: (
    threadId: string,
    action: "resolve" | "reopen",
  ) => Promise<unknown>;
  canReply: boolean;
};

/** One durable discussion; drafts survive failed sends and resolution never implies approval. */
export function ReviewDiscussion({
  thread,
  controls,
  profiles,
}: {
  thread: ReviewThread;
  controls: DiscussionControls;
  profiles?: UserProfileLookup;
}) {
  const [replying, setReplying] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const run = async (action: () => Promise<unknown>, clearDraft = false) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await action();
      if (clearDraft) {
        setDraft("");
        setReplying(false);
      }
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not save discussion. Try again.",
      );
    } finally {
      setPending(false);
      inFlight.current = false;
    }
  };
  return (
    <section
      aria-label="Review discussion"
      className="min-w-0 space-y-2 border border-border/60 bg-background p-3 font-sans text-sm"
      data-thread-id={thread.root.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span role="status">{thread.resolved ? "Resolved" : "Unresolved"}</span>
        {thread.root.inlineCommentStatus === "outdated" ? (
          <span>Earlier revision · {thread.root.commit?.slice(0, 7)}</span>
        ) : null}
        <div className="ml-auto flex gap-1">
          {controls.canReply ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
          ) : null}
          {controls.canResolve(thread) ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() =>
                void run(() =>
                  controls.onResolve(
                    thread.root.id,
                    thread.resolved ? "reopen" : "resolve",
                  ),
                )
              }
            >
              {thread.resolved ? "Reopen" : "Resolve"}
            </Button>
          ) : null}
        </div>
      </div>
      {thread.root.anchor ? (
        <p className="break-all font-mono text-xs text-muted-foreground">
          {thread.root.anchor.path} ·{" "}
          {thread.root.anchor.side === "old" ? "Before" : "After"} line{" "}
          {thread.root.anchor.line}
        </p>
      ) : null}
      {[thread.root, ...thread.replies].map((comment, index) => {
        const profile = profiles?.[normalizePubkey(comment.author)];
        return (
          <article
            key={comment.id}
            data-testid="project-inline-comment"
            className={
              index ? "space-y-1 border-t border-border/50 pt-2" : "space-y-1"
            }
          >
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="truncate font-medium text-foreground">
                {profile?.displayName?.trim() ||
                  profile?.nip05Handle?.trim() ||
                  truncateNpub(comment.author)}
              </span>
              <span>{relativeTime(comment.createdAt)}</span>
            </div>
            <ProjectRichContent content={comment.content} tags={comment.tags} />
          </article>
        );
      })}
      {replying ? (
        <form
          className="space-y-2"
          onSubmit={(event) => {
            event.preventDefault();
            void run(() => controls.onReply(thread.root.id, draft), true);
          }}
        >
          <Textarea
            aria-label="Reply to discussion"
            autoFocus
            value={draft}
            disabled={pending}
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (event.metaKey || event.ctrlKey) &&
                !event.shiftKey &&
                !event.altKey &&
                !event.nativeEvent.isComposing
              ) {
                event.preventDefault();
                if (draft.trim())
                  void run(() => controls.onReply(thread.root.id, draft), true);
              }
            }}
          />
          <div className="flex gap-2">
            <Button size="sm" type="submit" disabled={pending || !draft.trim()}>
              {pending ? "Saving…" : "Send reply"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              disabled={pending}
              onClick={() => setReplying(false)}
            >
              Cancel
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}
