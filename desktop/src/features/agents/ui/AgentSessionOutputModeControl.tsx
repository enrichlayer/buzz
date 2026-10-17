import type { AgentOutputMode } from "@/shared/api/types";
import { Button } from "@/shared/ui/button";
import { resolveAgentOutputMode } from "./agentSessionOutputMode";

export function AgentSessionOutputModeControl({
  hiddenCount,
  outputMode,
  showDetails,
  onShowDetailsChange,
}: {
  hiddenCount: number;
  outputMode: AgentOutputMode | undefined;
  showDetails: boolean;
  onShowDetailsChange: (show: boolean) => void;
}) {
  if (
    resolveAgentOutputMode(outputMode) !== "summary" ||
    (!showDetails && hiddenCount === 0)
  ) {
    return null;
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      {!showDetails && hiddenCount > 0 ? (
        <span className="truncate text-xs text-muted-foreground">
          {hiddenCount} routine {hiddenCount === 1 ? "update" : "updates"}{" "}
          hidden
        </span>
      ) : null}
      <Button
        onClick={() => onShowDetailsChange(!showDetails)}
        size="sm"
        type="button"
        variant="ghost"
      >
        {showDetails ? "Show summary" : "Show details"}
      </Button>
    </div>
  );
}
