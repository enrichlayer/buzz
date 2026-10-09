import type { TranscriptItem } from "./agentSessionTypes";
import { buildCompactToolSummary } from "./agentSessionToolSummary";
import { FileEditDiffBlock } from "./FileEditDiffView";

/** Exact observed edits, not a claim about the current Git working tree. */
export function SessionChanges({
  items,
}: {
  items: readonly TranscriptItem[];
}) {
  const edits = items.flatMap((item) => {
    if (item.type !== "tool" || item.isError || item.status !== "completed")
      return [];
    const diff = buildCompactToolSummary(item).fileEditDiff;
    return diff ? [{ id: item.id, diff }] : [];
  });
  return (
    <details className="my-3" data-testid="session-changes">
      <summary className="cursor-pointer text-sm font-medium">
        Changes · {edits.length} observed{" "}
        {edits.length === 1 ? "edit" : "edits"}
      </summary>
      <p className="my-2 text-xs text-muted-foreground">
        Edits captured in this thread, in execution order. These are recorded
        changes, not the current working tree.
      </p>
      {edits.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No completed file edits captured yet.
        </p>
      ) : (
        edits.map(({ id, diff }) => (
          <details className="my-3" key={id}>
            <summary className="cursor-pointer break-all text-sm">
              {diff.path}{" "}
              <span className="text-muted-foreground">
                +{diff.additions} / −{diff.deletions}
              </span>
            </summary>
            <FileEditDiffBlock diff={diff} />
          </details>
        ))
      )}
    </details>
  );
}
