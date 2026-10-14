import type {
  RuntimePluginAction,
  RuntimePluginBlock,
  RuntimePluginField,
  RuntimePluginManifest,
  RuntimeValue,
} from "./types";

export const MAX_RUNTIME_MANIFEST_BYTES = 64 * 1024;
export const MAX_RUNTIME_CONTENT_BYTES = 128 * 1024;
export const MAX_RUNTIME_SCHEMA_DEPTH = 8;
export const MAX_RUNTIME_SCHEMA_NODES = 128;
export const MAX_RUNTIME_DATA_DEPTH = 16;
export const MAX_RUNTIME_DATA_NODES = 2_048;

const MAX_STRING_LENGTH = 16_384;
const ID_RE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)+$/;
const FENCE_RE = /^buzz-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FIELD_ID_RE = /^[a-z][a-z0-9_-]{0,63}$/;
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const BUILT_IN_FENCES = new Set(["mermaid", "buzz-annotation"]);
const BLOCK_TYPES = new Set([
  "heading",
  "text",
  "code",
  "diff",
  "accordion",
  "action",
  "form",
]);
const FIELD_TYPES = new Set(["text", "textarea", "select", "checkbox"]);
const ACTION_KINDS = new Set(["copy", "compose"]);
const SAFE_PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$|^(0|[1-9]\d*)$/;
const RESERVED_PATH_SEGMENTS = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);

export type RuntimePluginValidationResult =
  | { ok: true; manifest: RuntimePluginManifest }
  | { ok: false; error: string };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, label: string, maxLength = 256): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    throw new Error(`${label} exceeds ${maxLength} characters`);
  }
  return value;
}

export function isSafeRuntimeDataPath(path: string): boolean {
  if (!path || path.length > 256) return false;
  const segments = path.split(".");
  return (
    segments.length <= 16 &&
    segments.every(
      (segment) =>
        SAFE_PATH_SEGMENT_RE.test(segment) &&
        !RESERVED_PATH_SEGMENTS.has(segment),
    )
  );
}

function parseValue(value: unknown, label: string): RuntimeValue {
  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      throw new Error(`${label} exceeds ${MAX_STRING_LENGTH} characters`);
    }
    return value;
  }
  if (!isObject(value)) throw new Error(`${label} must be text or a data path`);
  const path = stringField(value.path, `${label}.path`);
  if (!isSafeRuntimeDataPath(path)) {
    throw new Error(`${label}.path is not a safe dotted data path`);
  }
  const fallback =
    value.fallback === undefined
      ? undefined
      : stringField(value.fallback, `${label}.fallback`, 2_048);
  return { path, ...(fallback === undefined ? {} : { fallback }) };
}

function parseAction(value: unknown, label: string): RuntimePluginAction {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const kind = stringField(value.kind, `${label}.kind`);
  if (!ACTION_KINDS.has(kind)) {
    throw new Error(`${label}.kind must be copy or compose`);
  }
  return {
    kind: kind as RuntimePluginAction["kind"],
    label: stringField(value.label, `${label}.label`, 80),
    template: stringField(value.template, `${label}.template`, 8_192),
  };
}

function parseField(value: unknown, label: string): RuntimePluginField {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  const id = stringField(value.id, `${label}.id`, 64);
  if (!FIELD_ID_RE.test(id) || RESERVED_PATH_SEGMENTS.has(id)) {
    throw new Error(`${label}.id is invalid`);
  }
  const type = stringField(value.type, `${label}.type`);
  if (!FIELD_TYPES.has(type)) throw new Error(`${label}.type is unsupported`);
  const options = value.options;
  if (type === "select") {
    if (
      !Array.isArray(options) ||
      options.length === 0 ||
      options.length > 32 ||
      options.some((option) => typeof option !== "string" || !option.trim())
    ) {
      throw new Error(`${label}.options must contain 1 to 32 strings`);
    }
  } else if (options !== undefined) {
    throw new Error(`${label}.options is only valid for select fields`);
  }
  if (value.required !== undefined && typeof value.required !== "boolean") {
    throw new Error(`${label}.required must be a boolean`);
  }
  return {
    id,
    label: stringField(value.label, `${label}.label`, 120),
    type: type as RuntimePluginField["type"],
    ...(value.initial === undefined
      ? {}
      : { initial: parseValue(value.initial, `${label}.initial`) }),
    ...(Array.isArray(options) ? { options: options as string[] } : {}),
    ...(value.placeholder === undefined
      ? {}
      : {
          placeholder: stringField(
            value.placeholder,
            `${label}.placeholder`,
            240,
          ),
        }),
    ...(value.required === undefined ? {} : { required: value.required }),
  };
}

