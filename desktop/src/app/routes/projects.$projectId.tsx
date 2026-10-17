import * as React from "react";
import { createFileRoute, useLocation } from "@tanstack/react-router";

import { parseProjectDetailSearch } from "@/features/projects/lib/projectDetailSearch";
import { usePreviewFeatureWarning } from "@/shared/features";
import { ViewLoadingFallback } from "@/shared/ui/ViewLoadingFallback";

const ProjectDetailScreen = React.lazy(async () => {
  const module = await import("@/features/projects/ui/ProjectDetailScreen");
  return { default: module.ProjectDetailScreen };
});

const LinearWorkScreen = React.lazy(async () => {
  const module = await import("@/features/projects/ui/LinearWorkScreen");
  return { default: module.LinearWorkScreen };
});

export const Route = createFileRoute("/projects/$projectId")({
  component: ProjectDetailRouteComponent,
  validateSearch: parseProjectDetailSearch,
});

function ProjectDetailRouteComponent() {
  usePreviewFeatureWarning("projects");
  const { projectId } = Route.useParams();
  const { commitHash, filePath, pullRequestId, issueId, repositoryId, tab } =
    Route.useSearch();
  const entityNavigationId = useLocation({
    select: (location) => {
      const value = (
        location.state as { entityNavigationId?: unknown } | undefined
      )?.entityNavigationId;
      return typeof value === "string" ? value : undefined;
    },
  });

  return (
    <React.Suspense fallback={<ViewLoadingFallback kind="projects" />}>
      {/^(30623|30624):/.test(projectId) ? (
        <LinearWorkScreen key={projectId} address={projectId} />
      ) : (
        <ProjectDetailScreen
          commitHash={commitHash}
          entityNavigationId={entityNavigationId}
          filePath={filePath}
          issueId={issueId}
          projectId={projectId}
          pullRequestId={pullRequestId}
          repositoryId={repositoryId}
          tab={tab}
        />
      )}
    </React.Suspense>
  );
}
