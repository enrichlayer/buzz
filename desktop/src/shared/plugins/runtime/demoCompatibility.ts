import type { InstalledRuntimePlugin } from "./types";

export const DEMO_PLUGINS = [
  {
    name: "Review card",
    fence: "buzz-review-card",
    ids: ["example.review-card"],
    minimum: "1.0.0",
  },
  {
    name: "Feedback card",
    fence: "buzz-feedback-card",
    ids: ["example.feedback-card"],
    minimum: "1.0.0",
  },
  {
    name: "Runbook",
    fence: "buzz-runbook",
    ids: ["example.runbook"],
    minimum: "1.0.0",
  },
  {
    name: "Session demo",
    fence: "buzz-session-test",
    ids: ["demo.session-card", "test.session-card"],
    minimum: "1.0.0",
  },
] as const;
export function demoPluginStatus(
  fence: string,
  plugins: InstalledRuntimePlugin[],
): string | null {
  const requirement = DEMO_PLUGINS.find((p) => p.fence === fence);
  if (!requirement) return null;
  const entry = plugins.find((p) => p.manifest.fenceLanguage === fence);
  if (!entry) return "Missing";
  if (!entry.enabled) return "Disabled";
  if (!(requirement.ids as readonly string[]).includes(entry.manifest.id))
    return "Different renderer — review compatibility";
  if (!/^1\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(entry.manifest.version))
    return "Incompatible version — requires stable 1.x";
  return "Ready";
}
