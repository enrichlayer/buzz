import * as React from "react";
import type { MessageKindCardProps } from "@/shared/plugins/messageKinds/cards";

const DiffMessage = React.lazy(() => import("./DiffMessage"));
const DiffMessageExpanded = React.lazy(() => import("./DiffMessageExpanded"));

/** Card for the `diff` message-kind plugin (kind 40008). */
export function DiffMessageCard({
  message,
  searchQuery,
}: MessageKindCardProps) {
  const [expanded, setExpanded] = React.useState(false);
  const getTag = (name: string) =>
    message.tags?.find((tag) => tag[0] === name)?.[1];

  return (
    <>
      <React.Suspense
        fallback={
          <div className="p-3 text-sm text-muted-foreground">Loading diff…</div>
        }
      >
        <DiffMessage
          commitSha={getTag("commit")}
          content={message.body}
          description={getTag("description")}
          filePath={getTag("file")}
          onExpand={() => {
            setExpanded(true);
          }}
          repoUrl={getTag("repo")}
          searchQuery={searchQuery}
          truncated={getTag("truncated") === "true"}
        />
      </React.Suspense>
      {expanded ? (
        <React.Suspense
          fallback={
            <div className="p-3 text-sm text-muted-foreground">
              Loading diff viewer…
            </div>
          }
        >
          <DiffMessageExpanded
            content={message.body}
            filePath={getTag("file")}
            onClose={() => {
              setExpanded(false);
            }}
          />
        </React.Suspense>
      ) : null}
    </>
  );
}
