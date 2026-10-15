const { openSync, readSync, closeSync } = require("node:fs");
const { isAbsolute } = require("node:path");
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

/** Read one operator-owned binding; credentials are environment-only. */
function loadConfig(env = process.env) {
  if (!env.BUZZ_LINEAR_CONFIG_FILE || !isAbsolute(env.BUZZ_LINEAR_CONFIG_FILE))
    throw new Error("BUZZ_LINEAR_CONFIG_FILE must be an absolute path");
  const descriptor = openSync(env.BUZZ_LINEAR_CONFIG_FILE, "r");
  const input = Buffer.alloc(16_385);
  let length;
  try {
    length = readSync(descriptor, input);
  } finally {
    closeSync(descriptor);
  }
  if (length > 16_384) throw new Error("Worker configuration exceeds 16 KiB");
  const config = JSON.parse(input.subarray(0, length).toString("utf8"));
  const allowed = new Set([
    "profile",
    "workspace",
    "projectId",
    "relay",
    "channel",
    "signer",
    "directory",
    "maxRecords",
  ]);
  if (Object.keys(config).some((key) => !allowed.has(key)))
    throw new Error("Unknown worker configuration field");
  if (
    !/^[a-z0-9_-]{1,100}$/i.test(config.profile ?? "") ||
    !/^[a-z0-9-]{1,100}$/i.test(config.workspace ?? "") ||
    !UUID.test(config.projectId ?? "") ||
    !UUID.test(config.channel ?? "") ||
    !/^[a-f0-9]{64}$/.test(config.signer ?? "") ||
    typeof config.directory !== "string" ||
    !isAbsolute(config.directory)
  )
    throw new Error(
      "Worker requires an explicit source, destination and persistent state directory",
    );
  const relay = new URL(config.relay);
  if (
    relay.protocol !== "https:" ||
    relay.username ||
    relay.password ||
    relay.search ||
    relay.hash ||
    relay.pathname !== "/"
  )
    throw new Error("Worker relay must be an HTTPS origin");
  if (
    !Number.isInteger(config.maxRecords ?? 250) ||
    (config.maxRecords ?? 250) < 1 ||
    (config.maxRecords ?? 250) > 250
  )
    throw new Error("Invalid batch size");
  if (!env.LINEAR_API_TOKEN || !env.BUZZ_PRIVATE_KEY)
    throw new Error(
      "Dedicated Linear and Buzz integration credentials are required",
    );
  if (
    !env.TEMPORAL_ADDRESS ||
    !env.TEMPORAL_NAMESPACE ||
    !/^buzz-linear-[a-z0-9-]+$/.test(env.TASK_QUEUE ?? "")
  )
    throw new Error(
      "Explicit Temporal address, namespace and isolated buzz-linear task queue are required",
    );
  return { ...config, maxRecords: config.maxRecords ?? 250 };
}
module.exports = { loadConfig };
