import { useSyncExternalStore } from "react";

// Source event IDs are unique across channels and relays. Scope dismissal to
// the viewer too; retain bounded receipts for navigation during this app session.
const dismissed = new Set<string>();
const listeners = new Set<() => void>();
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function usePromptSuggestionDismissal(
  owner: string | null,
  source: string | undefined,
) {
  const key = `${owner ?? ""}:${source ?? ""}`;
  const hidden = useSyncExternalStore(
    subscribe,
    () => dismissed.has(key),
    () => false,
  );
  return {
    hidden,
    dismiss: () => {
      if (!owner || !source) return;
      dismissed.add(key);
      // Bound memory without retaining message text or prompts.
      if (dismissed.size > 512) {
        const oldest = dismissed.values().next().value;
        if (oldest) dismissed.delete(oldest);
      }
      for (const listener of listeners) listener();
    },
  };
}
