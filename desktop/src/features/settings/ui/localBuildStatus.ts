export interface LocalBuildInfo {
  version: string;
  builtAtMs?: string;
  buildNumber: string;
  revision: string;
  sourceState: "clean" | "modified" | "unknown";
  repository: string;
}
export const DEMO_CHANNEL = "codex/buzz-local-install";
export const DEMO_REPOSITORY = "https://github.com/enrichlayer/buzz";
export function compareDemoBuild(
  info: LocalBuildInfo,
  remote: unknown,
): string {
  if (info.repository.replace(/\.git$/, "") !== DEMO_REPOSITORY)
    return "Different distribution — not the Enrich Layer demo repository";
  if (
    !/^[a-f0-9]{40}$/.test(info.revision) ||
    typeof remote !== "string" ||
    !/^[a-f0-9]{40}$/.test(remote)
  )
    return "Unable to check — source revision unavailable";
  if (info.sourceState !== "clean")
    return "Local changes or unknown source — cannot confirm current";
  return info.revision === remote
    ? "Current for coding demo channel"
    : "Different from coding demo channel — inspect source before rebuilding";
}
export async function checkDemoBuild(
  info: LocalBuildInfo,
  request: typeof fetch = fetch,
): Promise<string> {
  const response = await request(
    `https://api.github.com/repos/enrichlayer/buzz/commits/${encodeURIComponent(DEMO_CHANNEL)}`,
    {
      signal: AbortSignal.timeout(10000),
      headers: { Accept: "application/vnd.github+json" },
    },
  );
  if (!response.ok)
    throw new Error(`Channel check returned HTTP ${response.status}`);
  const value = await response.json();
  return compareDemoBuild(info, value?.sha);
}
