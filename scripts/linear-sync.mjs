#!/usr/bin/env node
/** One bounded activity for a managed scheduler; no unmanaged polling loop. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  linearQueryThroughCli,
  readLinearProjectSnapshot,
  writeSnapshot,
} from "./linear-project-snapshot.mjs";
import { runLinearSyncBatch } from "./linear-sync-outbox.mjs";

const execute = promisify(execFile);

/** The managed environment supplies integration credentials, never desktop keys. */
export function buzzLinearTransport(
  { directory, relay, binary = "buzz", signal },
  run = execute,
) {
  async function command(action, file, value, destination, createdAt) {
    signal?.throwIfAborted();
    const path = join(directory, file);
    await writeSnapshot(path, value);
    try {
      const args = [
        "linear",
        action,
        "--channel",
        destination.channel,
        action === "sign-record" ? "--record-file" : "--event-file",
        path,
      ];
      if (createdAt !== undefined) args.push("--created-at", String(createdAt));
      const { stdout } = await run(binary, args, {
        timeout: 60_000,
        maxBuffer: 512 * 1024,
        env: { ...process.env, BUZZ_RELAY_URL: relay },
        signal,
      });
      return JSON.parse(stdout);
    } catch (error) {
      // execFile errors may include full command output. Keep private issue
      // contents and credentials out of scheduler logs and health receipts.
      throw new Error(
        `Buzz Linear ${action} failed (${error.code ?? error.name}); durable input retained`,
      );
    } finally {
      await rm(path, { force: true });
    }
  }
  return {
    sign: (payload, time, destination) =>
      command("sign-record", "record-input.json", payload, destination, time),
    publish: (event, destination) =>
      command("publish-record", "event-input.json", event, destination),
  };
}

/** Resume an interrupted batch before fetching any newer source observation. */
export async function runLinearSyncOnce(
  config,
  { signal, query, run = execute } = {},
) {
  signal?.throwIfAborted();
  const directory = resolve(config.directory);
  try {
    const source = JSON.parse(
      await readFile(join(directory, "source.json"), "utf8"),
    );
    if (
      source.workspace !== config.workspace ||
      source.projectId !== config.projectId
    ) {
      throw new Error(
        "Configured Linear source differs from the persisted outbox",
      );
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return runLinearSyncBatch({
    directory,
    binding: {
      relay: config.relay,
      channel: config.channel,
      signer: config.signer,
    },
    loadSnapshot: async () => {
      try {
        return await readLinearProjectSnapshot({
          query:
            query ??
            linearQueryThroughCli(config.profile, undefined, { signal }),
          workspace: config.workspace,
          projectId: config.projectId,
          progressPath: join(directory, "snapshot-progress"),
        });
      } catch {
        throw new Error(
          "Linear source scan failed; last complete observation retained",
        );
      }
    },
    maxRecords: config.maxRecords ?? 50,
    signal,
    ...buzzLinearTransport(
      { directory, relay: config.relay, binary: config.binary, signal },
      run,
    ),
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const main = async () => {
    const [configFile, ...extra] = process.argv.slice(2);
    if (!configFile || extra.length)
      throw new Error(
        "Usage: node scripts/linear-sync.mjs /private/path/config.json",
      );
    const config = JSON.parse(await readFile(configFile, "utf8"));
    console.log(JSON.stringify(await runLinearSyncOnce(config)));
  };
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
