#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readFileSync } from "node:fs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repository = "https://github.com/enrichlayer/buzz.git";
const channel = "codex/buzz-local-install";
const command = process.argv[2] ?? "help";
function git(...args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    timeout: 20000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  }).trim();
}
function check() {
  const revision = git("rev-parse", "HEAD");
  const dirty = Boolean(
    git("status", "--porcelain", "--untracked-files=normal"),
  );
  const remote = git(
    "ls-remote",
    "--exit-code",
    repository,
    `refs/heads/${channel}`,
  ).split(/\s/)[0];
  if (!/^[a-f0-9]{40}$/.test(remote))
    throw new Error("Channel returned no valid revision");
  const result = {
    repository,
    channel,
    revision,
    remote,
    modified: dirty,
    status: dirty
      ? "Modified checkout"
      : revision === remote
        ? "Source current"
        : "Source differs from channel",
    note: "This checks source only. Rebuild and compare Settings > Updates build identity to verify the running app.",
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}
try {
  if (
    !["help", "check", "start", "install", "plugins"].includes(command) ||
    process.argv.length > 3
  )
    throw new Error(
      "Usage: node scripts/local-install.mjs [check|start|install|plugins]",
    );
  if (command === "help")
    console.log(
      "Usage: node scripts/local-install.mjs [check|start|install|plugins]\ncheck: compare source with coding demo channel; no checkout changes\nstart: require a clean checkout, install locked dependencies and build/run desktop + CLI\nplugins: print bundled manifest locations for Settings > Plugins",
    );
  if (command === "check") check();
  if (command === "plugins") {
    for (const name of [
      "review-card",
      "runbook",
      "feedback-card",
      "session-demo-card",
    ]) {
      const file = path.join(
        root,
        "docs/examples/runtime-plugins",
        `${name}.json`,
      );
      const m = JSON.parse(readFileSync(file, "utf8"));
      console.log(`${m.name} ${m.version}: ${file}`);
    }
    console.log(
      "Import using Settings > Plugins. Review existing renderers before updating. Nothing was installed automatically.",
    );
  }
  if (command === "install") {
    const run = spawnSync(
      "bash",
      [path.join(root, "scripts/install-local-macos.sh")],
      { cwd: root, stdio: "inherit" },
    );
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  }
  if (command === "start") {
    if (git("status", "--porcelain", "--untracked-files=normal"))
      throw new Error(
        "Refusing modified checkout. Preserve/commit your changes before building a shareable local install.",
      );
    console.log(
      `Building ${repository}@${git("rev-parse", "HEAD")}. This is a local source build, not a signed auto-update release.`,
    );
    const run = spawnSync(
      "bash",
      [
        "-c",
        ". ./bin/activate-hermit && pnpm install --frozen-lockfile && just desktop-standalone",
      ],
      { cwd: root, stdio: "inherit" },
    );
    if (run.error) throw run.error;
    process.exitCode = run.status ?? 1;
  }
} catch (error) {
  console.error(`Unable to complete ${command}: ${error.message}`);
  process.exitCode = 1;
}