function parseBlocks(
  value: unknown,
  depth: number,
  counter: { nodes: number },
  label: string,
): RuntimePluginBlock[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
  if (depth > MAX_RUNTIME_SCHEMA_DEPTH) {
    throw new Error(`plugin layout exceeds depth ${MAX_RUNTIME_SCHEMA_DEPTH}`);
  }
  return value.map((candidate, index) => {
    counter.nodes += 1;
    if (counter.nodes > MAX_RUNTIME_SCHEMA_NODES) {
      throw new Error(
        `plugin layout exceeds ${MAX_RUNTIME_SCHEMA_NODES} nodes`,
      );
    }
    const nodeLabel = `${label}[${index}]`;
    if (!isObject(candidate)) throw new Error(`${nodeLabel} must be an object`);
    const type = stringField(candidate.type, `${nodeLabel}.type`);
    if (!BLOCK_TYPES.has(type))
      throw new Error(`${nodeLabel}.type is unsupported`);
    switch (type) {
      case "heading": {
        const level = candidate.level ?? 3;
        if (level !== 2 && level !== 3 && level !== 4) {
          throw new Error(`${nodeLabel}.level must be 2, 3, or 4`);
        }
        return {
          type,
          text: parseValue(candidate.text, `${nodeLabel}.text`),
          level,
        };
      }
      case "text":
        return { type, text: parseValue(candidate.text, `${nodeLabel}.text`) };
      case "code":
        return {
          type,
          value: parseValue(candidate.value, `${nodeLabel}.value`),
          ...(candidate.language === undefined
            ? {}
            : {
                language: stringField(
                  candidate.language,
                  `${nodeLabel}.language`,
                  40,
                ),
              }),
        };
      case "diff":
        return {
          type,
          value: parseValue(candidate.value, `${nodeLabel}.value`),
          ...(candidate.filename === undefined
            ? {}
            : {
                filename: parseValue(
                  candidate.filename,
                  `${nodeLabel}.filename`,
                ),
              }),
        };
      case "accordion":
        return {
          type,
          title: parseValue(candidate.title, `${nodeLabel}.title`),
          children: parseBlocks(
            candidate.children,
            depth + 1,
            counter,
            `${nodeLabel}.children`,
          ),
        };
      case "action":
        return {
          type,
          action: parseAction(candidate.action, `${nodeLabel}.action`),
        };
      case "form": {
        if (!Array.isArray(candidate.fields) || candidate.fields.length === 0) {
          throw new Error(`${nodeLabel}.fields must be a non-empty array`);
        }
        if (candidate.fields.length > 32) {
          throw new Error(`${nodeLabel}.fields exceeds 32 fields`);
        }
        const fields = candidate.fields.map((field, fieldIndex) =>
          parseField(field, `${nodeLabel}.fields[${fieldIndex}]`),
        );
        if (new Set(fields.map((field) => field.id)).size !== fields.length) {
          throw new Error(`${nodeLabel}.fields contains duplicate ids`);
        }
        const id = stringField(candidate.id, `${nodeLabel}.id`, 64);
        if (!FIELD_ID_RE.test(id) || RESERVED_PATH_SEGMENTS.has(id))
          throw new Error(`${nodeLabel}.id is invalid`);
        return {
          type,
          id,
          ...(candidate.title === undefined
            ? {}
            : { title: parseValue(candidate.title, `${nodeLabel}.title`) }),
          fields,
          submit: parseAction(candidate.submit, `${nodeLabel}.submit`),
        };
      }
      default:
        throw new Error(`${nodeLabel}.type is unsupported`);
    }
  });
}

export function parseRuntimePluginManifest(
  raw: string,
): RuntimePluginValidationResult {
  if (new TextEncoder().encode(raw).byteLength > MAX_RUNTIME_MANIFEST_BYTES) {
    return {
      ok: false,
      error: `Manifest exceeds ${MAX_RUNTIME_MANIFEST_BYTES} bytes`,
    };
  }
  try {
    const value: unknown = JSON.parse(raw);
    if (!isObject(value)) throw new Error("Manifest must be a JSON object");
    if (value.schemaVersion !== 1) {
      throw new Error("schemaVersion must be 1");
    }
    const id = stringField(value.id, "id", 120);
    if (!ID_RE.test(id))
      throw new Error("id must be a namespaced lowercase id");
    const version = stringField(value.version, "version", 80);
    if (!SEMVER_RE.test(version))
      throw new Error("version must be valid semver");
    const fenceLanguage = stringField(value.fenceLanguage, "fenceLanguage", 64);
    if (!FENCE_RE.test(fenceLanguage)) {
      throw new Error("fenceLanguage must be a namespaced buzz-* language");
    }
    if (BUILT_IN_FENCES.has(fenceLanguage)) {
      throw new Error(`${fenceLanguage} is a built-in fence language`);
    }
    const contentType = value.contentType ?? "json";
    if (contentType !== "json" && contentType !== "text") {
      throw new Error("contentType must be json or text");
    }
    const manifest: RuntimePluginManifest = {
      schemaVersion: 1,
      id,
      name: stringField(value.name, "name", 120),
      version,
      ...(value.description === undefined
        ? {}
        : { description: stringField(value.description, "description", 500) }),
      fenceLanguage,
      contentType,
      blocks: parseBlocks(value.blocks, 1, { nodes: 0 }, "blocks"),
    };
    return { ok: true, manifest };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Invalid manifest",
    };
  }
}

export function validateRuntimeContentData(value: unknown): string | null {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): string | null => {
    nodes += 1;
    if (nodes > MAX_RUNTIME_DATA_NODES) {
      return `Content exceeds ${MAX_RUNTIME_DATA_NODES} values`;
    }
    if (depth > MAX_RUNTIME_DATA_DEPTH) {
      return `Content exceeds depth ${MAX_RUNTIME_DATA_DEPTH}`;
    }
    if (typeof candidate === "string" && candidate.length > MAX_STRING_LENGTH) {
      return `Content string exceeds ${MAX_STRING_LENGTH} characters`;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        const error = visit(item, depth + 1);
        if (error) return error;
      }
    } else if (isObject(candidate)) {
      for (const [key, item] of Object.entries(candidate)) {
        if (key.length > 256 || RESERVED_PATH_SEGMENTS.has(key)) {
          return `Content contains unsupported key ${key}`;
        }
        const error = visit(item, depth + 1);
        if (error) return error;
      }
    }
    return null;
  };
  return visit(value, 0);
}
