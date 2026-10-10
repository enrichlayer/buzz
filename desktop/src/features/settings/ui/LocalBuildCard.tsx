import * as React from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import {
  checkDemoBuild,
  DEMO_CHANNEL,
  type LocalBuildInfo,
} from "./localBuildStatus";

export function LocalBuildCard() {
  const [info, setInfo] = React.useState<LocalBuildInfo | null>(null);
  const [status, setStatus] = React.useState("Build identity loading…");
  const [busy, setBusy] = React.useState(false);
  const [copied, setCopied] = React.useState("");
  React.useEffect(() => {
    let live = true;
    void invoke<LocalBuildInfo>("get_app_build_info")
      .then((value) => {
        if (live) {
          setInfo(value);
          setStatus("Not checked against coding demo channel");
        }
      })
      .catch(() => {
        if (live)
          setStatus(
            "Build identity unavailable in this native binary. Reinstall the local demo before checking its installed version.",
          );
      });
    return () => {
      live = false;
    };
  }, []);
  async function check() {
    if (!info) return;
    setBusy(true);
    setStatus("Checking coding demo channel…");
    try {
      setStatus(await checkDemoBuild(info));
    } catch (error) {
      setStatus(
        `Unable to check: ${error instanceof Error ? error.message : "network unavailable"}`,
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="rounded-xl border p-4 space-y-3 text-sm"
      aria-label="Local build identity"
    >
      <h3 className="font-medium">Installed build and coding demo channel</h3>
      <p>Channel: {DEMO_CHANNEL}</p>
      {info && (
        <p>
          v{info.version} · build {info.buildNumber}
          <br />
          {info.repository}
          <br />
          {info.revision} · {info.sourceState}
          <br />
          Built:{" "}
          {info.builtAtMs &&
          Number.isFinite(Number(info.builtAtMs)) &&
          !Number.isNaN(new Date(Number(info.builtAtMs)).getTime())
            ? new Date(Number(info.builtAtMs)).toLocaleString()
            : "unavailable"}
        </p>
      )}
      <p role="status">{status}</p>
      <p>
        This source check does not install updates. A newer upstream release may
        not contain the coding demo. See LOCAL-INSTALL.md in the checkout for
        setup and rebuild instructions.
      </p>
      <div className="flex gap-2">
        <Button disabled={!info || busy} onClick={() => void check()}>
          {busy ? "Checking…" : "Check demo channel"}
        </Button>
        <Button
          disabled={!info}
          variant="outline"
          onClick={() => {
            void writeTextToClipboard(
              JSON.stringify({ ...info, channel: DEMO_CHANNEL }, null, 2),
            )
              .then(() => setCopied("Build info copied"))
              .catch(() => setCopied("Could not copy build info"));
          }}
        >
          Copy build info
        </Button>
      </div>
      <p role="status">{copied}</p>
    </section>
  );
}
