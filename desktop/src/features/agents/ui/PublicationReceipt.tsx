import { ChevronRight } from "lucide-react";
import type { TranscriptItem } from "./agentSessionTypes";
import { getToolDurationDisplay } from "./agentSessionUtils";
import { ToolDetailBlocks } from "./AgentSessionToolItem/ToolDetailBlocks";

/** Used only after a successful result resolves to a message in this thread. */
export function PublicationReceipt({
  item,
}: {
  item: Extract<TranscriptItem, { type: "tool" }>;
}) {
  const duration = getToolDurationDisplay(item);
  return (
    <details className="group text-xs" data-testid="publication-receipt">
      <summary className="flex min-h-7 cursor-pointer list-none items-center gap-1.5 text-muted-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <ChevronRight
          aria-hidden
          className="size-3.5 shrink-0 group-open:rotate-90"
        />
        <span>Posted reply to this thread</span>
        {duration ? <span className="tabular-nums">· {duration}</span> : null}
      </summary>
      <ToolDetailBlocks
        args={item.args}
        hasArgs={Object.keys(item.args).length > 0}
        hasResult={Boolean(item.result)}
        result={item.result}
        isError={false}
        fileEditDiff={null}
        fileReadContent={null}
        imagePreview={null}
        shellCommand={null}
      />
    </details>
  );
}
