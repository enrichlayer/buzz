import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { DEMO_PLUGINS, demoPluginStatus } from "./demoCompatibility.ts";
import { parseRuntimePluginManifest } from "./schema.ts";
test("bundled plugin manifests parse and meet demo contract", () => {
  const names = [
    "review-card",
    "feedback-card",
    "runbook",
    "session-demo-card",
  ];
  for (const [i, name] of names.entries()) {
    const result = parseRuntimePluginManifest(
      readFileSync(
        new URL(
          `../../../../../docs/examples/runtime-plugins/${name}.json`,
          import.meta.url,
        ),
        "utf8",
      ),
    );
    assert.equal(result.ok, true, result.error);
    const entry = { manifest: result.manifest, enabled: true };
    const fence = DEMO_PLUGINS[i].fence;
    assert.equal(demoPluginStatus(fence, [entry]), "Ready");
    assert.equal(demoPluginStatus(fence, []), "Missing");
    assert.equal(
      demoPluginStatus(fence, [{ ...entry, enabled: false }]),
      "Disabled",
    );
    for (const version of ["0.9.0", "2.0.0", "1.0.0-beta", "bad"])
      assert.match(
        demoPluginStatus(fence, [
          { ...entry, manifest: { ...entry.manifest, version } },
        ]),
        /^Incompatible/,
      );
    assert.match(
      demoPluginStatus(fence, [
        { ...entry, manifest: { ...entry.manifest, id: "different" } },
      ]),
      /^Different/,
    );
  }
});
