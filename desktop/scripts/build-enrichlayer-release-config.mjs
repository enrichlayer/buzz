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
const signingIdentity = process.env.APPLE_SIGNING_IDENTITY || "-";
if (
  signingIdentity !== "-" &&
  !signingIdentity.startsWith("Developer ID Application:")
) {
  throw new Error("Unsupported Apple signing identity");
}
const configPath = resolve("src-tauri/tauri.release.conf.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
for (const variable of [
  "BUZZ_BUILD_DEMO_SLUG",
  "BUZZ_DESKTOP_BUILD_DEMO_SLUG",
]) {
  if (Object.hasOwn(process.env, variable)) {
    throw new Error(
      `Unset ${variable}: daily builds must preserve the production account`,
    );
  }
}
config.identifier = "com.enrichlayer.buzz";
config.bundle.macOS.signingIdentity = signingIdentity;
if (process.env.BUZZ_EL_BRANDING === "1") {
  const branding = JSON.parse(
    readFileSync(
      new URL("../src-tauri/tauri.el-buzz.conf.json", import.meta.url),
      "utf8",
    ),
  );
  if (branding.identifier || branding.plugins || branding.bundle.externalBin) {
    throw new Error(
      "Branding must not replace account, updater, or sidecar configuration",
    );
  }
  config.productName = branding.productName;
  config.build = branding.build;
  config.bundle.icon = branding.bundle.icon;
}
writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
