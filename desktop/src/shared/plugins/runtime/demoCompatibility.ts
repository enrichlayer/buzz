import type { InstalledRuntimePlugin } from "./types";

export const DEMO_PLUGINS = [
  {
    name: "Review card",
    fence: "buzz-review-card",
    ids: ["example.review-card"],
  },
  {
    name: "Feedback card",
    fence: "buzz-feedback-card",
    ids: ["example.feedback-card"],
  },
  {
    name: "Runbook",
    fence: "buzz-runbook",
    ids: ["example.runbook"],
  },
  {
    name: "Session demo",
    fence: "buzz-session-test",
    ids: ["demo.session-card", "test.session-card"],
  },
] as const;
export function demoPluginStatus(
  fence: string,
  plugins: InstalledRuntimePlugin[],
): string | null {
  const requirement = DEMO_PLUGINS.find((p) => p.fence === fence);
  if (!requirement) return null;
  // Match the renderer lookup in store.ts: the first enabled plugin wins.
  const matching = plugins.filter(
    (p) => p.manifest.schemaVersion === 1 && p.manifest.fenceLanguage === fence,
  );
  const entry = matching.find((p) => p.enabled) ?? matching[0];
  if (!entry) return "Missing";
  if (!entry.enabled) return "Disabled";
  if (!(requirement.ids as readonly string[]).includes(entry.manifest.id))
    return "Different renderer — review compatibility";
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.manifest.version))
    return "Incompatible version — requires stable 1.x";
  return "Ready";
}
