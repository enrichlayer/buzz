import * as React from "react";
import { MessageSquarePlus } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import type { ProjectRepoDiffFile } from "@/shared/api/types";
import type { UserProfileLookup } from "@/features/profile/lib/identity";
import type {
  ProjectPullRequestComment,
  ProjectPullRequestCommentAnchor,
} from "../projectPullRequests.mjs";
import { diffRows, splitDiffRows, type DiffRow } from "../lib/projectDiffRows";
import { ProjectPullRequestInlineCommentThread } from "./ProjectPullRequestInlineComments";
import type { DiscussionControls } from "./ReviewDiscussion";

export type InlineCommentControls = {
  activeAnchor: ProjectPullRequestCommentAnchor | null;
  canRequestChanges: boolean;
  comments: ProjectPullRequestComment[];
  discussions: DiscussionControls;
  isSending: boolean;
  onCancel: () => void;
  onStart: (anchor: ProjectPullRequestCommentAnchor) => void;
  onSubmit: (
    anchor: ProjectPullRequestCommentAnchor,
    content: string,
    mentionPubkeys: string[],
    mediaTags?: string[][],
    decision?: "request-changes",
  ) => Promise<unknown>;
  profiles?: UserProfileLookup;
};

function anchorsEqual(
  left: ProjectPullRequestCommentAnchor | null | undefined,
  right: ProjectPullRequestCommentAnchor | null,
) {
  return Boolean(
    left &&
      right &&
      left.path === right.path &&
      left.side === right.side &&
      left.line === right.line,
  );
}

function SearchText({ content, query }: { content: string; query: string }) {
  if (!query) return <>{content || " "}</>;
  const parts: React.ReactNode[] = [];
  let offset = 0;
  const normalized = content.toLowerCase();
  const needle = query.toLowerCase();
  let match = normalized.indexOf(needle);
  while (match >= 0) {
    parts.push(
      content.slice(offset, match),
      <mark className="bg-primary/25 text-foreground" key={match}>
        {content.slice(match, match + query.length)}
      </mark>,
    );
    offset = match + query.length;
    match = normalized.indexOf(needle, offset);
  }
  parts.push(content.slice(offset));
  return <>{parts}</>;
}

