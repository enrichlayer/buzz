import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { render, cleanup, waitFor } from "@testing-library/react";
import { Hunk, parseDiff } from "react-diff-view";
import { CodeText } from "./CodeText.tsx";
import { SyntaxDiff } from "./SyntaxDiff.tsx";
import { FileContentBlock } from "@/features/agents/ui/FileContentBlock.tsx";
import { ShellCommandBlock } from "@/features/agents/ui/AgentSessionToolItem/ShellCommandBlock.tsx";
import { ToolDetailBlocks } from "@/features/agents/ui/AgentSessionToolItem/ToolDetailBlocks.tsx";
import { RawEventRail } from "@/features/agents/ui/RawEventRail.tsx";

const h = React.createElement;
async function highlighted(element) {
  await waitFor(
    () => assert.ok(element.querySelectorAll("span[style]").length > 1),
    { timeout: 5000 },
  );
  assert.ok(
    new Set(
      [...element.querySelectorAll("span[style]")].map(
        (token) => token.style.color,
      ),
    ).size > 1,
  );
}

test.afterEach(cleanup);

test("code text preserves whitespace and escapes markup as literal source", async () => {
  const code = 'const html = "<img src=x onerror=alert(1)>";\n\n// end\n';
  const view = render(h("pre", null, h(CodeText, { code, language: "JS" })));
  await highlighted(view.container);
  assert.equal(view.container.textContent, code);
  assert.equal(view.container.querySelector("img"), null);
});

test("file read and edit blocks highlight the path language and preserve diff decoration", async () => {
  const lines = [
    { kind: "remove", text: 'const value: string = "before";' },
    { kind: "add", text: 'const value: string = "after";' },
    { kind: "context", text: "" },
  ];
  const view = render(h(FileContentBlock, { lines, path: "src/value.ts" }));
  await highlighted(view.container);
  assert.ok(view.container.querySelector('[class*="border-green"]'));
  assert.ok(view.container.querySelector('[class*="border-red"]'));
  assert.equal(
    view.container.querySelector("pre").textContent,
    lines.map((line) => line.text || " ").join(""),
  );
});

test("shell commands, JSON tool results and raw event payloads use syntax colors", async () => {
  const shell = render(
    h(ShellCommandBlock, {
      command: 'echo "$HOME"',
      result: "ordinary output",
    }),
  );
  await highlighted(shell.container);
  assert.ok(shell.container.textContent.includes('echo "$HOME"'));
  cleanup();
  const tool = render(
    h(ToolDetailBlocks, {
      args: { value: 42 },
      fileEditDiff: null,
      fileReadContent: null,
      hasArgs: true,
      hasResult: true,
      imagePreview: null,
      isError: false,
      result: '{"ok": true}',
      shellCommand: null,
    }),
  );
  for (const pre of tool.container.querySelectorAll("pre"))
    await highlighted(pre);
  cleanup();
  const raw = render(
    h(RawEventRail, {
      events: [
        {
          seq: 1,
          kind: "acp",
          sessionId: "test",
          channelId: "test",
          timestamp: "2026-10-12T00:00:00Z",
          payload: { value: 42 },
        },
      ],
    }),
  );
  await highlighted(raw.container);
});

test("diffs retain source line numbers while highlighting both sides", async () => {
  const [file] = parseDiff(
    'diff --git a/test.ts b/test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -200,2 +200,2 @@\n-const value = "before";\n+const value = "after";\n const count = 42;\n',
  );
  const view = render(
    h(SyntaxDiff, {
      path: "test.ts",
      hunks: file.hunks,
      diffType: "modify",
      children: (hunks) =>
        hunks.map((hunk) => h(Hunk, { key: hunk.content, hunk })),
    }),
  );
  await highlighted(view.container);
  assert.ok(view.container.textContent.includes("200"));
  assert.ok(view.container.textContent.includes('const value = "before";'));
  assert.ok(view.container.textContent.includes('const value = "after";'));
  assert.ok(view.container.querySelector(".diff-code-delete span[style]"));
  assert.ok(view.container.querySelector(".diff-code-insert span[style]"));
});
