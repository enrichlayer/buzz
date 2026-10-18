import assert from "node:assert/strict";
import test from "node:test";
import {
  canHighlightCode,
  resolveCodeLanguage,
  languageForCodePath,
} from "./codeLanguage.ts";

test("normalizes bundled language names and aliases", () => {
  for (const [label, expected] of [
    ["TypeScript", "typescript"],
    [" TS ", "typescript"],
    ["JS", "javascript"],
    ["py", "python"],
    ["BASH", "shellscript"],
  ]) {
    assert.equal(resolveCodeLanguage("", label), expected);
  }
});
test("infers distinctive unlabelled snippets", () => {
  for (const [source, expected] of [
    ['{"value": 42}', "json"],
    ['[1, "two"]', "json"],
    ['def greet(name):\n    return "Hello, " + name', "python"],
    ['#!/usr/bin/env python3\nprint("hello")', "python"],
    ['#!/bin/bash\necho "hello"', "shellscript"],
    ['const greeting: string = "hello";', "typescript"],
    ['const greeting = "hello";', "javascript"],
  ])
    assert.equal(resolveCodeLanguage(source), expected);
});
test("preserves explicit plaintext, unsupported labels, prose and incomplete data", () => {
  for (const label of [
    "text",
    "TXT",
    "plain",
    "plaintext",
    "unknown-language",
  ]) {
    assert.equal(resolveCodeLanguage('{"value": 42}', label), "");
  }
  for (const source of [
    "ordinary text",
    "{ incomplete",
    "[one, two]",
    "",
    "Review const greeting = hello",
  ])
    assert.equal(resolveCodeLanguage(source), "");
});
test("bounds tokenization by characters and lines without disabling normal long snippets", () => {
  assert.equal(canHighlightCode("const x = 1;\n".repeat(160)), true);
  assert.equal(canHighlightCode("x".repeat(50_000)), true);
  assert.equal(canHighlightCode("x".repeat(50_001)), false);
  assert.equal(canHighlightCode(Array(1_000).fill("x").join("\n")), true);
  assert.equal(canHighlightCode(Array(1_001).fill("x").join("\n")), false);
});

test("file previews resolve paths and bundled grammar aliases", () => {
  for (const [path, expected] of [
    ["src/app.tsx", "tsx"],
    ["settings.jsonc", "jsonc"],
    ["src/App.vue", "vue"],
    ["Dockerfile", "dockerfile"],
    ["build.cjs", "javascript"],
    ["file.unknown", undefined],
  ]) {
    assert.equal(languageForCodePath(path), expected);
  }
});
