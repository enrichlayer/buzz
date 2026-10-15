import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  runLinearSyncBatch,
  snapshotRecords,
  countSyncHeads,
} from "../../scripts/linear-sync-outbox.mjs";

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const binding = {
  relay: "https://relay.test",
  channel: id(1),
  signer: "a".repeat(64),
};
const timestamp = "2026-10-15T00:00:00Z";
function snapshot() {
  return {
    schema: "buzz.linear-project-snapshot.v1",
    complete: true,
    completedAt: timestamp,
    source: {
      provider: "linear",
      organizationId: id(2),
      projectId: id(3),
      workspace: "acme",
    },
    project: { id: id(3), name: "Tools", updatedAt: timestamp },
    issues: [4, 5].map((n) => ({
      id: id(n),
      project: { id: id(3) },
      title: `Task ${n}`,
      description: "Full criteria",
      updatedAt: timestamp,
    })),
  };
}
function transport() {
  const signed = [],
    published = [];
  return {
    signed,
    published,
    sign: async (payload, createdAt, destination) => {
      const content = JSON.stringify(payload);
      const event = {
        content,
        created_at: createdAt,
        pubkey: destination.signer,
        id: createHash("sha256").update(content).digest("hex"),
      };
      signed.push(event);
      return event;
    },
    publish: async (event) => {
      published.push(event);
      return { accepted: true, event_id: event.id };
    },
  };
}
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "buzz-linear-outbox-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tx = transport();
  return {
    directory,
    binding,
    snapshot: snapshot(),
    now: () => Date.parse(timestamp),
    ...tx,
  };
}

test("bounded batches resume durable input and publish the project receipt last", async (t) => {
  const f = await fixture(t);
  const first = await runLinearSyncBatch({ ...f, maxRecords: 1 });
  assert.equal(first.pending, 2);
  assert.equal(await countSyncHeads(f.directory), 1);
  const next = await runLinearSyncBatch({ ...f, snapshot: null });
  assert.equal(next.complete, true);
  assert.deepEqual(
    f.published.map((e) => JSON.parse(e.content).type),
    ["issue", "issue", "project"],
  );
  assert.equal(await countSyncHeads(f.directory), 3);
  await runLinearSyncBatch(f);
  assert.equal(
    f.published.length,
    3,
    "unchanged snapshot must not republish tasks",
  );
});

test("lost acknowledgement keeps exact signed bytes and retries without resigning", async (t) => {
  const f = await fixture(t);
  let uncertainEvent;
  await assert.rejects(
    runLinearSyncBatch({
      ...f,
      publish: async (event) => {
        uncertainEvent = event;
        throw new Error("network lost after commit");
      },
    }),
    /network lost/,
  );
  const pending = JSON.parse(
    await readFile(join(f.directory, "pending.json"), "utf8"),
  );
  assert.deepEqual(pending.event, uncertainEvent);
  const result = await runLinearSyncBatch({
    ...f,
    snapshot: null,
    maxRecords: 1,
  });
  assert.equal(result.pending, 2);
  assert.equal(f.signed.length, 1);
  assert.deepEqual(f.published[0], uncertainEvent);
});

test("rejected or wrong-event acknowledgements cannot advance the checkpoint", async (t) => {
  const f = await fixture(t);
  for (const receipt of [
    { accepted: false },
    { accepted: true, event_id: "b".repeat(64) },
  ]) {
    await assert.rejects(
      runLinearSyncBatch({ ...f, publish: async () => receipt }),
      /not acknowledged/,
    );
    assert.equal(await countSyncHeads(f.directory), 0);
    assert.equal(
      JSON.parse(await readFile(join(f.directory, "job.json"), "utf8")).cursor,
      0,
    );
  }
});

test("outbox refuses another tenant, channel, signer, or source project", async (t) => {
  const f = await fixture(t);
  await runLinearSyncBatch(f);
  for (const change of [
    { relay: "https://other.test" },
    { channel: id(9) },
    { signer: "b".repeat(64) },
  ]) {
    await assert.rejects(
      runLinearSyncBatch({ ...f, binding: { ...binding, ...change } }),
      /another relay/,
    );
  }
  const foreign = snapshot();
  foreign.source.organizationId = id(9);
  await assert.rejects(
    runLinearSyncBatch({ ...f, snapshot: foreign }),
    /workspace\/project changed/,
  );
});

