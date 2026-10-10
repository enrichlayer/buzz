import assert from "node:assert/strict";
import test from "node:test";
import { parseRuntimePluginManifest } from "./schema.ts";
import {
  __resetRuntimePluginStoreForTests,
  getRuntimeCodeFencePlugin,
  getRuntimePluginState,
  installRuntimePlugin,
  removeRuntimePlugin,
  RUNTIME_PLUGIN_STORAGE_KEY,
  setRuntimePluginEnabled,
  subscribeRuntimePlugins,
  updateRuntimePlugin,
} from "./store.ts";

function manifest(version = "1.0.0", id = "example.review-card") {
  const result = parseRuntimePluginManifest(
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: "Review card",
      version,
      fenceLanguage: `buzz-${id.split(".").at(-1)}`,
      contentType: "json",
      blocks: [{ type: "text", text: { path: "summary" } }],
    }),
  );
  assert.equal(result.ok, true);
  return result.manifest;
}

function storageStub() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test.beforeEach(() => {
  globalThis.localStorage = storageStub();
  __resetRuntimePluginStoreForTests();
});

test("installs, disables, explicitly updates, and removes one atomic snapshot", async () => {
  let notifications = 0;
  const unsubscribe = subscribeRuntimePlugins(() => {
    notifications += 1;
  });
  assert.deepEqual(await installRuntimePlugin(manifest()), { ok: true });
  assert.equal(getRuntimeCodeFencePlugin("buzz-review-card")?.version, "1.0.0");
  assert.equal(
    JSON.parse(globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY))
      .plugins.length,
    1,
  );
  assert.equal(
    await setRuntimePluginEnabled("example.review-card", false),
    true,
  );
  assert.equal(getRuntimeCodeFencePlugin("buzz-review-card"), undefined);
  assert.deepEqual(await updateRuntimePlugin(manifest("2.0.0")), { ok: true });
  assert.equal(getRuntimePluginState().plugins[0].manifest.version, "2.0.0");
  assert.equal(await removeRuntimePlugin("example.review-card"), true);
  assert.equal(getRuntimePluginState().plugins.length, 0);
  assert.equal(notifications, 4);
  unsubscribe();
});

test("refuses duplicate install and fence ownership", async () => {
  assert.equal((await installRuntimePlugin(manifest())).ok, true);
  assert.match(
    (await installRuntimePlugin(manifest())).error,
    /already installed/,
  );
  const other = {
    ...manifest(),
    id: "example.other-card",
  };
  assert.match((await installRuntimePlugin(other)).error, /already owned/);
});

test("surfaces corrupted storage without silently replacing it", () => {
  globalThis.localStorage.values.set(RUNTIME_PLUGIN_STORAGE_KEY, "{");
  __resetRuntimePluginStoreForTests();
  const state = getRuntimePluginState();
  assert.match(state.loadError, /Could not load saved plugins/);
  assert.equal(state.plugins.length, 0);
  assert.equal(
    globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY),
    "{",
  );
});

test("does not change live state when atomic persistence fails", async () => {
  globalThis.localStorage.setItem = () => {
    throw new Error("quota full");
  };
  assert.equal((await installRuntimePlugin(manifest())).ok, false);
  const state = getRuntimePluginState();
  assert.equal(state.plugins.length, 0);
  assert.match(state.persistenceError, /quota full/);
});

test("re-reads durable state before mutation so a delayed storage event cannot lose another window's plugin", async () => {
  assert.equal((await installRuntimePlugin(manifest())).ok, true);
  const durable = JSON.parse(
    globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY),
  );
  durable.plugins.push({
    enabled: true,
    manifest: manifest("1.0.0", "example.other-card"),
  });
  globalThis.localStorage.values.set(
    RUNTIME_PLUGIN_STORAGE_KEY,
    JSON.stringify(durable),
  );

  assert.equal(
    await setRuntimePluginEnabled("example.review-card", false),
    true,
  );
  const saved = JSON.parse(
    globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY),
  );
  assert.deepEqual(
    saved.plugins.map((entry) => entry.manifest.id),
    ["example.review-card", "example.other-card"],
  );
  assert.equal(saved.plugins[0].enabled, false);
});

test("refuses a mutation when durable data became corrupt before its storage event", async () => {
  assert.equal((await installRuntimePlugin(manifest())).ok, true);
  globalThis.localStorage.values.set(RUNTIME_PLUGIN_STORAGE_KEY, "{");

  assert.equal(
    await setRuntimePluginEnabled("example.review-card", false),
    false,
  );
  assert.equal(
    globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY),
    "{",
  );
  assert.match(
    getRuntimePluginState().loadError,
    /Could not load saved plugins/,
  );
});

test("serializes mutations through the browser lock manager when available", async () => {
  const originalNavigator = Object.getOwnPropertyDescriptor(
    globalThis,
    "navigator",
  );
  const lockNames = [];
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: async (name, operation) => {
          lockNames.push(name);
          return operation();
        },
      },
    },
  });
  try {
    assert.equal((await installRuntimePlugin(manifest())).ok, true);
    assert.deepEqual(lockNames, [RUNTIME_PLUGIN_STORAGE_KEY]);
  } finally {
    if (originalNavigator) {
      Object.defineProperty(globalThis, "navigator", originalNavigator);
    } else {
      Reflect.deleteProperty(globalThis, "navigator");
    }
  }
});

test("serializes concurrent mutations within the single-writer fallback renderer", async () => {
  const results = await Promise.all([
    installRuntimePlugin(manifest("1.0.0", "example.first-card")),
    installRuntimePlugin(manifest("1.0.0", "example.second-card")),
  ]);
  assert.deepEqual(results, [{ ok: true }, { ok: true }]);
  const saved = JSON.parse(
    globalThis.localStorage.values.get(RUNTIME_PLUGIN_STORAGE_KEY),
  );
  assert.deepEqual(
    saved.plugins.map((entry) => entry.manifest.id),
    ["example.first-card", "example.second-card"],
  );
});
