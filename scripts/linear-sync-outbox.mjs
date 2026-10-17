/** Durable, bounded sync batches. A scheduler calls again until pending is zero. */
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, open, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const hash = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
const MAX_RECORD_BYTES = 128 * 1024;

async function read(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function save(path, value) {
  const temporary = `${path}.tmp`;
  const file = await open(temporary, "w", 0o600);
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path);
  const directory = await open(dirname(path), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

function bindingKey(binding) {
  if (!UUID.test(binding?.channel ?? "") || !HEX.test(binding?.signer ?? "")) {
    throw new Error(
      "Sync requires explicit channel and integration signer identities",
    );
  }
  const relay = new URL(binding.relay);
  if (
    !["https:", "http:"].includes(relay.protocol) ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash
  ) {
    throw new Error("Invalid sync relay origin");
  }
  if (relay.pathname !== "/") throw new Error("Sync relay must be an origin");
  return {
    relay: relay.origin,
    channel: binding.channel,
    signer: binding.signer,
  };
}

/** Project receipt comes last: its observation time only advances after all tasks. */
export function snapshotRecords(snapshot) {
  if (
    snapshot?.schema !== "buzz.linear-project-snapshot.v1" ||
    snapshot.complete !== true ||
    !Array.isArray(snapshot.issues)
  ) {
    throw new Error("Only a complete source snapshot can enter the outbox");
  }
  const source = snapshot.source;
  if (
    !UUID.test(source?.organizationId ?? "") ||
    !UUID.test(source?.projectId ?? "") ||
    snapshot.project?.id !== source.projectId
  ) {
    throw new Error("Invalid snapshot source identity");
  }
  if (snapshot.issues.length > 10_000)
    throw new Error("Snapshot exceeds the issue budget");
  const ids = new Set();
  const records = snapshot.issues.map((record) => {
    if (
      !UUID.test(record.id ?? "") ||
      record.project?.id !== source.projectId ||
      ids.has(record.id)
    ) {
      throw new Error("Duplicate or out-of-project source issue");
    }
    ids.add(record.id);
    return { type: "issue", record };
  });
  records.push({ type: "project", record: snapshot.project });
  return records.map(({ type, record }) => {
    if (
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      !Number.isFinite(Date.parse(snapshot.completedAt))
    ) {
      throw new Error("Invalid source observation timestamp");
    }
    const payload = {
      schema: "buzz.linear-record.v1",
      source,
      type,
      observedAt: snapshot.completedAt,
      record,
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > MAX_RECORD_BYTES)
      throw new Error(
        `Source ${record.id} exceeds the record limit; no truncation performed`,
      );
    return payload;
  });
}

/**
 * Start a complete batch or resume the existing immutable batch. No new snapshot
 * can overwrite an uncertain publication. A process lock prevents two writers;
 * the OS releases it automatically when a worker process crashes.
 */
export async function runLinearSyncBatch({
  directory,
  binding,
  snapshot,
  loadSnapshot,
  sign,
  publish,
  maxRecords = 50,
  maxDurationMs = 4 * 60_000,
  now = () => Date.now(),
  signal,
}) {
  signal?.throwIfAborted();
  if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 250)
    throw new Error("Invalid sync batch budget");
  if (
    !Number.isFinite(maxDurationMs) ||
    maxDurationMs < 1_000 ||
    maxDurationMs > 15 * 60_000
  )
    throw new Error("Invalid sync time budget");
  const destination = bindingKey(binding);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // SQLite's OS-backed write lock is released on process death. It prevents
  // concurrent writers without a stale lock file that blocks crash recovery.
  const lock = new DatabaseSync(join(directory, "writer.sqlite"));
  let ownsLock = false;
  try {
    lock.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE");
    ownsLock = true;
    const bindingPath = join(directory, "binding.json");
    const priorBinding = await read(bindingPath);
    if (priorBinding && hash(priorBinding) !== hash(destination))
      throw new Error(
        "Refusing to reuse another relay, channel or signer's outbox",
      );
    if (!priorBinding) await save(bindingPath, destination);
    const headsDirectory = join(directory, "heads");
    await mkdir(headsDirectory, { recursive: true, mode: 0o700 });
    const jobPath = join(directory, "job.json");
    let job = await read(jobPath);
    if (!job) {
      // Source reads share the writer lock and failure receipt with publication.
      // Never fetch newer input while an immutable batch still needs replay.
      snapshot ??= await loadSnapshot?.();
      const records = snapshotRecords(snapshot);
      const sourcePath = join(directory, "source.json");
      const priorSource = await read(sourcePath);
      if (priorSource && hash(priorSource) !== hash(snapshot.source))
        throw new Error("Outbox source workspace/project changed");
      if (!priorSource) await save(sourcePath, snapshot.source);
      const last = await read(join(directory, "completed.json"));
      if (
        last &&
        Date.parse(snapshot.completedAt) < Date.parse(last.observedAt)
      )
        throw new Error(
          "Source snapshot is older than the committed observation",
        );
      // A complete authorized enumeration can retract an old projection. It
      // cannot tell deletion from a move or loss of source visibility, so clear
      // the copied body and mark it out of scope rather than claiming deletion.
      const present = new Set(snapshot.issues.map((issue) => issue.id));
      const oldHeads = await readdir(headsDirectory);
      if (oldHeads.length > 10_001)
        throw new Error("Retained head budget exceeded");
      for (const file of oldHeads.filter((name) =>
        /^issue-[a-f0-9-]+\.json$/i.test(name),
      )) {
        const prior = await read(join(headsDirectory, file));
        if (
          !prior?.record ||
          present.has(prior.record.id) ||
          prior.record.retired
        )
          continue;
        records.splice(records.length - 1, 0, {
          schema: "buzz.linear-record.v1",
          source: snapshot.source,
          type: "issue",
          observedAt: snapshot.completedAt,
          record: {
            ...prior.record,
            retired: true,
            retiredReason: "No longer visible in the selected Linear project",
          },
        });
      }
      await save(join(directory, "records.json"), records);
      job = {
        checksum: hash(records),
        count: records.length,
        cursor: 0,
        observedAt: snapshot.completedAt,
      };
      await save(jobPath, job);
    }
    const records = await read(join(directory, "records.json"));
    if (
      !Array.isArray(records) ||
      hash(records) !== job.checksum ||
      records.length !== job.count
    )
      throw new Error("Durable sync input checksum mismatch");
    const deadline = Date.now() + maxDurationMs;
    let processed = 0;
    for (
      ;
      job.cursor < records.length &&
      processed < maxRecords &&
      Date.now() < deadline;
      processed++
    ) {
      signal?.throwIfAborted();
      const payload = records[job.cursor];
      const key = `${payload.type}-${payload.record.id}`;
      const headPath = join(headsDirectory, `${key}.json`);
      const prior = await read(headPath);
      // Project observedAt is a completed-scan receipt; task timestamps are source timestamps.
      const digest = hash(
        payload.type === "issue" ? { ...payload, observedAt: null } : payload,
      );
      if (
        prior &&
        Date.parse(payload.record.updatedAt) < Date.parse(prior.updatedAt)
      )
        throw new Error(`Source version regressed for ${key}`);
      const pendingPath = join(directory, "pending.json");
      if (prior?.digest !== digest) {
        let pending = await read(pendingPath);
        if (pending && (pending.key !== key || pending.digest !== digest))
          throw new Error(
            "Pending publication does not match durable source input",
          );
        if (!pending) {
          const createdAt = Math.max(
            Math.floor(now() / 1_000),
            (prior?.createdAt ?? 0) + 1,
          );
          const event = await sign(payload, createdAt, destination);
          if (
            !HEX.test(event?.id ?? "") ||
            event.pubkey !== destination.signer ||
            event.content !== JSON.stringify(payload) ||
            event.created_at !== createdAt
          )
            throw new Error("Signer returned a different event or identity");
          pending = { key, digest, event, updatedAt: payload.record.updatedAt };
          await save(pendingPath, pending);
        }
        const receipt = await publish(pending.event, destination);
        if (receipt?.accepted !== true || receipt.event_id !== pending.event.id)
          throw new Error(
            "Publication not acknowledged; retaining exact signed event for retry",
          );
        await save(headPath, {
          digest,
          eventId: pending.event.id,
          updatedAt: pending.updatedAt,
          createdAt: pending.event.created_at,
          record: {
            id: payload.record.id,
            project: payload.record.project,
            identifier: payload.record.identifier,
            title: payload.record.title,
            url: payload.record.url,
            updatedAt: payload.record.updatedAt,
            retired: payload.record.retired === true,
          },
        });
      }
      // Head is durable before advancing; an uncertain acknowledgement resends
      // the same signed bytes, while an acknowledged replay skips publication.
      await rm(pendingPath, { force: true });
      job.cursor++;
      await save(jobPath, job);
    }
    const pending = records.length - job.cursor;
    if (pending === 0) {
      await save(join(directory, "completed.json"), {
        observedAt: job.observedAt,
        count: job.count,
        checksum: job.checksum,
      });
      await rm(jobPath);
    }
    await save(join(directory, "health.json"), {
      checkedAt: new Date(now()).toISOString(),
      pending,
      error: null,
    });
    return {
      processed,
      pending,
      complete: pending === 0,
      observedAt: job.observedAt,
    };
  } catch (error) {
    if (ownsLock)
      await save(join(directory, "health.json"), {
        checkedAt: new Date(now()).toISOString(),
        error: error.message,
      });
    throw error;
  } finally {
    lock.close();
  }
}

/** Counts retained per-record heads for operational inspection, without source contents. */
export async function countSyncHeads(directory) {
  return (await readdir(join(directory, "heads"))).filter((file) =>
    file.endsWith(".json"),
  ).length;
}
