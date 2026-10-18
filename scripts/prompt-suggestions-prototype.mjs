#!/usr/bin/env node
/** Compose the opt-in prototype prompt using existing ACP base-prompt transport. */
import { readFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { tmpdir } from "node:os";
const root = fileURLToPath(new URL("../", import.meta.url));
const base = readFileSync(
  path.join(root, "crates/buzz-acp/src/base_prompt.md"),
  "utf8",
);
const skill = readFileSync(
  path.join(root, "scripts/prompt-suggestions-skill.md"),
  "utf8",
);
const output = path.resolve(
  process.argv[2] ??
    path.join(
      mkdtempSync(path.join(tmpdir(), "buzz-suggestions-")),
      "base-prompt.md",
    ),
);
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(
  output,
  `${base}\n\n${skill}\n\nThe Buzz suggestion prototype is enabled. Use the Buzz fenced-footer output, only on completed human-requested turns. Do not emit suggestions on heartbeats or other agents' messages.\n`,
);
process.stdout.write(`${output}\n`);
