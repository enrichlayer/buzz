import type { AgentOutputMode } from "@/shared/api/types";
import type { TranscriptItem } from "./agentSessionTypes";

export type AgentSessionPresentation = {
  items: TranscriptItem[];
  hiddenCount: number;
};

export function resolveAgentOutputMode(
  outputMode: AgentOutputMode | undefined,
): AgentOutputMode {
  return outputMode ?? "full";
}

function keepInSummary(item: TranscriptItem): boolean {
  if (item.renderClass === "permission" || item.renderClass === "error") {
    return true;
  }
  if (item.type === "message") return true;
  if (item.type === "tool") {
    return item.isError || item.status === "failed";
  }
  return false;
}

/**
 * Summary mode is a presentation filter over immutable observer evidence. It
 * keeps authored messages and anything requiring attention, while routine
 * progress and successful tool detail remain available behind Show details.
 */
export function presentAgentSessionTranscript(
  items: readonly TranscriptItem[],
  outputMode: AgentOutputMode | undefined,
  showDetails: boolean,
): AgentSessionPresentation {
  if (resolveAgentOutputMode(outputMode) === "full" || showDetails) {
    return { items: [...items], hiddenCount: 0 };
  }
  const visible = items.filter(keepInSummary);
  return { items: visible, hiddenCount: items.length - visible.length };
}
