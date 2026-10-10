import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./build-release-config.mjs";

const endpoint =
  "https://github.com/enrichlayer/buzz/releases/download/buzz-desktop-latest/latest.json";
if (process.env.BUZZ_UPDATER_ENDPOINT !== endpoint) {
  throw new Error(
    "Enrich Layer builds must use the enrichlayer/buzz updater feed",
  );
}
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || "-";
if (
  signingIdentity !== "-" &&
  !signingIdentity.startsWith("Developer ID Application:")
) {
  throw new Error("Unsupported Apple signing identity");
}
const configPath = resolve("src-tauri/tauri.release.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.identifier = "com.enrichlayer.buzz";
config.bundle.macOS.signingIdentity = signingIdentity;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
