import * as React from "react";
import { DiffViewer } from "@/features/messages/ui/DiffViewer";
import { copyTextToClipboard } from "@/shared/lib/clipboard";
import { Button } from "@/shared/ui/button";
import { Checkbox } from "@/shared/ui/checkbox";
import { Input } from "@/shared/ui/input";
import { MarkdownCodeBlock } from "@/shared/ui/markdown/CodeBlock";
import { Textarea } from "@/shared/ui/textarea";
import { useRuntimePluginHost } from "./RuntimePluginHost";
import {
  parseRuntimePluginContent,
  resolveRuntimeTemplate,
  resolveRuntimeValue,
} from "./renderData";
import type {
  RuntimePluginAction,
  RuntimePluginBlock,
  RuntimePluginField,
  RuntimePluginManifest,
} from "./types";

function RuntimeActionButton({
  action,
  data,
  form,
}: {
  action: RuntimePluginAction;
  data: unknown;
  form?: Record<string, string | boolean>;
}) {
  const { onCompose } = useRuntimePluginHost();
  const unavailable = action.kind === "compose" && !onCompose;
  const run = () => {
    const text = resolveRuntimeTemplate(action.template, data, form);
    if (action.kind === "copy") {
      copyTextToClipboard(text);
    } else {
      onCompose?.(text);
    }
  };
  return (
    <Button
      data-runtime-action={action.kind}
      disabled={unavailable}
      onClick={run}
      size="sm"
      title={
        unavailable ? "Open this content in a thread to compose" : undefined
      }
      type="button"
      variant="outline"
    >
      {action.label}
    </Button>
  );
}

function initialFieldValue(field: RuntimePluginField, data: unknown) {
  if (field.type === "checkbox") {
    return field.initial
      ? resolveRuntimeValue(field.initial, data) === "true"
      : false;
  }
  if (field.type === "select" && !field.initial)
    return field.options?.[0] ?? "";
  return field.initial ? resolveRuntimeValue(field.initial, data) : "";
}

function RuntimeForm({
  block,
  data,
}: {
  block: Extract<RuntimePluginBlock, { type: "form" }>;
  data: unknown;
}) {
  const { onCompose } = useRuntimePluginHost();
  const formDomId = React.useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const initialValues = React.useMemo(
    () =>
      Object.fromEntries(
        block.fields.map((field) => [field.id, initialFieldValue(field, data)]),
      ) as Record<string, string | boolean>,
    [block.fields, data],
  );
  const [values, setValues] = React.useState(initialValues);
  const [validationError, setValidationError] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    setValues(initialValues);
    setValidationError(null);
  }, [initialValues]);

  const submit = () => {
    const missing = block.fields.find((field) => {
      if (!field.required) return false;
      const value = values[field.id];
      return field.type === "checkbox"
        ? value !== true
        : typeof value !== "string" || !value.trim();
    });
    if (missing) {
      setValidationError(`${missing.label} is required.`);
      return;
    }
    setValidationError(null);
    const text = resolveRuntimeTemplate(block.submit.template, data, values);
    if (block.submit.kind === "copy") copyTextToClipboard(text);
    else onCompose?.(text);
  };
  const submitUnavailable = block.submit.kind === "compose" && !onCompose;

  return (
    <form
      className="space-y-3 rounded-xl border border-border/60 bg-muted/20 p-3"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {block.title ? (
        <h3 className="text-sm font-semibold">
          {resolveRuntimeValue(block.title, data)}
        </h3>
      ) : null}
      {block.fields.map((field) => {
        const inputId = `runtime-${formDomId}-${block.id}-${field.id}`;
        if (field.type === "checkbox") {
          return (
            <label
              className="flex items-center gap-2 text-sm"
              htmlFor={inputId}
              key={field.id}
            >
              <Checkbox
                aria-invalid={
                  field.required && validationError !== null
                    ? values[field.id] !== true
                    : undefined
                }
                checked={Boolean(values[field.id])}
                id={inputId}
                onCheckedChange={(checked) => {
                  setValidationError(null);
                  setValues((current) => ({
                    ...current,
                    [field.id]: checked === true,
                  }));
                }}
                required={field.required}
              />
              {field.label}
            </label>
          );
        }
        return (
          <label
            className="block space-y-1 text-sm"
            htmlFor={inputId}
            key={field.id}
          >
            <span className="font-medium">{field.label}</span>
            {field.type === "textarea" ? (
              <Textarea
                id={inputId}
                onChange={(event) => {
                  setValidationError(null);
                  setValues((current) => ({
                    ...current,
                    [field.id]: event.target.value,
                  }));
                }}
                placeholder={field.placeholder}
                required={field.required}
                value={String(values[field.id] ?? "")}
              />
            ) : field.type === "select" ? (
              <select
                className="flex h-9 w-full rounded-lg border border-input/40 bg-background px-3 text-sm focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
                id={inputId}
                onChange={(event) => {
                  setValidationError(null);
                  setValues((current) => ({
                    ...current,
                    [field.id]: event.target.value,
                  }));
                }}
                required={field.required}
                value={String(values[field.id] ?? field.options?.[0] ?? "")}
              >
                {field.options?.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <Input
                id={inputId}
                onChange={(event) => {
                  setValidationError(null);
                  setValues((current) => ({
                    ...current,
                    [field.id]: event.target.value,
                  }));
                }}
                placeholder={field.placeholder}
                required={field.required}
                value={String(values[field.id] ?? "")}
              />
            )}
          </label>
        );
      })}
      {validationError ? (
        <p className="text-xs text-destructive" role="alert">
          {validationError}
        </p>
      ) : null}
      <Button
        data-runtime-action={block.submit.kind}
        disabled={submitUnavailable}
        size="sm"
        title={
          submitUnavailable
            ? "Open this content in a thread to compose"
            : undefined
        }
        type="submit"
        variant="outline"
      >
        {block.submit.label}
      </Button>
    </form>
  );
}

