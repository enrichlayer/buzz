import { sameLinearProject, type LinearWorkRecord } from "./linearWorkModels";

export function linearProjectKey(record: LinearWorkRecord): string {
  return [
    record.channelId,
    record.publisher,
    record.source.organizationId,
    record.source.projectId,
  ].join(":");
}

/** The project receipt is published after all tasks in a complete observation. */
export function linearSyncStatus(
  record: LinearWorkRecord,
  records: readonly LinearWorkRecord[],
): { completeAt: string | null; partial: boolean } {
  const project = records.find(
    (candidate) =>
      candidate.type === "project" && sameLinearProject(candidate, record),
  );
  const completeAt = project?.observedAt ?? null;
  return {
    completeAt,
    partial:
      !completeAt ||
      records.some(
        (candidate) =>
          candidate.type === "issue" &&
          sameLinearProject(candidate, record) &&
          Date.parse(candidate.observedAt) > Date.parse(completeAt),
      ),
  };
}
