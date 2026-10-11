import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import "./build-release-config.mjs";

const endpoint = "https://buzz-downloads.enrichlayer.com/latest.json";
// The committed key pins the updater identity: a replaced Actions secret must
// not ship clients that trust a different signer.
const pinnedKey = readFileSync(
  new URL("../enrichlayer-updater.pub", import.meta.url),
  "utf8",
).trim();
if (process.env.BUZZ_UPDATER_PUBLIC_KEY?.trim() !== pinnedKey) {
  throw new Error(
    "BUZZ_UPDATER_PUBLIC_KEY does not match desktop/enrichlayer-updater.pub",
  );
}
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
