import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseRuntimePluginManifest } from "./schema.ts";
import {
  __resetRuntimePluginStoreForTests,
  installRuntimePlugin,
  initializeBundledRuntimePlugin,
  updateRuntimePlugin,
  setRuntimePluginEnabled,
  removeRuntimePlugin,
  getRuntimePluginState,
  getRuntimeCodeFencePlugin,
} from "./store.ts";
import {
  getPluginTheme,
  applyPluginThemeColors,
} from "../../theme/plugin-themes.ts";
import {
  loadThemeData,
  resolveShikiThemeName,
  isAvailableTheme,
  getThemeNames,
} from "../../theme/theme-loader.ts";
import { isPluginThemeName } from "./themeSchema.ts";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../../public/plugins/el-buzz.json", import.meta.url),
    "utf8",
  ),
);
const selection = "plugin:enrichlayer.el-buzz:dark";
function parse(value) {
  return parseRuntimePluginManifest(JSON.stringify(value));
}
function reset() {
  const data = new Map();
  globalThis.localStorage = {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };
  __resetRuntimePluginStoreForTests();
}

test("theme manifest accepts the generated package and rejects executable, malformed or oversized contributions", () => {
  assert.equal(parse(manifest).ok, true);
  for (const color of [
    "url(https://example.com)",
    "var(--x)",
    "red",
    "#fff",
    "#12345678",
    {},
    "#ffffff;display:none",
  ]) {
    const value = structuredClone(manifest);
    value.themes[0].colors.background = color;
    assert.equal(parse(value).ok, false, String(color));
  }
  for (const key of [
    "display",
    "font-size",
    "__proto__",
    "background-image",
    "--background",
  ]) {
    const value = structuredClone(manifest);
    Object.defineProperty(value.themes[0].colors, key, {
      value: "#ffffff",
      enumerable: true,
    });
    assert.equal(parse(value).ok, false, key);
  }
  for (const themes of [
    [],
    Array(9).fill(manifest.themes[0]),
    [manifest.themes[0], manifest.themes[0]],
  ]) {
    assert.equal(parse({ ...manifest, themes }).ok, false);
  }
  const missing = structuredClone(manifest);
  delete missing.themes[0].colors.primary;
  assert.equal(parse(missing).ok, false);
  for (const syntaxTheme of [
    "plugin:other.theme:dark",
    "unknown",
    "github-light",
  ]) {
    assert.equal(
      parse({ ...manifest, themes: [{ ...manifest.themes[0], syntaxTheme }] })
        .ok,
      false,
    );
  }
  assert.equal(isPluginThemeName(selection), true);
  assert.equal(isPluginThemeName("plugin:__proto__:dark"), false);
});

test("theme store installation, update, disable, restart and removal drive the production catalog", async () => {
  reset();
  assert.equal(isAvailableTheme(selection), false);
  assert.deepEqual(await installRuntimePlugin(manifest), { ok: true });
  assert.ok(getThemeNames().includes(selection));
  assert.equal(getRuntimeCodeFencePlugin("undefined"), undefined);
  assert.equal(resolveShikiThemeName(selection), "github-dark");
  assert.equal(
    (await loadThemeData(selection)).colors["editor.background"],
    manifest.themes[0].colors.background,
  );
  const updated = structuredClone(manifest);
  updated.version = "1.1.0";
  updated.themes[0].colors.background = "#222222";
  delete updated.themes[0].colors.secondary;
  assert.deepEqual(await updateRuntimePlugin(updated), { ok: true });
  assert.equal(getPluginTheme(selection).colors.background, "#222222");
  const vars = applyPluginThemeColors(selection, {
    "--secondary": "base",
    "--background": "base",
  });
  assert.equal(
    vars["--secondary"],
    "base",
    "deleted token must restore the fresh base",
  );
  assert.notEqual(vars["--background"], "base");
  __resetRuntimePluginStoreForTests();
  assert.equal(getPluginTheme(selection).colors.background, "#222222");
  assert.equal(await setRuntimePluginEnabled(manifest.id, false), true);
  assert.equal(isAvailableTheme(selection), false);
  assert.equal(resolveShikiThemeName(selection), "github-dark");
  assert.equal(await setRuntimePluginEnabled(manifest.id, true), true);
  assert.equal(isAvailableTheme(selection), true);
  assert.equal(await removeRuntimePlugin(manifest.id), true);
  assert.equal(isAvailableTheme(selection), false);
});

test("theme and renderer coexist; failed persistence preserves the last durable theme", async () => {
  reset();
  assert.deepEqual(await installRuntimePlugin(manifest), { ok: true });
  const other = { ...manifest, id: "example.other-theme" };
  assert.deepEqual(await installRuntimePlugin(other), { ok: true });
  const renderer = {
    schemaVersion: 1,
    id: "example.card",
    name: "Card",
    version: "1.0.0",
    fenceLanguage: "buzz-card",
    blocks: [{ type: "text", text: "hello" }],
  };
  assert.deepEqual(await installRuntimePlugin(renderer), { ok: true });
  assert.equal(getRuntimeCodeFencePlugin("buzz-card").id, "example.card");
  globalThis.localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert.equal(await setRuntimePluginEnabled(manifest.id, false), false);
  assert.equal(await removeRuntimePlugin(manifest.id), false);
  assert.equal(
    (await updateRuntimePlugin({ ...manifest, version: "2.0.0" })).ok,
    false,
  );
  assert.equal(getPluginTheme(selection).name, "el-buzz");
  assert.match(getRuntimePluginState().persistenceError, /quota/);
});

test("bundled theme initializes once and preserves disable, uninstall, and failed-write retry", async () => {
  reset();
  assert.equal((await initializeBundledRuntimePlugin(manifest)).ok, true);
  assert.equal(getPluginTheme(selection)?.name, manifest.themes[0].name);
  await setRuntimePluginEnabled(manifest.id, false);
  await initializeBundledRuntimePlugin(manifest);
  assert.equal(getRuntimePluginState().plugins[0].enabled, false);
  await removeRuntimePlugin(manifest.id);
  await initializeBundledRuntimePlugin(manifest);
  assert.equal(getRuntimePluginState().plugins.length, 0);
  reset();
  const write = localStorage.setItem;
  localStorage.setItem = () => {
    throw new Error("quota");
  };
  assert.equal((await initializeBundledRuntimePlugin(manifest)).ok, false);
  assert.match(getRuntimePluginState().persistenceError, /quota/);
  localStorage.setItem = write;
  assert.equal((await initializeBundledRuntimePlugin(manifest)).ok, true);
});
