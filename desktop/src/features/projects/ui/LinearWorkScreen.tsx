import { toast } from "sonner";
import * as React from "react";
import { useAppNavigation } from "@/app/navigation/useAppNavigation";
import { useChannelsQuery } from "@/features/channels/hooks";
import { Button } from "@/shared/ui/button";
import { openUrl } from "@tauri-apps/plugin-opener";
import { linearWorkLinkFromAddress } from "@/shared/lib/linearWorkLink";
import { sameLinearProject } from "../linearWorkModels";
import { useLinearWork } from "../useLinearWork";
import type { ProjectDetailAgentContext } from "../lib/projectDetailAgentContext";
import { ProjectAgentChatPanel } from "./ProjectAgentChatPanel";
import { ProjectRichContent } from "./ProjectRichContent";
import { LinearTaskThreads } from "./LinearTaskThreads";
import { LinearTaskReviews } from "./LinearTaskReviews";
import { LinearWorkList } from "./LinearWorkList";

/** A planning task remains usable before selecting a code repository. */
export function LinearWorkScreen({ address }: { address: string }) {
  const query = useLinearWork();
  const channels = useChannelsQuery();
  const { goProject } = useAppNavigation();
  const [workOpen, setWorkOpen] = React.useState(false);
  const records = query.isError ? [] : (query.data ?? []);
  const record = records.find((item) => item.address === address);
  const project =
    record &&
    records.find(
      (item) => item.type === "project" && sameLinearProject(item, record),
    );
  const related = record
    ? records.filter(
        (item) =>
          item.type === "issue" &&
          sameLinearProject(item, record) &&
          (item.sourceId === record.parentId ||
            item.parentId === record.sourceId ||
            record.relations.some((relation) => relation.id === item.sourceId)),
      )
    : [];
  const homeChannel = channels.data?.find(
    (channel) => channel.id === record?.channelId,
  );
  const context: ProjectDetailAgentContext | null = record
    ? {
        linearTask:
          record.type === "issue" && record.url
            ? { address: record.address, url: record.url }
            : undefined,
        projectName: project?.title ?? record.title,
        repoAddress: record.address,
        repositoryName: "Repository not selected",
        source: "remote",
        view: record.type === "issue" ? "Linear task" : "Linear project",
        workItem: {
          id: record.address,
          kind: "task",
          title: record.title,
          status: record.state?.name,
          description: record.description,
          shareLink: linearWorkLinkFromAddress(record.address),
        },
      }
    : null;
  if (query.isLoading)
    return (
      <p role="status" className="p-6 text-sm">
        Loading Linear work…
      </p>
    );
  if (query.isError || !record || !context)
    return (
      <div role="alert" className="space-y-3 p-6">
        <p>
          This Linear record is unavailable in the current community and
          identity.
        </p>
        <Button onClick={() => void query.refetch()} variant="outline">
          Retry
        </Button>
      </div>
    );
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6">
      <div className="mx-auto w-full max-w-5xl space-y-6">
        <header className="space-y-3">
          {record.type === "issue" && project ? (
            <Button
              variant="ghost"
              onClick={() => void goProject(project.address)}
            >
              {project.title}
            </Button>
          ) : null}
          <p className="font-mono text-xs text-muted-foreground">
            {record.identifier ?? "Linear project"}
          </p>
          <h1 className="text-xl font-semibold">{record.title}</h1>
          <p className="text-sm text-muted-foreground">
            {[
              record.state?.name,
              record.team?.name,
              record.milestone?.name,
              record.assignee?.name,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <p className="text-xs text-muted-foreground">
            {[
              record.priority
                ? ["", "Urgent", "High", "Medium", "Low"][record.priority]
                : null,
              record.cycle?.name,
              record.dueDate ? `Due ${record.dueDate}` : null,
              ...record.labels.map((label) => label.name),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          <div className="flex flex-wrap gap-2">
            {record.url ? (
              <Button
                variant="outline"
                onClick={() => {
                  if (record.url)
                    void openUrl(record.url).catch(() =>
                      toast.error("Could not open the Linear source."),
                    );
                }}
              >
                Open in Linear
              </Button>
            ) : null}
            {record.type === "issue" && !record.retired ? (
              <Button
                disabled={!homeChannel}
                onClick={() => setWorkOpen((value) => !value)}
              >
                {workOpen ? "Hide agent work" : "Work on this task"}
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Source updated {new Date(record.updatedAt).toLocaleString()}. Last
            mirrored {new Date(record.observedAt).toLocaleString()}. Planning
            changes are made in Linear.
          </p>
          {record.retired ? (
            <p role="status" className="text-sm">
              This issue is no longer visible in the mirrored project. Its prior
              work remains linked; this does not establish deletion in Linear.
            </p>
          ) : null}
        </header>
        <section
          aria-label="Description"
          className="rounded-md border border-border p-4"
        >
          <ProjectRichContent
            content={record.description || "No description provided."}
          />
        </section>
        {related.length ? (
          <section aria-label="Related tasks" className="space-y-2">
            <h2 className="text-base font-semibold">Related tasks</h2>
            {related.map((item) => {
              const relation = record.relations.find(
                (entry) => entry.id === item.sourceId,
              );
              const label =
                item.sourceId === record.parentId
                  ? "Parent"
                  : item.parentId === record.sourceId
                    ? "Subtask"
                    : relation?.type === "blocks" && relation.inverse
                      ? "Blocked by"
                      : (relation?.type ?? "Related");
              return (
                <Button
                  key={item.address}
                  variant="outline"
                  className="h-auto w-full justify-start whitespace-normal p-3 text-left"
                  onClick={() => void goProject(item.address)}
                >
                  {label} · {item.identifier} · {item.title}
                </Button>
              );
            })}
          </section>
        ) : null}
        {record.type === "project" ? (
          <LinearWorkList mode="tasks" project={record} />
        ) : (
          <>
            <section aria-label="Agent work" className="space-y-3">
              <h2 className="text-base font-semibold">Agent work</h2>
              <LinearTaskThreads
                address={record.address}
                channelId={record.channelId}
              />
              {workOpen && homeChannel ? (
                <div className="flex min-h-96 flex-col rounded-md border border-border">
                  <p className="p-3 text-xs text-muted-foreground">
                    Your selected agent will join this private project channel,
                    where it can read the mirrored tasks. Its conversation
                    starts with this task’s description and context.
                  </p>
                  <ProjectAgentChatPanel
                    context={context}
                    homeChannel={homeChannel}
                    layout="canvas"
                  />
                </div>
              ) : null}
            </section>
            <LinearTaskReviews address={record.address} />
          </>
        )}
      </div>
    </div>
  );
}
