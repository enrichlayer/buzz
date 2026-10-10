import {
  DEMO_PLUGINS,
  demoPluginStatus,
} from "@/shared/plugins/runtime/demoCompatibility";
import { useRuntimePluginState } from "@/shared/plugins/runtime/store";

export function DemoPluginChecklist() {
  const { plugins, loadError } = useRuntimePluginState();
  return (
    <div className="rounded-xl border p-4 text-sm space-y-2">
      <h3 className="font-medium">Coding demo compatibility</h3>
      <p>
        These optional renderers are installed separately on each desktop.
        Required versions: stable 1.x (minimum 1.0.0).
      </p>
      {loadError ? (
        <p role="alert">
          Plugin status unavailable until saved plugin data can be read.
        </p>
      ) : (
        <ul>
          {DEMO_PLUGINS.map((p) => (
            <li key={p.fence}>
              {p.name}: {demoPluginStatus(p.fence, plugins)}
            </li>
          ))}
        </ul>
      )}
      <p>
        Import the JSON files from docs/examples/runtime-plugins in your local
        checkout below. Keep an existing compatible renderer; do not remove it
        to install a duplicate.
      </p>
    </div>
  );
}
