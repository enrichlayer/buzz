import assert from "node:assert/strict";
import test from "node:test";
import { diffRows, splitDiffRows, searchDiff } from "./projectDiffRows.ts";
const file = {
  path: "a.ts",
  patch:
    "diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -2,3 +2,2 @@\n--- removed text\n-old second\n+++ added text\n context\n\\ No newline at end of file\n@@ -20 +19 @@\n-tail\n+TAIL\n",
  additions: 2,
  deletions: 3,
  truncated: false,
};
test("hunk body header-like code and no-newline markers preserve anchors", () => {
  const rows = diffRows(file);
  assert.equal(rows[1].content, "-- removed text");
  assert.equal(rows[1].oldLine, 2);
  assert.equal(rows[3].newLine, 2);
  assert.equal(rows[5].type, "meta");
  assert.equal(rows[5].oldLine, null);
  assert.equal(rows.at(-1).newLine, 19);
});
test("split replacements align unequal blocks without consuming context", () => {
  const pairs = splitDiffRows(diffRows(file));
  assert.equal(pairs[1].old.oldLine, 2);
  assert.equal(pairs[1].next.newLine, 2);
  assert.equal(pairs[2].old.oldLine, 3);
  assert.equal(pairs[2].next, null);
  assert.equal(pairs[3].old.content, "context");
  assert.equal(pairs[3].next.content, "context");
});
test("literal case-insensitive search navigates loaded source lines across files", () => {
  assert.deepEqual(
    searchDiff([file, { ...file, path: "b.ts" }], "tail").map((m) => [
      m.path,
      m.side,
      m.line,
    ]),
    [
      ["a.ts", "old", 20],
      ["a.ts", "new", 19],
      ["b.ts", "old", 20],
      ["b.ts", "new", 19],
    ],
  );
  assert.equal(searchDiff([file], "@@").length, 0);
  assert.equal(searchDiff([file], "").length, 0);
  assert.equal(searchDiff([file], "[").length, 0);
});
test("binary metadata produces no invented lines", () => {
  assert.deepEqual(
    diffRows({
      ...file,
      patch: "Binary files a/logo.png and b/logo.png differ\n",
    }),
    [],
  );
});
