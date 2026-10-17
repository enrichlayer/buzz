import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readPages,
  readLinearProjectSnapshot,
  linearQueryThroughCli,
  writeSnapshot,
  PROJECT_QUERY,
  ISSUES_QUERY,
} from "../../scripts/linear-project-snapshot.mjs";

const projectId = "00000000-0000-4000-8000-000000000001";
const organizationId = "00000000-0000-4000-8000-000000000002";
const issueId = "00000000-0000-4000-8000-000000000003";
const otherId = "00000000-0000-4000-8000-000000000004";
const page = (nodes, cursor = null) => ({
  nodes,
  pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
});
const issue = () => ({
  id: issueId,
  identifier: "DEV-1",
  title: "Work",
  description: "Acceptance criteria",
  updatedAt: "2026-10-15T01:00:00Z",
  project: { id: projectId },
  labels: page([]),
  relations: page([]),
  inverseRelations: page([]),
});
function fixture(overrides = {}) {
  const calls = [];
  return {
    calls,
    query: async (query, variables) => {
      calls.push({ query, variables });
      if (query === PROJECT_QUERY)
        return {
          viewer: {
            organization: {
              id: organizationId,
              urlKey: overrides.workspace ?? "acme",
            },
          },
          project: {
            id: projectId,
            name: "Tools",
            teams: page([]),
            projectMilestones: page([]),
          },
        };
      assert.equal(query, ISSUES_QUERY);
      assert.equal(variables.id, projectId);
      return {
        project: { id: projectId, issues: page([overrides.issue ?? issue()]) },
      };
    },
  };
}

test("snapshot reads the explicit project, closed/archived issues, and full issue body", async () => {
  const source = fixture();
  const snapshot = await readLinearProjectSnapshot({
    ...source,
    projectId,
    workspace: "acme",
  });
  assert.equal(snapshot.source.organizationId, organizationId);
  assert.equal(snapshot.source.projectId, projectId);
  assert.equal(snapshot.issues[0].description, "Acceptance criteria");
  assert.equal(snapshot.complete, true);
  assert.match(source.calls[1].query, /project\(id: \$id\)/);
  assert.match(source.calls[1].query, /includeArchived: true/);
  // A mutable sort key lets an issue edited mid-scan skip past the cursor.
  assert.match(source.calls[1].query, /orderBy: createdAt/);
  assert.doesNotMatch(source.calls[1].query, /orderBy: updatedAt/);
  assert.doesNotMatch(source.calls[1].query, /neq: "completed"/);
});

test("wrong workspace fails before issue contents are enumerated", async () => {
  const source = fixture({ workspace: "another" });
  await assert.rejects(
    readLinearProjectSnapshot({ ...source, projectId, workspace: "acme" }),
    /workspace/,
  );
  assert.equal(source.calls.length, 1);
});

test("foreign project rows and invalid source timestamps fail closed", async () => {
  for (const bad of [
    { ...issue(), project: { id: otherId } },
    { ...issue(), updatedAt: "not-a-time" },
  ]) {
    await assert.rejects(
      readLinearProjectSnapshot({
        ...fixture({ issue: bad }),
        projectId,
        workspace: "acme",
      }),
      /scope|timestamp|authorized/,
    );
  }
});

test("pagination retains the newer version across replayed pages", async () => {
  const cursors = [];
  const rows = await readPages(async (cursor) => {
    cursors.push(cursor);
    return cursor === null
      ? page([{ id: issueId, updatedAt: "2026-10-15" }], "next")
      : page([{ id: issueId, updatedAt: "2026-10-14" }, { id: otherId }]);
  });
  assert.deepEqual(cursors, [null, "next"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].updatedAt, "2026-10-15");
});

test("truncated, cyclic, malformed and failed pages cannot produce a complete snapshot", async () => {
  await assert.rejects(
    readPages(async () => page([], "same")),
    /advance/,
  );
  await assert.rejects(
    readPages(async () => page([], "next"), { maxPages: 1 }),
    /budget/,
  );
  await assert.rejects(
    readPages(async () => page([{ id: issueId }, { id: otherId }]), {
      maxItems: 1,
    }),
    /budget/,
  );
  await assert.rejects(
    readPages(async () => ({ nodes: [] })),
    /incomplete/,
  );
  await assert.rejects(
    readPages(async () => {
      throw new Error("rate limited");
    }),
    /rate limited/,
  );
});

test("nested connections are drained, including dependencies beyond the first page", async () => {
  const source = fixture();
  const query = async (q, variables) => {
    if (q === PROJECT_QUERY) return source.query(q, variables);
    if (q === ISSUES_QUERY)
      return {
        project: {
          id: projectId,
          issues: page([
            {
              ...issue(),
              relations: page(
                [{ id: otherId, type: "blocks" }],
                "more-relations",
              ),
            },
          ]),
        },
      };
    assert.match(q, /relations\(first: 50, after: \$after\)/);
    assert.equal(variables.id, issueId);
    assert.equal(variables.after, "more-relations");
    return {
      issue: {
        id: issueId,
        relations: page([{ id: projectId, type: "related" }]),
      },
    };
  };
  const snapshot = await readLinearProjectSnapshot({
    query,
    projectId,
    workspace: "acme",
  });
  assert.equal(snapshot.issues[0].relations.length, 2);
});

test("CLI transport pins profile, uses argv instead of a shell, bounds calls, and propagates failure", async () => {
  const calls = [];
  const query = linearQueryThroughCli("acme", async (...args) => {
    calls.push(args);
    return { stdout: JSON.stringify({ data: { project: { id: projectId } } }) };
  });
  assert.equal(
    (await query("query { viewer { id } }", { id: projectId })).project.id,
    projectId,
  );
  assert.equal(calls[0][0], "el-linear");
  assert.deepEqual(calls[0][1].slice(0, 3), ["--profile", "acme", "graphql"]);
  assert.equal(calls[0][2].timeout, 90_000);
  await assert.rejects(
    linearQueryThroughCli("acme", async () => ({
      stdout: '{"error":"denied"}',
    }))("query", {}),
    /API error/,
  );
  await assert.rejects(
    linearQueryThroughCli("acme", async () => {
      throw new Error("unavailable: private source response");
    })("query", {}),
    (error) => {
      assert.match(error.message, /source read failed/);
      assert.doesNotMatch(error.message, /private source response/);
      return true;
    },
  );
  const controller = new AbortController();
  const cancelled = linearQueryThroughCli(
    "acme",
    async (_binary, _args, options) => {
      assert.equal(options.signal, controller.signal);
      controller.abort();
      throw new Error("child aborted");
    },
    { signal: controller.signal },
  );
  await assert.rejects(cancelled("query", {}), /abort/i);
});

test("failed source reads leave the last complete snapshot intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buzz-linear-snapshot-"));
  const path = join(dir, "snapshot.json");
  try {
    await writeSnapshot(path, { complete: true, revision: "previous" });
    await assert.rejects(async () => {
      const snapshot = await readLinearProjectSnapshot({
        query: async () => {
          throw new Error("network unavailable");
        },
        projectId,
        workspace: "acme",
      });
      await writeSnapshot(path, snapshot);
    }, /network unavailable/);
    assert.equal(JSON.parse(await readFile(path, "utf8")).revision, "previous");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
