import * as React from "react";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { Button } from "@/shared/ui/button";
import { Card } from "@/shared/ui/card";
import {
  linearWorkIsActive,
  sameLinearProject,
  type LinearWorkRecord,
} from "../linearWorkModels";
import { useLinearWork } from "../useLinearWork";

/** Planning records have no fake repository and keep their source workflow names. */
export function LinearWorkList({
  mode,
  searchQuery = "",
  project,
}: {
  mode: "projects" | "tasks";
  searchQuery?: string;
  project?: LinearWorkRecord;
}) {
  const query = useLinearWork();
  const { goProject } = useAppNavigation();
  const [includeCompleted, setIncludeCompleted] = React.useState(false);
  const [visibleCount, setVisibleCount] = React.useState(100);
  const [team, setTeam] = React.useState("");
  const [milestone, setMilestone] = React.useState("");
  // biome-ignore lint/correctness/useExhaustiveDependencies: changing any filter starts a new bounded page.
  React.useEffect(() => {
    setVisibleCount(100);
  }, [searchQuery, mode, includeCompleted, team, milestone, project?.address]);
  const all = query.isError ? [] : (query.data ?? []);
  const projects = all.filter(
    (record) => record.type === "project" && !record.retired,
  );
  const scoped = all.filter(
    (record) =>
      record.type === (mode === "tasks" ? "issue" : "project") &&
      !record.retired &&
      (!project || sameLinearProject(record, project)),
  );
  const teams = [
    ...new Map(
      scoped.flatMap((task) =>
        task.team ? [[task.team.id, task.team] as const] : [],
      ),
    ).values(),
  ];
  const milestones = [
    ...new Map(
      scoped.flatMap((task) =>
        task.milestone ? [[task.milestone.id, task.milestone] as const] : [],
      ),
    ).values(),
  ];
  const needle = searchQuery.trim().toLowerCase();
  const filtered = scoped.filter(
    (record) =>
      (includeCompleted ||
        (mode === "tasks" ? linearWorkIsActive(record) : !record.archived)) &&
      (!team || record.team?.id === team) &&
      (!milestone || record.milestone?.id === milestone) &&
      (!needle ||
        `${record.identifier ?? ""} ${record.title} ${record.description}`
          .toLowerCase()
          .includes(needle)),
  );
  if (query.isError)
    return (
      <div role="alert" className="space-y-2 p-4 text-sm">
        <p>
          Linear work could not be fully loaded. Private cached records are
          hidden until access is verified.
        </p>
        <Button
          onClick={() => void query.refetch()}
          disabled={query.isFetching}
          variant="outline"
        >
          Retry Linear work
        </Button>
      </div>
    );
  if (query.isLoading)
    return (
      <p role="status" className="p-4 text-sm text-muted-foreground">
        Loading Linear work…
      </p>
    );
  if (all.length === 0) return null;
  return (
    <section aria-label={`Linear ${mode}`} className="space-y-3 pb-4">
      <header className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">
          Linear {mode}{" "}
          <span className="text-muted-foreground">{filtered.length}</span>
        </h3>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeCompleted}
            onChange={(event) => setIncludeCompleted(event.target.checked)}
          />
          Include completed and archived
        </label>
        {mode === "tasks" && teams.length > 1 ? (
          <select
            aria-label="Filter Linear tasks by team"
            className="rounded-md border border-border bg-background p-2 text-xs"
            value={team}
            onChange={(event) => setTeam(event.target.value)}
          >
            <option value="">All teams</option>
            {teams.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
        {mode === "tasks" && milestones.length ? (
          <select
            aria-label="Filter Linear tasks by milestone"
            className="rounded-md border border-border bg-background p-2 text-xs"
            value={milestone}
            onChange={(event) => setMilestone(event.target.value)}
          >
            <option value="">All milestones</option>
            {milestones.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.name}
              </option>
            ))}
          </select>
        ) : null}
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          Refresh view
        </Button>
      </header>
      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No matching Linear {mode}.
        </p>
      ) : null}
      <div className="space-y-2">
        {filtered.slice(0, visibleCount).map((record) => {
          const sourceProject = projects.find((candidate) =>
            sameLinearProject(candidate, record),
          );
          return (
            <Card
              key={record.address}
              className="border-border/60 bg-transparent p-0 shadow-none"
            >
              <button
                type="button"
                className="flex w-full flex-col gap-1 rounded-md p-3 text-left hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => void goProject(record.address)}
              >
                <span className="text-sm font-medium">
                  {record.identifier ? (
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {record.identifier}
                    </span>
                  ) : null}
                  {record.title}
                </span>
                <span className="text-xs text-muted-foreground">
                  {[
                    record.state?.name,
                    record.team?.name,
                    record.milestone?.name,
                    mode === "tasks"
                      ? sourceProject?.title
                      : record.teams.map((entry) => entry.name).join(", "),
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </button>
            </Card>
          );
        })}
      </div>
      {filtered.length > visibleCount ? (
        <Button
          variant="outline"
          onClick={() => setVisibleCount((count) => count + 100)}
        >
          Show more ({filtered.length - visibleCount} remaining)
        </Button>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Planning state comes from Linear. Agent execution, review and CI are
        tracked separately.
      </p>
    </section>
  );
}
