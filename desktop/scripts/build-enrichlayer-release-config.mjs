import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./build-release-config.mjs";

const endpoint = "https://buzz-downloads.enrichlayer.com/latest.json";
if (process.env.BUZZ_UPDATER_ENDPOINT !== endpoint) {
  throw new Error(
    "Enrich Layer builds must use the enrichlayer/buzz updater feed",
  );
}
if (
  !process.env.APPLE_SIGNING_IDENTITY?.startsWith("Developer ID Application:")
) {
  throw new Error(
    "APPLE_SIGNING_IDENTITY must be a Developer ID Application identity",
  );
}
const configPath = resolve("src-tauri/tauri.release.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
config.identifier = "com.enrichlayer.buzz";
config.bundle.macOS.signingIdentity = process.env.APPLE_SIGNING_IDENTITY;
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
