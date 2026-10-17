#!/usr/bin/env node
/** Read a scoped Linear project through el-linear; never write to Linear. */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

const execFileAsync = promisify(execFile);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PAGE = "pageInfo { hasNextPage endCursor }";
const ISSUE_FIELDS = `id identifier title description url updatedAt createdAt archivedAt
  priority estimate dueDate completedAt canceledAt
  team { id key name } state { id name type }
  assignee { id name displayName } project { id }
  parent { id identifier } projectMilestone { id name }
  cycle { id number name startsAt endsAt }
  labels(first: 50) { nodes { id name color } ${PAGE} }
  relations(first: 50) { nodes { id type relatedIssue { id identifier } } ${PAGE} }
  inverseRelations(first: 50) { nodes { id type issue { id identifier } } ${PAGE} }`;

export const PROJECT_QUERY = `query BuzzProject($id: String!) {
  viewer { organization { id urlKey } }
  project(id: $id) {
    id name description content url updatedAt archivedAt startDate targetDate
    state lead { id name displayName }
    teams(first: 50) { nodes { id key name } ${PAGE} }
    projectMilestones(first: 50) {
      nodes { id name description targetDate sortOrder } ${PAGE}
    }
  }
}`;
// Page by immutable creation time. An updatedAt order moves an issue edited
// mid-scan across the cursor, so a "complete" scan could omit it and the
// outbox would publish a false retirement for a live issue.
export const ISSUES_QUERY = `query BuzzProjectIssues($id: String!, $after: String) {
  project(id: $id) {
    id issues(first: 25, after: $after, includeArchived: true, orderBy: createdAt) {
      nodes { ${ISSUE_FIELDS} } ${PAGE}
    }
  }
}`;

function connection(value, label) {
  if (
    !Array.isArray(value?.nodes) ||
    typeof value?.pageInfo?.hasNextPage !== "boolean"
  ) {
    throw new Error(
      `Invalid ${label} connection; refusing an incomplete snapshot`,
    );
  }
  return value;
}

/** Exhaust pages or fail explicitly. Never commit a truncated scan as fresh. */
export async function readPages(
  read,
  { maxPages = 500, maxItems = 10_000 } = {},
) {
  const items = new Map();
  const cursors = new Set();
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const result = connection(await read(after), "page");
    for (const item of result.nodes) {
      if (!UUID.test(item?.id ?? ""))
        throw new Error("Source record has no stable UUID");
      const prior = items.get(item.id);
      if (!prior?.updatedAt || item.updatedAt >= prior.updatedAt)
        items.set(item.id, item);
    }
    if (items.size > maxItems)
      throw new Error("Linear snapshot item budget exceeded");
    if (!result.pageInfo.hasNextPage) return [...items.values()];
    after = result.pageInfo.endCursor;
    if (!after || cursors.has(after))
      throw new Error("Linear pagination did not advance");
    cursors.add(after);
  }
  throw new Error(
    "Linear snapshot page budget exhausted; no complete snapshot produced",
  );
}

async function completeNested(query, owner, field, selection, first, initial) {
  const initialPage = connection(initial, field);
  if (!initialPage.pageInfo.hasNextPage) return initialPage.nodes;
  return readPages(
    async (after) => {
      if (after === null) return initialPage;
      const result = await query(
        `query BuzzNested($id: String!, $after: String) {
        ${owner.type}(id: $id) { id ${field}(first: ${first}, after: $after) {
          nodes { ${selection} } ${PAGE}
        } }
      }`,
        { id: owner.id, after },
      );
      if (result?.[owner.type]?.id !== owner.id)
        throw new Error("Nested source identity changed");
      return result[owner.type][field];
    },
    { maxPages: 100, maxItems: 5_000 },
  );
}

