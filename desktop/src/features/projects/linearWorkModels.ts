import type { RelayEvent } from "@/shared/api/types";

export const KIND_LINEAR_PROJECT = 30623;
export const KIND_LINEAR_TASK = 30624;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HEX = /^[a-f0-9]{64}$/;
type NamedSource = { id: string; name: string };
export type LinearSource = {
  provider: "linear";
  organizationId: string;
  workspace: string;
  projectId: string;
};
export type LinearWorkRecord = {
  address: string;
  eventId: string;
  publisher: string;
  channelId: string;
  source: LinearSource;
  type: "project" | "issue";
  sourceId: string;
  title: string;
  description: string;
  url: string | null;
  updatedAt: string;
  observedAt: string;
  identifier: string | null;
  archived: boolean;
  retired: boolean;
  state: { name: string; type: string } | null;
  team: NamedSource | null;
  assignee: NamedSource | null;
  milestone: NamedSource | null;
  cycle: NamedSource | null;
  labels: NamedSource[];
  teams: NamedSource[];
  milestones: NamedSource[];
  priority: number | null;
  parentId: string | null;
  relations: {
    id: string;
    identifier: string;
    type: string;
    inverse: boolean;
  }[];
  dueDate: string | null;
};

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function named(value: unknown): NamedSource | null {
  const entry = object(value);
  return entry &&
    typeof entry.id === "string" &&
    UUID.test(entry.id) &&
    typeof entry.name === "string"
    ? { id: entry.id, name: entry.name }
    : null;
}
function names(value: unknown): NamedSource[] {
  return Array.isArray(value)
    ? value.map(named).filter((entry): entry is NamedSource => entry !== null)
    : [];
}
function oneTag(event: RelayEvent, name: string): string | null {
  const matches = event.tags.filter((tag) => tag[0] === name);
  return matches.length === 1 && matches[0].length === 2 ? matches[0][1] : null;
}
function sourceUrl(value: unknown, workspace: string): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.host === "linear.app" &&
      !url.username &&
      !url.password &&
      url.pathname.startsWith(`/${workspace}/`)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Validate the full signed association before exposing copied source data. */
export function linearEventToWork(event: RelayEvent): LinearWorkRecord | null {
  if (
    ![KIND_LINEAR_PROJECT, KIND_LINEAR_TASK].includes(event.kind) ||
    !HEX.test(event.pubkey) ||
    new TextEncoder().encode(event.content).length > 128 * 1024
  )
    return null;
  try {
    const payload = object(JSON.parse(event.content));
    const source = object(payload?.source);
    const record = object(payload?.record);
    const channel = oneTag(event, "h");
    if (
      !payload ||
      !source ||
      !record ||
      !channel ||
      !UUID.test(channel) ||
      payload.schema !== "buzz.linear-record.v1" ||
      source.provider !== "linear"
    )
      return null;
    if (
      typeof source.organizationId !== "string" ||
      !UUID.test(source.organizationId) ||
      typeof source.projectId !== "string" ||
      !UUID.test(source.projectId) ||
      typeof source.workspace !== "string" ||
      !/^[a-z0-9-]{1,100}$/i.test(source.workspace) ||
      typeof record.id !== "string" ||
      !UUID.test(record.id)
    )
      return null;
    const type = event.kind === KIND_LINEAR_PROJECT ? "project" : "issue";
    if (
      payload.type !== type ||
      (type === "project"
        ? record.id !== source.projectId
        : object(record.project)?.id !== source.projectId)
    )
      return null;
    const dtag = `linear:${channel}:${source.organizationId}:${record.id}`;
    if (oneTag(event, "d") !== dtag || oneTag(event, "l") !== source.projectId)
      return null;
    if (
      typeof record.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(record.updatedAt)) ||
      typeof payload.observedAt !== "string" ||
      !Number.isFinite(Date.parse(payload.observedAt))
    )
      return null;
    const title = type === "project" ? record.name : record.title;
    if (typeof title !== "string" || !title.trim()) return null;
    const state = object(record.state);
    const parent = object(record.parent);
    return {
      address: `${event.kind}:${event.pubkey}:${dtag}`,
      eventId: event.id,
      publisher: event.pubkey,
      channelId: channel,
      source: source as LinearSource,
      type,
      sourceId: record.id,
      title,
      description: [
        record.description,
        ...(type === "project" ? [record.content] : []),
      ]
        .filter(
          (value): value is string =>
            typeof value === "string" && value.length > 0,
        )
        .join("\n\n"),
      url: sourceUrl(record.url, source.workspace),
      updatedAt: record.updatedAt,
      observedAt: payload.observedAt,
      identifier:
        typeof record.identifier === "string" ? record.identifier : null,
      archived: typeof record.archivedAt === "string",
      retired: record.retired === true,
      state:
        typeof record.state === "string"
          ? { name: record.state, type: record.state }
          : state &&
              typeof state.name === "string" &&
              typeof state.type === "string"
            ? { name: state.name, type: state.type }
            : null,
      team: named(record.team),
      assignee: named(record.assignee),
      milestone: named(record.projectMilestone),
      cycle: named(record.cycle),
      labels: names(record.labels),
      teams: names(record.teams),
      milestones: names(record.projectMilestones),
      priority: typeof record.priority === "number" ? record.priority : null,
      dueDate: typeof record.dueDate === "string" ? record.dueDate : null,
      relations: [false, true].flatMap((inverse) => {
        const values = inverse ? record.inverseRelations : record.relations;
        if (!Array.isArray(values)) return [];
        return values.flatMap((value) => {
          const relation = object(value);
          const target = object(
            inverse ? relation?.issue : relation?.relatedIssue,
          );
          return target &&
            typeof target.id === "string" &&
            UUID.test(target.id) &&
            typeof target.identifier === "string" &&
            typeof relation?.type === "string"
            ? [
                {
                  id: target.id,
                  identifier: target.identifier,
                  type: relation.type,
                  inverse,
                },
              ]
            : [];
        });
      }),
      parentId:
        typeof parent?.id === "string" && UUID.test(parent.id)
          ? parent.id
          : null,
    };
  } catch {
    return null;
  }
}

/** A source UUID can only join records from the same channel and publisher. */
export function sameLinearProject(
  a: LinearWorkRecord,
  b: LinearWorkRecord,
): boolean {
  return (
    a.channelId === b.channelId &&
    a.publisher === b.publisher &&
    a.source.organizationId === b.source.organizationId &&
    a.source.projectId === b.source.projectId
  );
}

export function linearWorkIsActive(task: LinearWorkRecord): boolean {
  return (
    !task.archived &&
    !task.retired &&
    !["completed", "canceled"].includes(task.state?.type ?? "")
  );
}
