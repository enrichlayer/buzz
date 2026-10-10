import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppBuildVersion } from "./app-build-version.tsx";

test("renders binary build metadata and opens this fork's exact commit", async () => {
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push([command, args]);
      if (command === "get_app_build_info")
        return {
          version: "0.5.27",
          buildNumber: "1790000000001",
          revision: "a".repeat(40),
          sourceState: "modified",
          repository: "https://github.com/enrichlayer/buzz",
        };
    },
  };
  const client = new QueryClient();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(AppBuildVersion),
        ),
      );
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.match(host.textContent, /v0.5.27 · build 1790000000001/);
    assert.match(host.textContent, /enrichlayer\/buzz · aaaaaaa · modified/);
    await act(async () => host.querySelector("button").click());
    assert.ok(
      calls.some(
        ([name, args]) =>
          name === "plugin:opener|open_url" &&
          args.url ===
            `https://github.com/enrichlayer/buzz/commit/${"a".repeat(40)}`,
      ),
    );
  } finally {
    await act(async () => root.unmount());
    client.clear();
    host.remove();
    delete window.__TAURI_INTERNALS__;
  }
});

test("unavailable native metadata is explicit and does not invent a version", async () => {
  window.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw new Error("Unavailable");
    },
  };
  const client = new QueryClient();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(
          QueryClientProvider,
          { client },
          React.createElement(AppBuildVersion),
        ),
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    assert.equal(host.textContent, "Build unavailable");
    assert.equal(host.querySelector("button"), null);
  } finally {
    await act(async () => root.unmount());
    client.clear();
    delete window.__TAURI_INTERNALS__;
  }
});