/** Shared review renderer: both layouts use the same parsed lines and comment anchors. */
export function DiffPreview({
  file,
  focusedAnchor,
  inlineComments,
  layout = "unified",
  searchQuery = "",
  searchRowKey,
}: {
  file: ProjectRepoDiffFile;
  focusedAnchor?: ProjectPullRequestCommentAnchor | null;
  inlineComments?: InlineCommentControls;
  layout?: "unified" | "split";
  searchQuery?: string;
  searchRowKey?: string;
}) {
  const rows = React.useMemo(() => diffRows(file), [file]);
  const pairs = React.useMemo(() => splitDiffRows(rows), [rows]);
  const threadsByAnchor = React.useMemo(() => {
    const index = new Map<string, import("../reviewThreads").ReviewThread[]>();
    for (const thread of inlineComments?.discussions.threads ?? []) {
      if (thread.root.inlineCommentStatus !== "current" || !thread.root.anchor)
        continue;
      const anchor = thread.root.anchor;
      const key = JSON.stringify([anchor.path, anchor.side, anchor.line]);
      const bucket = index.get(key) ?? [];
      bucket.push(thread);
      index.set(key, bucket);
    }
    return index;
  }, [inlineComments?.discussions.threads]);
  const focusedRowRef = React.useRef<HTMLDivElement | null>(null);
  const searchRef = React.useRef<HTMLDivElement | null>(null);
  const [highlightedAnchor, setHighlightedAnchor] =
    React.useState(focusedAnchor);
  React.useEffect(() => {
    setHighlightedAnchor(focusedAnchor);
    const clear = () => setHighlightedAnchor(null);
    const key = (event: KeyboardEvent) => {
      if (!["Alt", "Control", "Meta", "Shift"].includes(event.key)) clear();
    };
    const frame = requestAnimationFrame(() => {
      if (focusedAnchor?.path === file.path) {
        focusedRowRef.current?.scrollIntoView({ block: "center" });
        focusedRowRef.current?.focus({ preventScroll: true });
      }
      window.addEventListener("pointerdown", clear, true);
      window.addEventListener("keydown", key, true);
    });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("pointerdown", clear, true);
      window.removeEventListener("keydown", key, true);
    };
  }, [file.path, focusedAnchor]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll the newly rendered match after navigation or a layout change.
  React.useEffect(() => {
    searchRef.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [searchRowKey, layout]);
  const renderLine = (row: DiffRow | null, side?: "old" | "new") => {
    if (!row) return <div className="min-h-5 bg-muted/20" />;
    const anchorSide = side ?? (row.type === "delete" ? "old" : "new");
    const number = anchorSide === "old" ? row.oldLine : row.newLine;
    const anchor = number
      ? { path: file.path, side: anchorSide, line: number }
      : null;
    const oldContextAnchor =
      !side && row.type === "context" && row.oldLine
        ? { path: file.path, side: "old" as const, line: row.oldLine }
        : null;
    const threads = [anchor, oldContextAnchor].flatMap((location) =>
      location
        ? (threadsByAnchor.get(
            JSON.stringify([location.path, location.side, location.line]),
          ) ?? [])
        : [],
    );
    const comments = threads.flatMap((thread) => [
      thread.root,
      ...thread.replies,
    ]);
    const active =
      anchorsEqual(inlineComments?.activeAnchor, anchor) ||
      anchorsEqual(inlineComments?.activeAnchor, oldContextAnchor);
    const focused =
      anchorsEqual(highlightedAnchor, anchor) ||
      anchorsEqual(highlightedAnchor, oldContextAnchor);
    const displayAnchor =
      focused && highlightedAnchor ? highlightedAnchor : anchor;
    const composerAnchor =
      active && inlineComments?.activeAnchor
        ? inlineComments.activeAnchor
        : anchor;
    const searchMatch =
      row.key === searchRowKey &&
      (!side || side === (row.type === "delete" ? "old" : "new"));
    return (
      <div className="min-w-0">
        <div
          className={cn(
            "group grid min-h-5",
            side
              ? "grid-cols-[3rem_2rem_1rem_minmax(0,1fr)]"
              : "grid-cols-[3rem_3rem_2rem_1rem_minmax(0,1fr)]",
            row.type === "add" && "bg-status-added/10",
            row.type === "delete" && "bg-status-deleted/10",
            (row.type === "hunk" || row.type === "meta") &&
              "bg-muted/40 text-muted-foreground",
            (focused || searchMatch) &&
              "bg-primary/10 ring-1 ring-primary/40 ring-inset",
          )}
          data-testid={
            focused
              ? "project-diff-focused-line"
              : anchor
                ? "project-diff-line"
                : undefined
          }
          data-search-active={searchMatch || undefined}
          data-line={displayAnchor?.line}
          data-path={displayAnchor?.path}
          data-side={displayAnchor?.side}
          ref={(element) => {
            if (focused) focusedRowRef.current = element;
            if (searchMatch) searchRef.current = element;
          }}
          tabIndex={focused ? -1 : undefined}
        >
          {!side || side === "old" ? (
            <span className="select-none border-r border-border/40 px-2 text-right text-muted-foreground">
              {row.oldLine ?? " "}
            </span>
          ) : null}
          {!side || side === "new" ? (
            <span className="select-none border-r border-border/40 px-2 text-right text-muted-foreground">
              {row.newLine ?? " "}
            </span>
          ) : null}
          <span className="flex items-center justify-center">
            {anchor && inlineComments ? (
              <button
                type="button"
                aria-label={`Comment on ${anchor.path} ${anchor.side} line ${anchor.line}`}
                data-testid="project-diff-add-comment"
                disabled={inlineComments.isSending}
                onClick={() => inlineComments.onStart(anchor)}
                className={cn(
                  "flex h-5 w-5 items-center justify-center rounded text-muted-foreground opacity-0 transition-colors hover:bg-primary hover:text-primary-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring group-hover:opacity-100 disabled:opacity-50",
                  (threads.length > 0 || active) && "opacity-100",
                )}
              >
                <MessageSquarePlus className="h-3.5 w-3.5" />
              </button>
            ) : null}
          </span>
          <span aria-hidden="true" className="select-none">
            {row.type === "add" ? "+" : row.type === "delete" ? "-" : " "}
          </span>
          <code
            className={cn(
              "min-w-0 pr-3 text-foreground",
              side ? "whitespace-pre-wrap break-all" : "whitespace-pre",
            )}
          >
            <SearchText
              content={row.content}
              query={
                row.type === "hunk" || row.type === "meta" ? "" : searchQuery
              }
            />
          </code>
        </div>
        {anchor && inlineComments && (threads.length > 0 || active) ? (
          <ProjectPullRequestInlineCommentThread
            activeAnchor={active ? composerAnchor : null}
            comments={comments}
            discussions={{ ...inlineComments.discussions, threads }}
            canRequestChanges={inlineComments.canRequestChanges}
            isSending={inlineComments.isSending}
            onCancel={inlineComments.onCancel}
            onSubmit={(content, mentions, media, decision) =>
              inlineComments.onSubmit(
                composerAnchor ?? anchor,
                content,
                mentions,
                media,
                decision,
              )
            }
            profiles={inlineComments.profiles}
          />
        ) : null}
      </div>
    );
  };
  return (
    <div
      className="overflow-x-auto bg-background/70 font-mono text-xs leading-5"
      data-diff-layout={layout}
    >
      {file.truncated ? (
        <p className="border-b border-border/40 p-3 font-sans text-muted-foreground">
          Diff truncated. Search covers loaded lines only; use a local checkout
          for the full change.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="p-4 font-sans text-muted-foreground">
          No textual diff is available for this file.
        </p>
      ) : null}
      {layout === "split" ? (
        <div className="min-w-[32rem]">
          <div className="grid grid-cols-2 border-b border-border/50 bg-muted/30 font-sans text-muted-foreground">
            <span className="px-3 py-1">Before</span>
            <span className="border-l border-border/50 px-3 py-1">After</span>
          </div>
          {pairs.map((pair) =>
            pair.old?.type === "hunk" || pair.old?.type === "meta" ? (
              <div key={pair.old.key}>{renderLine(pair.old)}</div>
            ) : (
              <div
                key={pair.old?.key ?? pair.next?.key}
                className="grid grid-cols-2"
              >
                <div className="min-w-0 overflow-x-auto border-r border-border/50">
                  {renderLine(pair.old, "old")}
                </div>
                <div className="min-w-0 overflow-x-auto">
                  {renderLine(pair.next, "new")}
                </div>
              </div>
            ),
          )}
        </div>
      ) : (
        rows.map((row) => (
          <React.Fragment key={row.key}>{renderLine(row)}</React.Fragment>
        ))
      )}
    </div>
  );
}
