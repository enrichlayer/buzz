import type * as React from "react";

import { cn } from "@/shared/lib/cn";

/** Shared surface for every state of the question card. */
export function AgentPromptCardFrame({
  className,
  state,
  ...props
}: React.ComponentProps<"section"> & {
  state: "open" | "answered" | "fallback";
}) {
  return (
    <section
      className={cn(
        "w-full max-w-2xl rounded-2xl border border-border/70 bg-muted/30 p-3 text-left",
        className,
      )}
      data-state={state}
      data-testid="agent-prompt-card"
      {...props}
    />
  );
}
