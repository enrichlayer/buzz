import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider, useTheme } from "./ThemeProvider.tsx";
import {
  __resetRuntimePluginStoreForTests,
  installRuntimePlugin,
  updateRuntimePlugin,
  removeRuntimePlugin,
  setRuntimePluginEnabled,
} from "../plugins/runtime/store.ts";
import { parseCommunityThemePreference } from "./communityThemePreference.ts";

const manifest = JSON.parse(
  readFileSync(
    new URL("../../../public/plugins/el-buzz.json", import.meta.url),
    "utf8",
  ),
);
const selection = "plugin:enrichlayer.el-buzz:dark";
window.matchMedia = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

async function settle(predicate) {
  for (let i = 0; i < 100; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    if (predicate()) return;
  }
  assert.fail("theme did not settle");
}

test("provider fences rapid updates and releases every override on disable and removal", async () => {
  localStorage.clear();
  __resetRuntimePluginStoreForTests();
  document.documentElement.removeAttribute("style");
  await installRuntimePlugin(manifest);
  localStorage.setItem("buzz-theme", selection);
  localStorage.setItem("buzz-follow-system", "false");
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let theme;
  function Probe() {
    theme = useTheme();
    return null;
  }
  const bg = () =>
    document.documentElement.style.getPropertyValue("--background");
  try {
    await act(async () =>
      root.render(
        React.createElement(ThemeProvider, null, React.createElement(Probe)),
      ),
    );
    await settle(() => !theme.isLoading);
    assert.equal(bg(), "0 0% 15.7%");
    const originalSecondary =
      document.documentElement.style.getPropertyValue("--secondary");
    const updated = structuredClone(manifest);
    updated.version = "1.1.0";
    updated.themes[0].colors.background = "#202020";
    delete updated.themes[0].colors.secondary;
    await act(async () => {
      await updateRuntimePlugin(updated);
    });
    await settle(() => !theme.isLoading && bg() === "0 0% 12.5%");
    assert.notEqual(
      document.documentElement.style.getPropertyValue("--secondary"),
      originalSecondary,
    );
    // Change a package while the provider's asynchronous load is in flight.
    await act(async () => {
      await updateRuntimePlugin(manifest);
      await setRuntimePluginEnabled(manifest.id, false);
    });
    await settle(() => theme.themeName === "buzz-dark" && !theme.isLoading);
    assert.equal(
      document.documentElement.getAttribute("data-buzz-theme"),
      "buzz-dark",
    );
    assert.equal(theme.selectedThemeName, selection);
    assert.equal(theme.unavailableTheme, selection);
    assert.notEqual(bg(), "0 0% 15.7%");
    await act(async () => {
      await setRuntimePluginEnabled(manifest.id, true);
    });
    await settle(() => theme.themeName === selection && !theme.isLoading);
    assert.equal(bg(), "0 0% 15.7%");
    // Community application is a separate path and must also select the safe fallback.
    await act(async () =>
      theme.applyAppearance({
        theme: "plugin:example.missing:dark",
        accent: "#3b82f6",
        followSystem: false,
      }),
    );
    await settle(() => theme.themeName === "buzz-dark" && !theme.isLoading);
    await act(async () =>
      theme.applyAppearance({
        theme: selection,
        accent: "#3b82f6",
        followSystem: false,
      }),
    );
    await settle(() => theme.themeName === selection && !theme.isLoading);
    await act(async () => {
      await removeRuntimePlugin(manifest.id);
    });
    await settle(() => theme.themeName === "buzz-dark" && !theme.isLoading);
    assert.notEqual(bg(), "0 0% 15.7%");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

test("community preferences preserve unavailable namespaced themes and migrate the initial built-in", () => {
  const preference = {
    version: 1,
    theme: selection,
    accent: "#3b82f6",
    followSystem: false,
  };
  assert.deepEqual(parseCommunityThemePreference(preference), preference);
  assert.equal(
    parseCommunityThemePreference({ ...preference, theme: "el-buzz" }).theme,
    selection,
  );
  assert.equal(
    parseCommunityThemePreference({
      ...preference,
      theme: "plugin:__proto__:dark",
    }),
    null,
  );
});

test("distribution default selects el-buzz on a fresh profile even when the OS is light", async () => {
  localStorage.clear();
  __resetRuntimePluginStoreForTests();
  await installRuntimePlugin(manifest);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let theme;
  function Probe() {
    theme = useTheme();
    return null;
  }
  try {
    await act(async () =>
      root.render(
        React.createElement(
          ThemeProvider,
          { defaultTheme: selection },
          React.createElement(Probe),
        ),
      ),
    );
    await settle(() => theme && !theme.isLoading);
    assert.equal(theme.themeName, selection);
    assert.equal(theme.followSystem, false);
    assert.equal(
      document.documentElement.style.getPropertyValue("--background"),
      "0 0% 15.7%",
    );
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
