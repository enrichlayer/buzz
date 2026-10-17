import assert from "node:assert/strict";
import { test } from "node:test";

test("local and remote updated reviews compare the target branch, not the first reviewed head", async () => {
  const calls = [];
  globalThis.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command, args) => {
        calls.push({ command, args });
        return { additions: 7, deletions: 3, commit_body: null, files: [] };
      },
    },
  };
  globalThis.__TAURI_INTERNALS__ = window.__TAURI_INTERNALS__;
  const { fetchProjectLocalRepoDiff, fetchProjectRepoDiff } = await import(
    "./hooks.ts"
  );
  const repo = {
    id: "owner:repo",
    dtag: "repo",
    cloneUrls: ["https://relay.example/git/owner/repo"],
    defaultBranch: "main",
  };
  const review = {
    id: "review",
    initialCommit: "a".repeat(40),
    commit: "b".repeat(40),
    targetBranch: "release",
    cloneUrls: repo.cloneUrls,
  };
  await fetchProjectLocalRepoDiff(repo, "/repos", "feature", review);
  await fetchProjectRepoDiff(repo, "feature", review);
  const local = calls.find(
    (c) => c.command === "get_project_local_repo_diff",
  ).args;
  const remote = calls.find((c) => c.command === "get_project_repo_diff").args;
  assert.equal(local.baseCommit, null);
  assert.equal(local.baseBranch, "release");
  assert.equal(remote.baseBranch, "release");
  assert.equal(local.targetCommit, review.commit);
  assert.equal(remote.targetCommit, review.commit);
});
