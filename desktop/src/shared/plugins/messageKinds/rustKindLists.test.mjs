import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { PLUGIN_TIMELINE_KINDS } from "./policies";

// The Tauri commands that fetch timeline events keep their own kind lists in
// Rust. A plugin kind missing from one of them arrives live but disappears on
// reload, so every list below must carry every plugin kind. The reconnect
// repair list is already pinned to the live channel filter (which includes
// plugin kinds) by relayReconnectReplay.test.mjs.
const TAURI_SRC = new URL("../../../../src-tauri/src/", import.meta.url);
const CORE_KINDS = new URL(
  "../../../../../crates/buzz-core/src/kind.rs",
  import.meta.url,
);

const RUST_KIND_LISTS = [
  ["commands/channel_window.rs", "TIMELINE_KINDS"],
  ["commands/messages.rs", "TIMELINE_KINDS"],
  ["commands/messages/event_batch.rs", "GET_EVENT_KINDS"],
];

const coreKindValues = new Map(
  [
    ...readFileSync(CORE_KINDS, "utf8").matchAll(
      /pub const (KIND_\w+): u32 = (\d+);/g,
    ),
  ].map(([, name, value]) => [name, Number(value)]),
);

function readRustKindList(file, constName) {
  const source = readFileSync(new URL(file, TAURI_SRC), "utf8");
  const match = source.match(
    new RegExp(`const ${constName}: \\[u32; \\d+\\] = \\[([^\\]]*)\\]`),
  );
  assert.ok(match, `${constName} not found in ${file}`);
  return match[1]
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      if (/^\d+$/.test(entry)) return Number(entry);
      const name = entry.split("::").at(-1);
      const value = coreKindValues.get(name);
      assert.ok(value !== undefined, `unknown kind ${entry} in ${file}`);
      return value;
    });
}

for (const [file, constName] of RUST_KIND_LISTS) {
  test(`${file} ${constName} includes every plugin kind`, () => {
    const kinds = readRustKindList(file, constName);
    for (const kind of PLUGIN_TIMELINE_KINDS) {
      assert.ok(
        kinds.includes(kind),
        `add plugin kind ${kind} to ${constName} in src-tauri/src/${file}`,
      );
    }
  });
}
