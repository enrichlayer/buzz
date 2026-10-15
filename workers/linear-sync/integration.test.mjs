import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runLinearSyncOnce } from "../../scripts/linear-sync.mjs";
import { PROJECT_QUERY } from "../../scripts/linear-project-snapshot.mjs";

const execute = promisify(execFile);
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const signer =
  "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const page = (nodes) => ({
  nodes,
  pageInfo: { hasNextPage: false, endCursor: null },
});
const timestamp = "2026-10-15T00:00:00Z";

async function fixture(t, actualSigner = false) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-linear-orchestration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = {
    directory,
    profile: "test",
    workspace: "acme",
    projectId: id(3),
    relay: "https://relay.invalid",
    channel: id(1),
    signer,
    binary: process.env.BUZZ_LINEAR_TEST_BINARY ?? "synthetic-buzz",
  };
  const state = {
    failSource: false,
    loseAck: false,
    signed: [],
    published: [],
  };
  const query = async (document) => {
    if (state.failSource)
      throw new Error("private source content must never reach health");
    return document === PROJECT_QUERY
      ? {
          viewer: { organization: { id: id(2), urlKey: "acme" } },
          project: {
            id: id(3),
            name: "Tools",
            updatedAt: timestamp,
            teams: page([]),
            projectMilestones: page([]),
          },
        }
      : {
          project: {
            id: id(3),
            issues: page([
              {
                id: id(4),
                identifier: "DEV-1",
                title: "Synthetic task",
                updatedAt: timestamp,
                project: { id: id(3) },
                labels: page([]),
                relations: page([]),
                inverseRelations: page([]),
              },
            ]),
          },
        };
  };
  const run = async (binary, args, options) => {
    const path =
      args[
        args.indexOf(
          args[1] === "sign-record" ? "--record-file" : "--event-file",
        ) + 1
      ];
    const raw = await readFile(path, "utf8");
    if (args[1] === "sign-record") {
      assert.equal(
        raw,
        JSON.stringify(JSON.parse(raw)),
        "production file must contain exact canonical signing bytes",
      );
      const result = actualSigner
        ? await execute(binary, args, {
            ...options,
            env: {
              ...options.env,
              // Isolated, synthetic signing only. No relay request or desktop identity.
              BUZZ_PRIVATE_KEY: "1".padStart(64, "0"),
              BUZZ_AUTH_TAG: "",
            },
          })
        : {
            stdout: JSON.stringify({
              content: raw,
              pubkey: signer,
              created_at: Number(args[args.indexOf("--created-at") + 1]),
              id: createHash("sha256").update(raw).digest("hex"),
            }),
          };
      state.signed.push(JSON.parse(result.stdout));
      return result;
    }
    const event = JSON.parse(raw);
    state.published.push(event);
    if (state.loseAck) throw new Error("lost acknowledgement");
    return { stdout: JSON.stringify({ accepted: true, event_id: event.id }) };
  };
  return {
    config,
    state,
    options: { query, run },
    read: async (name) =>
      JSON.parse(await readFile(join(directory, name), "utf8")),
  };
}

test("production transport preserves signing bytes and retries the same durable event", async (t) => {
  const f = await fixture(t);
  f.state.loseAck = true;
  await assert.rejects(
    runLinearSyncOnce(f.config, f.options),
    /publish-record failed/,
  );
  f.state.loseAck = false;
  f.state.failSource = true; // pending input must resume without a newer source read
  const result = await runLinearSyncOnce(f.config, f.options);
  assert.equal(result.complete, true);
  assert.deepEqual(f.state.published[0], f.state.published[1]);
  assert.equal(
    f.state.signed.length,
    2,
    "one task and one project, without resigning the replay",
  );
});

test("the built Rust CLI signs production input and survives a lost acknowledgement", {
  skip: !process.env.BUZZ_LINEAR_TEST_BINARY,
}, async (t) => {
  const f = await fixture(t, true);
  f.state.loseAck = true;
  await assert.rejects(
    runLinearSyncOnce(f.config, f.options),
    /publish-record failed/,
  );
  assert.equal(f.state.signed[0].sig.length, 128);
  f.state.loseAck = false;
  const result = await runLinearSyncOnce(f.config, f.options);
  assert.equal(result.complete, true);
  assert.deepEqual(f.state.published[0], f.state.published[1]);
  assert.equal(f.state.signed.length, 2);
});

test("source failures write sanitized health and preserve the last complete checkpoint until recovery", async (t) => {
  const f = await fixture(t);
  f.state.failSource = true;
  await assert.rejects(
    runLinearSyncOnce(f.config, f.options),
    /source scan failed/,
  );
  assert.match((await f.read("health.json")).error, /source scan failed/);
  assert.equal(f.state.published.length, 0);
  f.state.failSource = false;
  await runLinearSyncOnce(f.config, f.options);
  const completed = await f.read("completed.json");
  const count = f.state.published.length;
  f.state.failSource = true;
  await assert.rejects(
    runLinearSyncOnce(f.config, f.options),
    /source scan failed/,
  );
  assert.deepEqual(await f.read("completed.json"), completed);
  assert.equal(f.state.published.length, count);
  const failed = await f.read("health.json");
  assert.doesNotMatch(JSON.stringify(failed), /private source content/);
  assert.match(failed.error, /source scan failed/);
  f.state.failSource = false;
  await runLinearSyncOnce(f.config, f.options);
  assert.equal((await f.read("health.json")).error, null);
});

test("an overlapping source failure cannot overwrite the active writer's health", async (t) => {
  const f = await fixture(t);
  let release;
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  const wait = new Promise((resolve) => {
    release = resolve;
  });
  const active = runLinearSyncOnce(f.config, {
    ...f.options,
    query: async (...args) => {
      started();
      await wait;
      return f.options.query(...args);
    },
  });
  await ready;
  let queried = false;
  try {
    await assert.rejects(
      runLinearSyncOnce(f.config, {
        ...f.options,
        query: async () => {
          queried = true;
          throw new Error("stale failure");
        },
      }),
      /locked/,
    );
    assert.equal(queried, false);
  } finally {
    release();
  }
  await active;
  assert.equal((await f.read("health.json")).error, null);
});
