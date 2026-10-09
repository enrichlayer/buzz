import type { ObserverEvent } from "./agentSessionTypes";

/** Runtime observation, never a frontend harness-capability lookup table. */
export function SessionPermissionPolicy({
  events,
}: {
  events: readonly ObserverEvent[];
}) {
  const event = [...events]
    .reverse()
    .find((item) => item.kind === "permission_policy");
  if (!event?.payload || typeof event.payload !== "object") return null;
  const policy = event.payload as Record<string, unknown>;
  const effective =
    typeof policy.effective === "string" ? policy.effective : null;
  return (
    <p
      className="text-sm leading-6 text-muted-foreground"
      title={
        typeof policy.cwd === "string"
          ? `Agent working directory: ${policy.cwd}`
          : undefined
      }
    >
      <span className="font-medium">Tool permissions:</span>{" "}
      {effective === "bypassPermissions"
        ? "Prompts bypassed by this agent’s configuration"
        : effective === "default"
          ? "Adapter default — requests appear here when needed"
          : effective
            ? `Adapter mode: ${effective}`
            : "Adapter has not reported its effective policy"}
    </p>
  );
}
