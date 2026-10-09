import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

const script = new URL(
  "./build-enrichlayer-release-config.mjs",
  import.meta.url,
);
const endpoint =
  "https://github.com/enrichlayer/buzz/releases/download/buzz-desktop-latest/latest.json";
function run(overrides, check) {
  const cwd = mkdtempSync(resolve(tmpdir(), "buzz-fork-config-"));
  mkdirSync(resolve(cwd, "src-tauri"));
  try {
    const result = spawnSync(process.execPath, [script.pathname], {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        BUZZ_UPDATER_PUBLIC_KEY: "test-public-key",
        BUZZ_UPDATER_ENDPOINT: endpoint,
        APPLE_SIGNING_IDENTITY: "Developer ID Application: Test (TEST)",
        ...overrides,
      },
    });
    check(result, cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
test("fork release uses its own feed, identity, and signed updater artifacts", () => {
  run({}, (result, cwd) => {
    assert.equal(result.status, 0, result.stderr);
    const config = JSON.parse(
      readFileSync(resolve(cwd, "src-tauri/tauri.release.conf.json"), "utf8"),
    );
    assert.equal(config.identifier, "com.enrichlayer.buzz");
    assert.deepEqual(config.plugins.updater.endpoints, [endpoint]);
    assert.equal(config.bundle.createUpdaterArtifacts, true);
    assert.equal(
      config.bundle.macOS.signingIdentity,
      "Developer ID Application: Test (TEST)",
    );
    assert.equal(Object.hasOwn(config.bundle, "externalBin"), false);
  });
});
for (const [name, overrides] of Object.entries({
  "upstream feed": {
    BUZZ_UPDATER_ENDPOINT:
      "https://github.com/block/buzz/releases/download/buzz-desktop-latest/latest.json",
  },
  "missing public key": { BUZZ_UPDATER_PUBLIC_KEY: "" },
  "ad hoc signing": { APPLE_SIGNING_IDENTITY: "-" },
}))
  test(`rejects ${name}`, () =>
    run(overrides, (result) => assert.notEqual(result.status, 0)));
