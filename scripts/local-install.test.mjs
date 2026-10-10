import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
const script = new URL("./local-install.mjs", import.meta.url);
test("setup refuses modified sources and check distinguishes unavailable/current", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "buzz-install-test-"));
  try {
    writeFileSync(
      path.join(dir, "git"),
      `#!/bin/sh\ncase "$1" in\nrev-parse) printf '%s' "$TEST_SHA";;\nstatus) printf '%s' "$TEST_DIRTY";;\nls-remote) [ "$TEST_OFFLINE" = 1 ] && exit 1; printf '%s\\trefs/heads/demo' "$TEST_REMOTE";;\nesac\n`,
      { mode: 0o755 },
    );
    const run = (command, extra = {}) =>
      spawnSync(process.execPath, [script.pathname, command], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: dir + path.delimiter + process.env.PATH,
          TEST_SHA: "a".repeat(40),
          TEST_REMOTE: "a".repeat(40),
          TEST_DIRTY: "",
          ...extra,
        },
      });
    assert.match(run("check").stdout, /Source current/);
    assert.match(
      run("check", { TEST_REMOTE: "b".repeat(40) }).stdout,
      /differs/,
    );
    assert.match(
      run("check", { TEST_DIRTY: " M file" }).stdout,
      /Modified checkout/,
    );
    assert.equal(run("check", { TEST_OFFLINE: "1" }).status, 1);
    const refused = run("start", { TEST_DIRTY: "?? work" });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Refusing modified/);
    assert.equal(run("unknown").status, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