test("wrong signer cannot create a pending publication", async (t) => {
  const f = await fixture(t);
  await assert.rejects(
    runLinearSyncBatch({
      ...f,
      sign: async (...args) => ({
        ...(await f.sign(...args)),
        pubkey: "b".repeat(64),
      }),
    }),
    /different event/,
  );
  assert.equal(f.published.length, 0);
  await assert.rejects(readFile(join(f.directory, "pending.json")), {
    code: "ENOENT",
  });
});

test("concurrent workers cannot publish from the same outbox", async (t) => {
  const f = await fixture(t);
  let release, entered;
  const enteredPromise = new Promise((resolve) => {
    entered = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const first = runLinearSyncBatch({
    ...f,
    publish: async (event) => {
      entered();
      await gate;
      return f.publish(event);
    },
  });
  await enteredPromise;
  try {
    await assert.rejects(runLinearSyncBatch(f), /locked/);
  } finally {
    release();
  }
  await first;
  assert.equal(f.published.length, 3);
});

test("incomplete, oversized and duplicate snapshots fail before signing", () => {
  assert.throws(
    () => snapshotRecords({ ...snapshot(), complete: false }),
    /complete/,
  );
  const duplicate = snapshot();
  duplicate.issues.push(duplicate.issues[0]);
  assert.throws(() => snapshotRecords(duplicate), /Duplicate/);
  const large = snapshot();
  large.issues[0].description = "x".repeat(128 * 1024);
  assert.throws(() => snapshotRecords(large), /no truncation/);
});

test("source regression retains the successful receipt and stops publication", async (t) => {
  const f = await fixture(t);
  await runLinearSyncBatch(f);
  const older = snapshot();
  older.completedAt = "2026-10-16T00:00:00Z";
  older.issues[0].updatedAt = "2026-10-14T00:00:00Z";
  await assert.rejects(
    runLinearSyncBatch({ ...f, snapshot: older }),
    /regressed/,
  );
  const receipt = JSON.parse(
    await readFile(join(f.directory, "completed.json"), "utf8"),
  );
  assert.equal(receipt.observedAt, timestamp);
  assert.equal(f.published.length, 3);
});

test("complete scans retract missing issues without claiming deletion and restore them later", async (t) => {
  const f = await fixture(t);
  await runLinearSyncBatch(f);
  const moved = snapshot();
  moved.completedAt = "2026-10-16T00:00:00Z";
  moved.issues.pop();
  await runLinearSyncBatch({ ...f, snapshot: moved });
  const retired = f.published
    .map((e) => JSON.parse(e.content))
    .find((p) => p.record.retired);
  assert.equal(retired.record.id, id(5));
  assert.equal(retired.record.description, undefined);
  assert.match(retired.record.retiredReason, /No longer visible/);
  const restored = snapshot();
  restored.completedAt = "2026-10-17T00:00:00Z";
  await runLinearSyncBatch({ ...f, snapshot: restored });
  const latest = f.published
    .map((e) => JSON.parse(e.content))
    .filter((p) => p.record.id === id(5))
    .at(-1);
  assert.notEqual(latest.record.retired, true);
  assert.equal(latest.record.description, "Full criteria");
});

test("a killed worker releases its lock and resumes the persisted signed event", {
  timeout: 15_000,
}, async (t) => {
  const f = await fixture(t);
  const moduleUrl = new URL(
    "../../scripts/linear-sync-outbox.mjs",
    import.meta.url,
  ).href;
  const code = `
    import { runLinearSyncBatch } from ${JSON.stringify(moduleUrl)};
    await runLinearSyncBatch({
      directory: ${JSON.stringify(f.directory)}, binding: ${JSON.stringify(binding)},
      snapshot: ${JSON.stringify(snapshot())},
      sign: async (p, time, b) => ({id:"c".repeat(64),pubkey:b.signer,created_at:time,content:JSON.stringify(p)}),
      publish: async () => { console.log("persisted"); await new Promise(() => setInterval(() => {}, 1000)); }
    });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGKILL"));
  const closed = once(child, "close");
  const ready = await Promise.race([
    once(child.stdout, "data").then(([data]) => data.toString()),
    closed.then(([exit]) => {
      throw new Error(`Worker exited before checkpoint: ${exit}`);
    }),
  ]);
  assert.match(ready, /persisted/);
  child.kill("SIGKILL");
  await closed;
  const result = await runLinearSyncBatch({
    ...f,
    snapshot: null,
    maxRecords: 1,
  });
  assert.equal(result.pending, 2);
  assert.equal(f.signed.length, 0);
  assert.equal(f.published[0].id, "c".repeat(64));
});
