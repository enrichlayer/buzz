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

test("an enabled duplicate for the same fence is reported over a disabled one", () => {
  const manifest = {
    schemaVersion: 1,
    id: "example.review-card",
    version: "1.0.0",
    fenceLanguage: "buzz-review-card",
  };
  const disabled = { manifest, enabled: false };
  const enabled = { manifest: { ...manifest }, enabled: true };
  assert.equal(
    demoPluginStatus("buzz-review-card", [disabled, enabled]),
    "Ready",
  );
  assert.equal(
    demoPluginStatus("buzz-review-card", [disabled, { ...disabled }]),
    "Disabled",
  );
});

test("installed theme plugins never satisfy or shadow a demo fence", () => {
  const theme = {
    enabled: true,
    manifest: {
      schemaVersion: 2,
      kind: "theme",
      id: "example.review-card",
      name: "Theme",
      version: "1.0.0",
      themes: [],
    },
  };
  assert.equal(demoPluginStatus("buzz-review-card", [theme]), "Missing");
  const content = {
    enabled: true,
    manifest: {
      schemaVersion: 1,
      id: "example.review-card",
      version: "1.0.0",
      fenceLanguage: "buzz-review-card",
    },
  };
  assert.equal(demoPluginStatus("buzz-review-card", [theme, content]), "Ready");
});
