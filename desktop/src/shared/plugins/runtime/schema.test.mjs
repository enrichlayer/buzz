import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RUNTIME_CONTENT_BYTES,
  parseRuntimePluginManifest,
  validateRuntimeContentData,
} from "./schema.ts";
import {
  parseRuntimePluginContent,
  resolveRuntimeTemplate,
  resolveRuntimeValue,
} from "./renderData.ts";

const validManifest = {
  schemaVersion: 1,
  id: "example.review-card",
  name: "Review card",
  version: "1.2.3",
  fenceLanguage: "buzz-review-card",
  contentType: "json",
  blocks: [
    { type: "heading", text: { path: "title" } },
    {
      type: "form",
      id: "reply",
      fields: [{ id: "note", label: "Note", type: "textarea" }],
      submit: {
        kind: "compose",
        label: "Reply",
        template: "{{data.title}}: {{form.note}}",
      },
    },
  ],
};

test("validates a bounded declarative manifest", () => {
  const result = parseRuntimePluginManifest(JSON.stringify(validManifest));
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.manifest.blocks.length, 2);
});

test("rejects executable-looking or non-namespaced plugin contracts by shape", () => {
  for (const patch of [
    { version: "latest" },
    { fenceLanguage: "mermaid" },
    { fenceLanguage: "review" },
    { id: "review" },
    { blocks: [{ type: "script", source: "alert(1)" }] },
  ]) {
    const result = parseRuntimePluginManifest(
      JSON.stringify({ ...validManifest, ...patch }),
    );
    assert.equal(result.ok, false, JSON.stringify(patch));
  }
});

test("bounds schema depth and content size", () => {
  let block = { type: "text", text: "leaf" };
  for (let index = 0; index < 9; index += 1) {
    block = { type: "accordion", title: "level", children: [block] };
  }
  const deep = parseRuntimePluginManifest(
    JSON.stringify({ ...validManifest, blocks: [block] }),
  );
  assert.equal(deep.ok, false);
  assert.match(deep.ok ? "" : deep.error, /depth/);

  const parsed = parseRuntimePluginManifest(JSON.stringify(validManifest));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const content = parseRuntimePluginContent(
    parsed.manifest,
    `"${"x".repeat(MAX_RUNTIME_CONTENT_BYTES)}"`,
  );
  assert.equal(content.ok, false);
  assert.match(content.ok ? "" : content.error, /exceeds/);
});

test("resolves only own-property data paths and bounded templates", () => {
  const data = { title: "Review", nested: { count: 3 } };
  assert.equal(resolveRuntimeValue({ path: "nested.count" }, data), "3");
  assert.equal(
    resolveRuntimeValue({ path: "missing", fallback: "none" }, data),
    "none",
  );
  assert.equal(
    resolveRuntimeTemplate("{{data.title}}: {{form.note}}", data, {
      note: "ship it",
    }),
    "Review: ship it",
  );
  assert.equal(
    resolveRuntimeValue({ path: "constructor.name", fallback: "safe" }, data),
    "safe",
  );
});

test("rejects overly deep runtime data", () => {
  let data = { value: "leaf" };
  for (let index = 0; index < 18; index += 1) data = { child: data };
  assert.match(validateRuntimeContentData(data) ?? "", /depth/);
});
