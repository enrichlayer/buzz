import {
  MAX_RUNTIME_CONTENT_BYTES,
  validateRuntimeContentData,
} from "./schema";
import type { RuntimePluginManifest, RuntimeValue } from "./types";

const MAX_ACTION_OUTPUT_LENGTH = 16_384;

export type ParsedRuntimePluginContent =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

export function parseRuntimePluginContent(
  manifest: RuntimePluginManifest,
  code: string,
): ParsedRuntimePluginContent {
  if (new TextEncoder().encode(code).byteLength > MAX_RUNTIME_CONTENT_BYTES) {
    return {
      ok: false,
      error: `Content exceeds ${MAX_RUNTIME_CONTENT_BYTES} bytes`,
    };
  }
  try {
    const data =
      manifest.contentType === "text" ? { text: code } : JSON.parse(code);
    const validationError = validateRuntimeContentData(data);
    return validationError
      ? { ok: false, error: validationError }
      : { ok: true, data };
  } catch (error) {
    return {
      ok: false,
      error: `Invalid JSON: ${
        error instanceof Error ? error.message : "could not parse content"
      }`,
    };
  }
}

function resolvePath(root: unknown, path: string): unknown {
  let value = root;
  for (const segment of path.split(".")) {
    if (Array.isArray(value) && /^\d+$/.test(segment)) {
      value = value[Number(segment)];
    } else if (
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, segment)
    ) {
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function displayValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

export function resolveRuntimeValue(
  value: RuntimeValue,
  data: unknown,
): string {
  if (typeof value === "string") return value;
  const resolved = resolvePath(data, value.path);
  return resolved === undefined
    ? (value.fallback ?? "")
    : displayValue(resolved);
}

export function resolveRuntimeTemplate(
  template: string,
  data: unknown,
  form: Record<string, string | boolean> = {},
): string {
  return template
    .replace(
      /\{\{\s*(data|form)\.([A-Za-z0-9_.-]+)\s*\}\}/g,
      (_, scope, path) =>
        displayValue(
          scope === "form" ? resolvePath(form, path) : resolvePath(data, path),
        ),
    )
    .slice(0, MAX_ACTION_OUTPUT_LENGTH);
}
