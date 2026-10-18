import { bundledLanguagesInfo } from "shiki";

const languages = new Map(
  bundledLanguagesInfo.flatMap(({ id, name, aliases = [] }) =>
    [id, name, ...aliases].map((label) => [label.toLowerCase(), id] as const),
  ),
);
const PLAIN_TEXT = new Set(["text", "txt", "plain", "plaintext"]);
export const MAX_HIGHLIGHT_CHARACTERS = 50_000;
export const MAX_HIGHLIGHT_LINES = 1_000;

/** Keep tokenization and retained token arrays bounded, including single-line pastes. */
export function canHighlightCode(code: string): boolean {
  return (
    code.length <= MAX_HIGHLIGHT_CHARACTERS &&
    code.split("\n").length <= MAX_HIGHLIGHT_LINES
  );
}

/** Resolve fence labels; infer only distinctive syntax when the author omitted one. */
export function resolveCodeLanguage(code: string, label = ""): string {
  const normalized = label.trim().toLowerCase();
  if (PLAIN_TEXT.has(normalized)) return "";
  if (normalized) return languages.get(normalized) ?? "";
  if (!canHighlightCode(code)) return "";
  const source = code.trim();
  if (source.startsWith("{") || source.startsWith("[")) {
    try {
      JSON.parse(source);
      return "json";
    } catch {
      // Incomplete JSON may be a streamed fragment or another language.
    }
  }
  if (/^#![^\n]*\b(?:bash|sh|zsh)\b/.test(source)) return "shellscript";
  if (
    /^#![^\n]*\bpython[\d.]*\b/.test(source) ||
    /^(?:async\s+)?def\s+\w+\([^\n]*\)\s*(?:->[^\n]+)?\s*:/m.test(source)
  ) {
    return "python";
  }
  if (
    /^(?:export\s+)?(?:interface|type)\s+\w+\s*[={]|^(?:export\s+)?(?:const|let)\s+\w+\s*:\s*\w+/m.test(
      source,
    )
  ) {
    return "typescript";
  }
  if (
    /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=|^(?:export\s+)?(?:async\s+)?function\s+\w+\s*\(/m.test(
      source,
    )
  ) {
    return "javascript";
  }
  return "";
}

const FILE_LANGUAGE_BY_EXTENSION: Record<string, string> = {
  c: "c",
  cc: "cpp",
  cjs: "javascript",
  cts: "typescript",
  cpp: "cpp",
  cs: "csharp",
  css: "css",
  dart: "dart",
  go: "go",
  h: "c",
  hpp: "cpp",
  html: "html",
  java: "java",
  js: "javascript",
  json: "json",
  jsx: "jsx",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "bash",
  sql: "sql",
  swift: "swift",
  toml: "toml",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
  zig: "zig",
};

/** Resolve a source file name to its bundled syntax grammar. */
export function languageForCodePath(path: string) {
  const fileName = (path.split(/[\\/]/).pop() ?? "").toLowerCase();
  if (fileName === "dockerfile") return "dockerfile";
  if (fileName === "makefile") return "make";
  const extension = fileName.split(".").pop();
  return extension
    ? (FILE_LANGUAGE_BY_EXTENSION[extension] ?? languages.get(extension))
    : undefined;
}