function RuntimeBlocks({
  blocks,
  data,
}: {
  blocks: RuntimePluginBlock[];
  data: unknown;
}) {
  return blocks.map((block, index) => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case "heading": {
        const text = resolveRuntimeValue(block.text, data);
        if (block.level === 2)
          return (
            <h2 className="text-lg font-semibold" key={key}>
              {text}
            </h2>
          );
        if (block.level === 4)
          return (
            <h4 className="text-sm font-semibold" key={key}>
              {text}
            </h4>
          );
        return (
          <h3 className="text-base font-semibold" key={key}>
            {text}
          </h3>
        );
      }
      case "text":
        return (
          <p
            className="whitespace-pre-wrap text-sm text-foreground/90"
            key={key}
          >
            {resolveRuntimeValue(block.text, data)}
          </p>
        );
      case "code":
        return (
          <MarkdownCodeBlock key={key} language={block.language}>
            {resolveRuntimeValue(block.value, data)}
          </MarkdownCodeBlock>
        );
      case "diff":
        return (
          <DiffViewer
            content={resolveRuntimeValue(block.value, data)}
            fallbackFilePath={
              block.filename
                ? resolveRuntimeValue(block.filename, data)
                : undefined
            }
            key={key}
          />
        );
      case "accordion":
        return (
          <details
            className="rounded-xl border border-border/60 bg-muted/20"
            key={key}
          >
            <summary className="cursor-pointer px-3 py-2 text-sm font-medium">
              {resolveRuntimeValue(block.title, data)}
            </summary>
            <div className="space-y-3 border-t border-border/60 p-3">
              <RuntimeBlocks blocks={block.children} data={data} />
            </div>
          </details>
        );
      case "action":
        return (
          <RuntimeActionButton action={block.action} data={data} key={key} />
        );
      case "form":
        return (
          <RuntimeForm block={block} data={data} key={`${key}-${block.id}`} />
        );
      default: {
        const exhaustiveCheck: never = block;
        return exhaustiveCheck;
      }
    }
  });
}

export function RuntimePluginRenderer({
  code,
  fallback,
  manifest,
}: {
  code: string;
  fallback: React.ReactNode;
  manifest: RuntimePluginManifest;
}) {
  const parsed = React.useMemo(
    () => parseRuntimePluginContent(manifest, code),
    [code, manifest],
  );
  if (!parsed.ok) {
    return (
      <div className="my-2 space-y-2">
        <p className="text-xs text-destructive">
          {manifest.name} could not render this block: {parsed.error}
        </p>
        {fallback}
      </div>
    );
  }
  return (
    <section
      aria-label={`${manifest.name} plugin content`}
      className="my-2 space-y-3 rounded-2xl border border-border/70 bg-background/70 p-4"
      data-runtime-plugin={manifest.id}
    >
      <RuntimeBlocks blocks={manifest.blocks} data={parsed.data} />
    </section>
  );
}
