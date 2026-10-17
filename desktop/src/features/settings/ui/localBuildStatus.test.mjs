import assert from "node:assert/strict";
import { test } from "node:test";
import { compareDemoBuild, checkDemoBuild } from "./localBuildStatus.ts";
const info = {
  repository: "https://github.com/enrichlayer/buzz",
  revision: "a".repeat(40),
  sourceState: "clean",
};
test("only clean exact repository and revision can report current", () => {
  assert.match(compareDemoBuild(info, "a".repeat(40)), /^Current/);
  assert.match(compareDemoBuild(info, "b".repeat(40)), /^Different/);
  for (const sourceState of ["modified", "unknown"])
    assert.doesNotMatch(
      compareDemoBuild({ ...info, sourceState }, info.revision),
      /^Current/,
    );
  assert.match(
    compareDemoBuild(
      { ...info, repository: "https://github.com/block/buzz" },
      info.revision,
    ),
    /^Different distribution/,
  );
  for (const sha of [null, "", "latest", "a".repeat(7)])
    assert.match(compareDemoBuild(info, sha), /^Unable/);
});
test("network and authentication failures never report current", async () => {
  await assert.rejects(
    checkDemoBuild(info, async () => ({ ok: false, status: 403 })),
    /HTTP 403/,
  );
  await assert.rejects(
    checkDemoBuild(info, async () => {
      throw new Error("offline");
    }),
    /offline/,
  );
  assert.match(
    await checkDemoBuild(info, async () => ({
      ok: true,
      json: async () => ({ sha: info.revision }),
    })),
    /^Current/,
  );
});
