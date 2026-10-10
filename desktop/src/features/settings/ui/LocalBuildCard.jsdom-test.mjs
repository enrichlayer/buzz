import assert from "node:assert/strict";
import { test } from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { LocalBuildCard } from "./LocalBuildCard.tsx";
import { DemoPluginChecklist } from "./DemoPluginChecklist.tsx";
test("older native binary visibly reports unavailable and cannot claim latest", async () => {
  window.__TAURI_INTERNALS__ = {
    invoke: async () => {
      throw new Error("unknown command");
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => {
      root.render(React.createElement(LocalBuildCard));
    });
    assert.match(host.textContent, /Build identity unavailable/);
    assert.equal(
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "Check demo channel",
      ).disabled,
      true,
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete window.__TAURI_INTERNALS__;
  }
});
test("installed metadata and native copy work alongside plugin requirements", async () => {
  const calls = [];
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      return {
        version: "0.5.26",
        buildNumber: "123",
        revision: "a".repeat(40),
        repository: "https://github.com/enrichlayer/buzz",
        sourceState: "clean",
        builtAtMs: "1791580000000",
      };
    },
  };
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(LocalBuildCard),
          React.createElement(DemoPluginChecklist),
        ),
      ),
    );
    assert.match(host.textContent, /v0.5.26 · build 123/);
    assert.match(host.textContent, /Not checked/);
    await act(async () => {
      [...host.querySelectorAll("button")]
        .find((b) => b.textContent === "Copy build info")
        .click();
    });
    assert.match(host.textContent, /Build info copied/);
    const copied = calls.find(
      (call) => call.command === "copy_text_to_clipboard",
    );
    assert.equal(JSON.parse(copied.args.text).revision, "a".repeat(40));
    assert.match(host.textContent, /Review card: Missing/);
    assert.match(host.textContent, /Runbook: Missing/);
    assert.equal(
      [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "Copy build info",
      ).disabled,
      false,
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    delete window.__TAURI_INTERNALS__;
  }
});
