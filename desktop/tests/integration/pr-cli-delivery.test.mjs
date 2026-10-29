import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPublicKey, verifyEvent } from "nostr-tools";
import { eventToProjectPullRequest } from "../../src/features/projects/projectPullRequests.mjs";
import { eventToReviewBundle } from "../../src/features/projects/reviewBundles.ts";
import { reviewBundleState } from "../../src/features/projects/reviewBundleState.ts";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
// Public throwaway test keys. Never use the operator's configured identity.
const AUTHOR_KEY = "01".repeat(32);
const REVIEWER_KEY = "02".repeat(32);
const keyBytes = (key) => Uint8Array.from(Buffer.from(key, "hex"));
const AUTHOR = getPublicKey(keyBytes(AUTHOR_KEY));
const REVIEWER = getPublicKey(keyBytes(REVIEWER_KEY));
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const PR_A = "1".repeat(64);
const PR_B = "2".repeat(64);
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => !key.startsWith("BUZZ_")),
);
let binary;
let relay;
let server;
let queryEvents = [];
const submitted = [];
let acknowledge = (event) =>
  JSON.stringify({ accepted: true, event_id: event.id });

before(async () => {
  // Build this checkout, never use an ambient/stale installed buzz binary.
  await exec("cargo", ["build", "-p", "buzz-cli", "--bin", "buzz"], {
    cwd: root,
  });
  const { stdout } = await exec(
    "cargo",
    ["metadata", "--format-version", "1", "--no-deps"],
    { cwd: root },
  );
  binary = join(JSON.parse(stdout).target_directory, "debug", "buzz");
  server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.setHeader("content-type", "application/json");
    if (request.url === "/query") {
      response.end(JSON.stringify(queryEvents));
    } else {
      assert.equal(request.url, "/events");
      assert.equal(verifyEvent(body), true);
      submitted.push(body);
      response.end(acknowledge(body));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  relay = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

async function cli(args, key = AUTHOR_KEY) {
  try {
    const result = await exec(
      binary,
      ["--relay", relay, "--private-key", key, "pr", ...args],
      { cwd: root, env },
    );
    return { ...result, code: 0 };
  } catch (error) {
    if (typeof error.code !== "number") throw error;
    return error;
  }
}
const repoArgs = ["--repo-owner", AUTHOR, "--repo-id", "demo"];
const bundleOpen = [
  "bundle",
  "open",
  ...repoArgs,
  "--subject",
  "Public test stack",
  "--member",
  PR_A,
  "--member",
  PR_B,
  "--reviewer",
  REVIEWER,
];

test("review publications require exact accepted-event proof before success or a link", async () => {
  const opened = await cli(bundleOpen);
  assert.equal(opened.code, 0, opened.stderr);
  const bundle = submitted.at(-1);
  queryEvents = [bundle];
  const commands = [
    ["comment", ...repoArgs, "--pr", PR_A, "--body", "Public test comment"],
    ["review", ...repoArgs, "--pr", PR_A, "--commit", HEAD_A, "--approve"],
    ["request-review", ...repoArgs, "--pr", PR_A, "--reviewer", REVIEWER],
    bundleOpen,
    [
      "bundle",
      "review",
      ...repoArgs,
      "--bundle",
      bundle.id,
      "--member-head",
      `${PR_A}:${HEAD_A}`,
      "--member-head",
      `${PR_B}:${HEAD_B}`,
      "--approve",
    ],
  ];
  const badProofs = {
    rejected: (event) =>
      JSON.stringify({ accepted: false, event_id: event.id }),
    "missing id": () => '{"accepted":true}',
    "wrong id": () =>
      JSON.stringify({ accepted: true, event_id: "f".repeat(64) }),
    "missing accepted": (event) => JSON.stringify({ event_id: event.id }),
    "string accepted": (event) =>
      JSON.stringify({ accepted: "true", event_id: event.id }),
    "null id": () => '{"accepted":true,"event_id":null}',
    malformed: () => '{"accepted":true',
    "duplicate accepted": (event) =>
      `{"accepted":false,"accepted":true,"event_id":"${event.id}"}`,
    "duplicate id": (event) =>
      `{"accepted":true,"event_id":"wrong","event_id":"${event.id}"}`,
    "sequence-shaped struct": (event) => JSON.stringify([true, event.id]),
  };
  for (const args of commands) {
    for (const [label, proof] of Object.entries(badProofs)) {
      acknowledge = proof;
      const count = submitted.length;
      const result = await cli(args);
      assert.notEqual(result.code, 0, `${args.slice(0, 2)}: ${label}`);
      assert.equal(
        result.stdout,
        "",
        "unconfirmed delivery must not emit a link or success JSON",
      );
      const error = JSON.parse(result.stderr);
      assert.equal(error.error, "delivery_unknown");
      assert.equal(error.retryable, false);
      assert.match(error.message, new RegExp(submitted.at(-1).id));
      assert.equal(
        submitted.length,
        count + 1,
        "do not re-sign/retry ambiguous proof",
      );
    }
    // Duplicate-event acceptance remains valid if it proves this exact event.
    acknowledge = (event) =>
      JSON.stringify({
        accepted: true,
        event_id: event.id,
        message: "duplicate",
      });
    const result = await cli(args);
    assert.equal(result.code, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.event_id, submitted.at(-1).id);
    assert.equal(output.accepted, true);
    assert.match(output.link, /^buzz:\/\//);
  }
});

test("CLI-produced main → A → B stack compares B to A and keeps self-review forbidden", async () => {
  acknowledge = (event) =>
    JSON.stringify({ accepted: true, event_id: event.id });
  const roots = [];
  for (const [branch, target, commit] of [
    ["feature/a", "main", HEAD_A],
    ["feature/b", "feature/a", HEAD_B],
  ]) {
    const result = await cli([
      "open",
      ...repoArgs,
      "--subject",
      branch,
      "--commit",
      commit,
      "--clone",
      "https://example.com/public/demo.git",
      "--branch-name",
      branch,
      "--target-branch",
      target,
      "--mirror-of",
      "https://gitlab.com/acme/demo/-/merge_requests/7",
    ]);
    assert.equal(result.code, 0, result.stderr);
    roots.push(submitted.at(-1));
  }
  const notes = [];
  for (const member of roots) {
    // Merely receiving a bundle request is not a per-member review request.
    const request = await cli([
      "request-review",
      ...repoArgs,
      "--pr",
      member.id,
      "--reviewer",
      REVIEWER,
    ]);
    assert.equal(request.code, 0, request.stderr);
    notes.push(submitted.at(-1));
    for (const key of [AUTHOR_KEY, REVIEWER_KEY]) {
      const verdict = await cli(
        [
          "review",
          ...repoArgs,
          "--pr",
          member.id,
          "--commit",
          member.tags.find(([name]) => name === "c")[1],
          "--approve",
        ],
        key,
      );
      assert.equal(verdict.code, 0, verdict.stderr);
      notes.push(submitted.at(-1));
    }
  }
  assert.notEqual(AUTHOR, REVIEWER);
  const pullRequests = roots.map((event) =>
    eventToProjectPullRequest(event, [], notes, []),
  );
  assert.deepEqual(
    pullRequests.map((pr) => pr.targetBranch),
    ["main", "feature/a"],
  );
  for (const pr of pullRequests) {
    assert.deepEqual(pr.reviewers, [REVIEWER]);
    assert.deepEqual(
      pr.approvals.map((approval) => approval.author),
      [REVIEWER],
      "the mirrored-root author must not approve even when also repo owner",
    );
  }
  const opened = await cli([
    "bundle",
    "open",
    ...repoArgs,
    "--subject",
    "Public stack",
    "--reviewer",
    REVIEWER,
    "--member",
    `${roots[0].id}:feature/a`,
    "--member",
    `${roots[1].id}:feature/b`,
  ]);
  assert.equal(opened.code, 0, opened.stderr);
  const bundle = eventToReviewBundle(submitted.at(-1));
  const state = reviewBundleState(
    bundle,
    new Map(pullRequests.map((pr) => [pr.id, pr])),
    [],
  );
  assert.deepEqual(
    state.members.map((row) => row.pullRequest.id),
    roots.map((event) => event.id),
  );

  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return { additions: 1, deletions: 0, commit_body: null, files: [] };
      },
    },
  };
  globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__;
  const { fetchProjectLocalRepoDiff, fetchProjectRepoDiff } = await import(
    "../../src/features/projects/hooks.ts"
  );
  const repo = {
    id: `${AUTHOR}:demo`,
    dtag: "demo",
    cloneUrls: pullRequests[0].cloneUrls,
    defaultBranch: "main",
  };
  for (const pr of pullRequests) {
    calls.length = 0;
    await fetchProjectLocalRepoDiff(repo, "/repos", pr.branchName, pr);
    await fetchProjectRepoDiff(repo, pr.branchName, pr);
    assert.deepEqual(
      calls.map(({ args }) => args.baseBranch),
      [pr.targetBranch, pr.targetBranch],
    );
    assert.deepEqual(
      calls.map(({ args }) => args.targetCommit),
      [pr.commit, pr.commit],
    );
    assert.equal(calls[0].args.baseCommit, null);
  }
  // Backward compatibility: an ordinary PR with no explicit target still
  // compares against the repository default, not an invented parent.
  const legacy = eventToProjectPullRequest({
    ...roots[1],
    tags: roots[1].tags.filter(([name]) => name !== "target-branch"),
  });
  calls.length = 0;
  await fetchProjectRepoDiff(repo, legacy.branchName, legacy);
  assert.equal(calls[0].args.baseBranch, "main");
});
