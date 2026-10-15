import type { TimelineMessage } from "@/features/messages/types";
import type { ObserverEvent, TranscriptItem } from "./agentSessionTypes";

export type SessionView = "conversation" | "activity" | "full";

/** Reader preference; never writes the agent's publishing configuration. */
export function visibleSessionItems(
  items: readonly TranscriptItem[],
  view: SessionView,
) {
  if (view === "full") return [...items];
  return items.filter((item) => {
    if (item.type === "metadata" || item.renderClass === "suppressed")
      return false;
    if (
      item.type === "lifecycle" &&
      ["Mode", "Commands", "Usage", "Session ready", "Turn started"].includes(
        item.title,
      )
    )
      return false;
    if (view === "activity") return item.type !== "thought";
    return (
      item.type === "message" ||
      item.renderClass === "permission" ||
      item.renderClass === "error" ||
      (item.type === "tool" && (item.isError || item.status === "failed"))
    );
  });
}

/** Attach events to the preceding published message, with prompts winning ties. */
export function sessionActivityAnchor(
  item: TranscriptItem,
  messages: readonly TimelineMessage[],
): string | null {
  const time = Date.parse(item.timestamp);
  const ordered = [...messages].sort((a, b) => a.createdAt - b.createdAt);
  let anchor = ordered[0]?.id ?? null;
  for (const message of ordered) {
    const published = message.createdAt * 1000;
    const isAgent = message.isAgent === true || message.role === "bot";
    // Published events have second precision. On ties, show human prompts
    // first and tool evidence before an agent's published response.
    if (
      published < Math.floor(time / 1000) * 1000 ||
      (published <= time && !isAgent)
    )
      anchor = message.id;
  }
  return anchor;
}

/** Terminal state comes from harness evidence, never from the absence of liveness. */
export function sessionOutcome(
  events: readonly ObserverEvent[],
  turnIds: ReadonlySet<string>,
  live: boolean,
  disconnected: boolean,
): string {
  const scoped = events.filter(
    (event) => event.turnId && turnIds.has(event.turnId),
  );
  const latest = scoped.at(-1);
  const latestTurn = latest?.turnId;
  const turn = scoped.filter((event) => event.turnId === latestTurn);
  const error = turn
    .filter(
      (event) => event.kind === "turn_error" || event.kind === "agent_panic",
    )
    .at(-1);
  const completed = turn.some((event) => event.kind === "turn_completed");
  const result = turn
    .map(
      (event) =>
        (event.payload as { result?: { stopReason?: string } } | null)?.result
          ?.stopReason,
    )
    .filter(Boolean)
    .at(-1);
  const errorOutcome = String(
    (error?.payload as { outcome?: string } | null)?.outcome ?? "",
  );
  const command = [...turn]
    .reverse()
    .find((event) => event.kind === "human_command_completed")?.payload as
    | { status?: string }
    | undefined;
  if (command && !live) return `Command ${command.status ?? "outcome unknown"}`;
  if (/cancel|interrupt/i.test(`${result ?? ""} ${errorOutcome}`))
    return "Turn cancelled";
  if (error) return "Turn failed";
  if (live)
    return disconnected ? "Connection lost · outcome unknown" : "Working";
  if (result === "end_turn") return "Turn completed";
  if (result === "max_tokens") return "Stopped at token limit";
  if (result === "refusal") return "Request declined";
  if (completed) return "Turn ended · outcome unknown";
  return disconnected ? "Connection lost · outcome unknown" : "Outcome unknown";
}