/** A complete, project-scoped observation suitable for a durable sync input. */
export async function readLinearProjectSnapshot({
  query: sourceQuery,
  projectId,
  workspace,
  now = () => new Date(),
  maxDurationMs = 15 * 60_000,
}) {
  if (!UUID.test(projectId ?? ""))
    throw new Error("An explicit Linear project UUID is required");
  if (!/^[a-z0-9-]+$/i.test(workspace ?? ""))
    throw new Error("An explicit workspace URL key is required");
  const startedAt = now().toISOString();
  const deadline = Date.now() + maxDurationMs;
  const query = async (...args) => {
    if (Date.now() >= deadline)
      throw new Error("Linear snapshot deadline exceeded");
    const result = await sourceQuery(...args);
    if (Date.now() >= deadline)
      throw new Error("Linear snapshot deadline exceeded");
    return result;
  };
  const data = await query(PROJECT_QUERY, { id: projectId });
  const organization = data?.viewer?.organization;
  if (!UUID.test(organization?.id ?? "") || organization.urlKey !== workspace) {
    throw new Error(
      "Linear profile does not belong to the configured workspace",
    );
  }
  if (data?.project?.id !== projectId)
    throw new Error(
      "Linear project is missing or outside the authorized scope",
    );
  const project = data.project;
  project.teams = await completeNested(
    query,
    { type: "project", id: projectId },
    "teams",
    "id key name",
    50,
    project.teams,
  );
  project.projectMilestones = await completeNested(
    query,
    { type: "project", id: projectId },
    "projectMilestones",
    "id name description targetDate sortOrder",
    50,
    project.projectMilestones,
  );
  const issues = await readPages(async (after) => {
    const result = await query(ISSUES_QUERY, { id: projectId, after });
    if (result?.project?.id !== projectId)
      throw new Error("Source project identity changed during enumeration");
    return result.project.issues;
  });
  for (const issue of issues) {
    if (issue.project?.id !== projectId)
      throw new Error(
        "Linear returned an issue outside the authorized project",
      );
    if (!Number.isFinite(Date.parse(issue.updatedAt)))
      throw new Error("Issue source timestamp is invalid");
    const owner = { type: "issue", id: issue.id };
    issue.labels = await completeNested(
      query,
      owner,
      "labels",
      "id name color",
      50,
      issue.labels,
    );
    issue.relations = await completeNested(
      query,
      owner,
      "relations",
      "id type relatedIssue { id identifier }",
      50,
      issue.relations,
    );
    issue.inverseRelations = await completeNested(
      query,
      owner,
      "inverseRelations",
      "id type issue { id identifier }",
      50,
      issue.inverseRelations,
    );
  }
  return {
    schema: "buzz.linear-project-snapshot.v1",
    source: {
      provider: "linear",
      organizationId: organization.id,
      workspace,
      projectId,
    },
    startedAt,
    completedAt: now().toISOString(),
    // Complete enumeration, not a transactionally consistent Linear database snapshot.
    complete: true,
    project,
    issues,
  };
}

/** The managed CLI owns authentication/profile selection and API rate handling. */
export function linearQueryThroughCli(
  profile,
  execute = execFileAsync,
  { signal } = {},
) {
  if (!/^[a-z0-9_-]+$/i.test(profile ?? ""))
    throw new Error("An explicit el-linear profile is required");
  return async (query, variables) => {
    signal?.throwIfAborted();
    let stdout;
    try {
      ({ stdout } = await execute(
        "el-linear",
        [
          "--profile",
          profile,
          "graphql",
          query,
          "--variables",
          JSON.stringify(variables),
        ],
        {
          timeout: 90_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, EL_CLI_UPDATE_WAIT: "1" },
          signal,
        },
      ));
    } catch {
      signal?.throwIfAborted();
      throw new Error(
        "el-linear source read failed; no complete observation produced",
      );
    }
    let envelope;
    try {
      envelope = JSON.parse(stdout);
    } catch {
      throw new Error(
        "el-linear returned invalid JSON; no complete observation produced",
      );
    }
    if (envelope.error || envelope.errors?.length)
      throw new Error("el-linear returned an API error");
    const data = envelope.data ?? envelope;
    if (data.errors?.length) throw new Error("Linear returned GraphQL errors");
    return data;
  };
}

/** Preserve the previous complete input if a read or atomic replacement fails. */
export async function writeSnapshot(path, snapshot) {
  // The CLI signs these exact bytes; keep the outbox content contract canonical.
  const text = JSON.stringify(snapshot);
  if (Buffer.byteLength(text) > 64 * 1024 * 1024)
    throw new Error("Snapshot exceeds 64 MiB");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function main() {
  const [profile, workspace, projectId, output, ...extra] =
    process.argv.slice(2);
  if (!output || extra.length)
    throw new Error(
      "Usage: node scripts/linear-project-snapshot.mjs PROFILE WORKSPACE PROJECT_UUID OUTPUT.json",
    );
  const snapshot = await readLinearProjectSnapshot({
    query: linearQueryThroughCli(profile),
    workspace,
    projectId,
  });
  await writeSnapshot(resolve(output), snapshot);
  console.log(
    JSON.stringify({
      source: snapshot.source,
      issues: snapshot.issues.length,
      completedAt: snapshot.completedAt,
      output: resolve(output),
    }),
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
