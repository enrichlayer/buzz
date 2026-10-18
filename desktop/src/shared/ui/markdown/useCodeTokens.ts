import * as React from "react";
import {
  getSingletonHighlighter,
  type HighlighterGeneric,
  type BundledLanguage,
  type BundledTheme,
  type ThemedToken,
} from "shiki";
import { useSyntaxThemeName } from "@/shared/theme/ThemeProvider";
import { resolveShikiThemeName } from "@/shared/theme/theme-loader";
import { canHighlightCode, resolveCodeLanguage } from "./codeLanguage";

let shikiHighlighter: HighlighterGeneric<BundledLanguage, BundledTheme> | null =
  null;
let shikiInitPromise: Promise<void> | null = null;
const loadedLangs = new Set<string>();
const loadedThemes = new Set<string>();
const tokenCache = new Map<string, ThemedToken[][]>();
const MAX_CACHE_ENTRIES = 100;
const MAX_LOADED_LANGUAGES = 30;

/** Drop tokenized community content when switching identities/relays. */
export function clearCodeTokenCache(): void {
  tokenCache.clear();
}

function ensureHighlighter(): Promise<void> {
  if (shikiHighlighter) return Promise.resolve();
  if (!shikiInitPromise) {
    shikiInitPromise = getSingletonHighlighter({
      themes: [],
      langs: [],
    })
      .then((h) => {
        shikiHighlighter = h;
      })
      .catch((error) => {
        shikiInitPromise = null;
        throw error;
      });
  }
  return shikiInitPromise;
}

/** Shared bounded, theme-aware tokenization for code blocks and code previews. */
export function useCodeTokens(code: string, languageHint = "") {
  const themeName = useSyntaxThemeName();
  const language = resolveCodeLanguage(code, languageHint);
  const highlightable = canHighlightCode(code);
  // Buzz aliases ("buzz" / "buzz-dark") are not bundled Shiki themes — resolve
  // to the real bundle (github-light / github-dark) before touching Shiki, or
  // it throws and code blocks fall back to plain text.
  const shikiTheme = resolveShikiThemeName(themeName);
  const [loadedKey, setLoadedKey] = React.useState(0);

  React.useEffect(() => {
    if (!language || !highlightable) return;
    let cancelled = false;
    async function loadAssets() {
      try {
        await ensureHighlighter();
        if (!shikiHighlighter || cancelled) return;
        if (!loadedLangs.has(language)) {
          if (loadedLangs.size >= MAX_LOADED_LANGUAGES) return;
          try {
            await shikiHighlighter.loadLanguage(language as BundledLanguage);
            loadedLangs.add(language);
          } catch {
            return;
          }
        }
        if (!loadedThemes.has(shikiTheme)) {
          try {
            await shikiHighlighter.loadTheme(shikiTheme as BundledTheme);
            loadedThemes.add(shikiTheme);
          } catch {
            return;
          }
        }
        // Another block may have finished loading while this one awaited the
        // singleton. Every waiting block must render the now-available tokens.
        if (!cancelled) setLoadedKey((k) => k + 1);
      } catch {
        /* ignore */
      }
    }
    if (!loadedLangs.has(language) || !loadedThemes.has(shikiTheme)) {
      loadAssets();
    }
    return () => {
      cancelled = true;
    };
  }, [language, shikiTheme, highlightable]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: loadedKey intentionally triggers re-memoization after async asset loading
  return React.useMemo(() => {
    if (
      !highlightable ||
      !shikiHighlighter ||
      !loadedLangs.has(language) ||
      !loadedThemes.has(shikiTheme)
    )
      return null;
    const cacheKey = `${language}:${shikiTheme}:${code}`;
    const cached = tokenCache.get(cacheKey);
    if (cached) return cached;
    try {
      const result = shikiHighlighter.codeToTokens(code, {
        lang: language as BundledLanguage,
        theme: shikiTheme as BundledTheme,
      });
      if (tokenCache.size >= MAX_CACHE_ENTRIES) {
        const firstKey = tokenCache.keys().next().value;
        if (firstKey !== undefined) tokenCache.delete(firstKey);
      }
      tokenCache.set(cacheKey, result.tokens);
      return result.tokens;
    } catch {
      return null;
    }
  }, [code, language, shikiTheme, loadedKey, highlightable]);
}
