import {
  LIGHT_THEMES,
  SYNTAX_THEMES,
  type BuiltinThemeName,
} from "../../theme/theme-catalog";
import { luminance } from "../../theme/adaptive-theme";
import type { RuntimeThemeContribution } from "./types";

/** Only existing, resettable semantic colors may be contributed. Never CSS text. */
export const THEME_COLOR_KEYS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "secondary",
  "secondary-foreground",
  "primary",
  "primary-foreground",
  "border",
  "input",
  "ring",
  "destructive",
  "destructive-foreground",
  "sidebar-background",
  "sidebar-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
  "status-added",
  "status-deleted",
  "status-modified",
] as const;
const ALLOWED = new Set<string>(THEME_COLOR_KEYS);
const REQUIRED = ["background", "foreground", "primary", "primary-foreground"];
const HEX = /^#[0-9a-fA-F]{6}$/;
const LOCAL_ID = /^[a-z][a-z0-9-]{0,47}$/;

/** Validate all contributions before the plugin store can persist any of them. */
export function parseThemeContributions(
  value: unknown,
): RuntimeThemeContribution[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    throw new Error("themes must contain 1 to 8 themes");
  }
  const ids = new Set<string>();
  return value.map((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry))
      throw new Error("theme must be an object");
    const theme = entry as Record<string, unknown>;
    if (
      typeof theme.id !== "string" ||
      !LOCAL_ID.test(theme.id) ||
      ids.has(theme.id)
    )
      throw new Error("theme id must be unique and lowercase");
    ids.add(theme.id);
    if (
      typeof theme.name !== "string" ||
      !theme.name.trim() ||
      theme.name.length > 120
    )
      throw new Error("theme name must contain 1 to 120 characters");
    if (theme.mode !== "light" && theme.mode !== "dark")
      throw new Error("theme mode must be light or dark");
    if (!(SYNTAX_THEMES as readonly unknown[]).includes(theme.syntaxTheme))
      throw new Error("syntaxTheme must be a built-in theme");
    if (
      LIGHT_THEMES.has(theme.syntaxTheme as string) !==
      (theme.mode === "light")
    )
      throw new Error("syntaxTheme must match the theme mode");
    if (
      !theme.colors ||
      typeof theme.colors !== "object" ||
      Array.isArray(theme.colors)
    )
      throw new Error("theme colors must be an object");
    const colors: Record<string, string> = {};
    for (const [key, color] of Object.entries(theme.colors)) {
      if (!ALLOWED.has(key) || typeof color !== "string" || !HEX.test(color))
        throw new Error(
          `Unsupported theme color: ${key}; use an allowed token and #RRGGBB`,
        );
      colors[key] = color.toLowerCase();
    }
    if (REQUIRED.some((key) => !colors[key]))
      throw new Error(`theme colors require ${REQUIRED.join(", ")}`);
    if (luminance(colors.background) < 0.5 !== (theme.mode === "dark"))
      throw new Error("background must match the theme mode");
    return {
      id: theme.id,
      name: theme.name,
      mode: theme.mode,
      syntaxTheme: theme.syntaxTheme as BuiltinThemeName,
      colors,
    };
  });
}

/** A syntactically valid selection can be retained even when its package is absent. */
export function isPluginThemeName(name: string): name is `plugin:${string}` {
  return (
    name.length <= 190 &&
    /^plugin:[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+:[a-z][a-z0-9-]{0,47}$/.test(name)
  );
}
