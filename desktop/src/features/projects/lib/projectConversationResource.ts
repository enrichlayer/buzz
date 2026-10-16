import type { ProjectDetailAgentContext } from "./projectDetailAgentContext";

/**
 * A task or review owns its conversation independently of the repository page.
 * Event IDs are relay-global; commit hashes still need repository scope.
 * The caller additionally scopes this key by community and signing identity.
 */
export function projectConversationResource(
  context: ProjectDetailAgentContext,
): string {
  const items = context.selection?.length
    ? context.selection
    : context.workItem
      ? [context.workItem]
      : [];
  if (items.length === 1) {
    const item = items[0];
    if (item.id && (item.kind === "task" || item.kind === "review")) {
      return JSON.stringify(["work-item-v1", item.kind, item.id]);
    }
  }
  if (items.length) {
    return JSON.stringify([
      "work-selection-v1",
      context.repoAddress,
      [
        ...new Set(items.map((item) => JSON.stringify([item.kind, item.id]))),
      ].sort(),
    ]);
  }
  return context.repoAddress;
}
