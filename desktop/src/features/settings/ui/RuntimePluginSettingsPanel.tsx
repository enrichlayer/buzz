import { DemoPluginChecklist } from "./DemoPluginChecklist";
import * as React from "react";
import { FileJson, Trash2 } from "lucide-react";
import { Button } from "@/shared/ui/button";
import { Switch } from "@/shared/ui/switch";
import { Textarea } from "@/shared/ui/textarea";
import {
  clearRuntimePluginStorage,
  installRuntimePlugin,
  removeRuntimePlugin,
  setRuntimePluginEnabled,
  updateRuntimePlugin,
  useRuntimePluginState,
} from "@/shared/plugins/runtime/store";
import {
  MAX_RUNTIME_MANIFEST_BYTES,
  parseRuntimePluginManifest,
} from "@/shared/plugins/runtime/schema";
import {
  SettingsOptionGroup,
  SettingsOptionGroupList,
} from "./SettingsOptionGroup";
import { SettingsSectionHeader } from "./SettingsSectionHeader";

const STARTER_MANIFEST = `{
  "schemaVersion": 1,
  "id": "example.feedback-card",
  "name": "Feedback card",
  "version": "1.0.0",
  "description": "Turns structured feedback into a review card.",
  "fenceLanguage": "buzz-feedback-card",
  "contentType": "json",
  "blocks": [
    { "type": "heading", "text": { "path": "title", "fallback": "Feedback" } },
    { "type": "text", "text": { "path": "summary" } },
    { "type": "action", "action": { "kind": "compose", "label": "Reply", "template": "Re: {{data.title}}\\n\\n" } }
  ]
}`;

export function RuntimePluginSettingsPanel() {
  const state = useRuntimePluginState();
  const [draft, setDraft] = React.useState(STARTER_MANIFEST);
  const [message, setMessage] = React.useState<string | null>(null);
  const parsed = React.useMemo(
    () => parseRuntimePluginManifest(draft),
    [draft],
  );
  const existing = parsed.ok
    ? state.plugins.find((entry) => entry.manifest.id === parsed.manifest.id)
    : undefined;

  const runMutation = async (kind: "install" | "update") => {
    if (!parsed.ok) {
      setMessage(parsed.error);
      return;
    }
    const result = await (kind === "install"
      ? installRuntimePlugin(parsed.manifest)
      : updateRuntimePlugin(parsed.manifest));
    setMessage(
      result.ok
        ? `${parsed.manifest.name} ${kind === "install" ? "installed" : "updated"}.`
        : result.error,
    );
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_RUNTIME_MANIFEST_BYTES) {
      setMessage(`Manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes.`);
      return;
    }
    try {
      setDraft(await file.text());
      setMessage(`Loaded ${file.name}. Review it, then install or update.`);
    } catch (error) {
      setMessage(
        `Could not read ${file.name}: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
      );
    }
  };

  return (
    <section>
      <SettingsSectionHeader
        description="Install versioned, data-only renderers for namespaced Markdown code fences. Plugins cannot run scripts, access the network, or send messages."
        title="Content plugins"
      />
      <DemoPluginChecklist />
      <SettingsOptionGroupList>
        {(state.loadError || state.persistenceError) && (
          <div
            className="space-y-2 rounded-xl border border-destructive/50 bg-destructive/5 p-4 text-sm"
            role="alert"
          >
            <p>{state.loadError ?? state.persistenceError}</p>
            {state.loadError ? (
              <Button
                onClick={() => void clearRuntimePluginStorage()}
                size="sm"
                type="button"
                variant="outline"
              >
                Clear corrupted plugin data
              </Button>
            ) : null}
          </div>
        )}

        <SettingsOptionGroup
          description="Each definition is stored on this device. Disabling a plugin immediately restores the normal code block."
          title={`Installed (${state.plugins.length})`}
        >
          {state.plugins.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">
              No runtime plugins installed.
            </div>
          ) : (
            state.plugins.map((entry) => (
              <div
                className="flex items-center gap-3 px-4 py-3"
                data-testid={`runtime-plugin-row-${entry.manifest.id}`}
                key={entry.manifest.id}
              >
                <Switch
                  aria-label={`${entry.enabled ? "Disable" : "Enable"} ${entry.manifest.name}`}
                  checked={entry.enabled}
                  data-testid={`runtime-plugin-toggle-${entry.manifest.id}`}
                  onCheckedChange={(enabled) =>
                    void setRuntimePluginEnabled(entry.manifest.id, enabled)
                  }
                />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2">
                    <span className="font-medium">{entry.manifest.name}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      v{entry.manifest.version}
                    </span>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    ```{entry.manifest.fenceLanguage}
                  </p>
                  {entry.manifest.description ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {entry.manifest.description}
                    </p>
                  ) : null}
                </div>
                <Button
                  aria-label={`Load ${entry.manifest.name} manifest for editing`}
                  onClick={() => {
                    setDraft(JSON.stringify(entry.manifest, null, 2));
                    setMessage(
                      `Loaded ${entry.manifest.name}. Edit and choose Update.`,
                    );
                  }}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  Edit
                </Button>
                <Button
                  aria-label={`Remove ${entry.manifest.name}`}
                  onClick={() => void removeRuntimePlugin(entry.manifest.id)}
                  size="icon"
                  type="button"
                  variant="ghost"
                >
                  <Trash2 />
                </Button>
              </div>
            ))
          )}
        </SettingsOptionGroup>

        <SettingsOptionGroup
          description={`Paste JSON or choose a .json file (maximum ${MAX_RUNTIME_MANIFEST_BYTES / 1024} KiB). Existing ids require the explicit Update action.`}
          title="Install or update"
        >
          <div className="space-y-3 p-4">
            <Textarea
              aria-label="Runtime plugin manifest"
              className="min-h-72 font-mono text-xs"
              data-testid="runtime-plugin-manifest-input"
              onChange={(event) => {
                setDraft(event.target.value);
                setMessage(null);
              }}
              value={draft}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button asChild size="sm" type="button" variant="outline">
                <label className="cursor-pointer">
                  <FileJson />
                  Choose JSON file
                  <input
                    accept="application/json,.json"
                    className="sr-only"
                    data-testid="runtime-plugin-file-input"
                    onChange={(event) => {
                      void readFile(event.target.files?.[0]);
                      event.target.value = "";
                    }}
                    type="file"
                  />
                </label>
              </Button>
              <Button
                data-testid="runtime-plugin-install"
                disabled={!parsed.ok || Boolean(existing)}
                onClick={() => void runMutation("install")}
                size="sm"
                type="button"
              >
                Install
              </Button>
              <Button
                data-testid="runtime-plugin-update"
                disabled={!parsed.ok || !existing}
                onClick={() => void runMutation("update")}
                size="sm"
                type="button"
                variant="secondary"
              >
                Update {existing?.manifest.name ?? "installed plugin"}
              </Button>
            </div>
            <p
              className={
                parsed.ok
                  ? "text-xs text-muted-foreground"
                  : "text-xs text-destructive"
              }
              role={parsed.ok ? undefined : "alert"}
            >
              {message ??
                (parsed.ok
                  ? `${parsed.manifest.name} ${parsed.manifest.version} · ${parsed.manifest.fenceLanguage}`
                  : parsed.error)}
            </p>
          </div>
        </SettingsOptionGroup>
      </SettingsOptionGroupList>
    </section>
  );
}
