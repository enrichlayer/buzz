import { useQuery } from "@tanstack/react-query";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

export interface AppBuildInfo {
  version: string;
  buildNumber: string;
  revision: string;
  sourceState: "clean" | "modified" | "unknown";
  repository: string;
}

export function buildVersionLabel(info: AppBuildInfo): string {
  return `v${info.version} · build ${info.buildNumber}`;
}

export function AppBuildVersion() {
  const { data, isError } = useQuery({
    queryKey: ["app-build-info"],
    queryFn: () => invoke<AppBuildInfo>("get_app_build_info"),
    staleTime: Infinity,
    retry: false,
  });

  if (!data) {
    return isError ? (
      <p className="px-2 pb-1 text-xs text-sidebar-foreground/60">
        Build unavailable
      </p>
    ) : null;
  }

  const revision = /^[a-f0-9]{40,64}$/.test(data.revision)
    ? data.revision
    : null;
  return (
    <div
      className="px-2 pb-1 text-xs text-sidebar-foreground/60 group-data-[collapsible=icon]:hidden"
      data-testid="settings-version"
    >
      <p>{buildVersionLabel(data)}</p>
      <button
        type="button"
        className="text-left hover:underline"
        title={revision ?? "Source revision unavailable"}
        onClick={() => {
          void openUrl(
            revision
              ? `${data.repository}/commit/${revision}`
              : data.repository,
          ).catch(() => {
            toast.error("Could not open source revision");
          });
        }}
      >
        enrichlayer/buzz · {revision?.slice(0, 7) ?? "unknown revision"}
        {data.sourceState === "modified"
          ? " · modified"
          : data.sourceState === "unknown"
            ? " · source unknown"
            : ""}
      </button>
    </div>
  );
}
