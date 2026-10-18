import { getRuntimePluginState } from "../plugins/runtime/store";
import type {
  RuntimePluginStoreState,
  RuntimeThemeContribution,
} from "../plugins/runtime/types";
import { hexToHsl } from "./adaptive-theme";

/** A validated contribution with its globally namespaced selection key. */
export type PluginTheme = RuntimeThemeContribution & {
  selection: `plugin:${string}`;
};

/** Only enabled, validated definitions enter the theme catalog. */
export function getPluginThemes(
  snapshot: RuntimePluginStoreState = getRuntimePluginState(),
): PluginTheme[] {
  return snapshot.plugins.flatMap(({ enabled, manifest }) =>
    enabled && manifest.schemaVersion === 2
      ? manifest.themes.map((theme) => ({
          ...theme,
          selection: `plugin:${manifest.id}:${theme.id}` as const,
        }))
      : [],
  );
}

/** Resolve an enabled contribution; missing or disabled packages return undefined. */
export function getPluginTheme(name: string): PluginTheme | undefined {
  return getPluginThemes().find((theme) => theme.selection === name);
}

/** Every allowed variable is also written by the base engine or accent handler.
 * Derive a fresh base before overlaying, so removing tokens cannot leave stale CSS.
 */
export function applyPluginThemeColors(
  name: string,
  vars: Record<string, string>,
): Record<string, string> {
  const theme = getPluginTheme(name);
  if (!theme) return vars;
  const result = { ...vars };
  for (const [key, color] of Object.entries(theme.colors)) {
    result[`--${key}`] = key.startsWith("status-") ? color : hexToHsl(color);
  }
  const primary = result["--primary"];
  const foreground = result["--primary-foreground"];
  for (const key of [
    "--sidebar-primary",
    "--sidebar-active",
    "--buzz-selected-accent",
  ])
    result[key] = primary;
  for (const key of [
    "--sidebar-primary-foreground",
    "--sidebar-active-foreground",
  ])
    result[key] = foreground;
  return result;
}
