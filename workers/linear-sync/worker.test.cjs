const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { loadConfig } = require("./config.cjs");

test("worker requires explicit isolated source, destination, storage and credentials", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "buzz-linear-worker-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "config.json");
  const config = {
    profile: "acme",
    workspace: "acme",
    projectId: "11111111-1111-4111-8111-111111111111",
    channel: "22222222-2222-4222-8222-222222222222",
    signer: "a".repeat(64),
    relay: "https://relay.test",
    directory: dir,
  };
  const env = {
    BUZZ_LINEAR_CONFIG_FILE: file,
    LINEAR_API_TOKEN: "synthetic",
    BUZZ_PRIVATE_KEY: "synthetic",
    TEMPORAL_ADDRESS: "localhost:7233",
    TEMPORAL_NAMESPACE: "default",
    TASK_QUEUE: "buzz-linear-test",
  };
  writeFileSync(file, JSON.stringify(config));
  assert.equal(loadConfig(env).maxRecords, 250);
  for (const key of [
    "LINEAR_API_TOKEN",
    "BUZZ_PRIVATE_KEY",
    "TASK_QUEUE",
    "TEMPORAL_NAMESPACE",
    "TEMPORAL_ADDRESS",
  ]) {
    assert.throws(() => loadConfig({ ...env, [key]: "" }));
  }
  for (const invalid of [
    { relay: "http://relay.test" },
    { directory: "relative" },
    { maxRecords: 251 },
    { secret: "never store credentials here" },
  ]) {
    writeFileSync(file, JSON.stringify({ ...config, ...invalid }));
    assert.throws(() => loadConfig(env));
  }
  writeFileSync(file, "x".repeat(16385));
  assert.throws(() => loadConfig(env), /16 KiB/);
});
