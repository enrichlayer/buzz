import * as React from "react";
import type { ProjectRepoDiff } from "@/shared/api/types";
import {
  readViewedFiles,
  viewedFilesStorageKey,
  writeViewedFile,
} from "./reviewViewedFiles";

/** Local-only progress, invalidated by any change to the actual diff, including a moved base. */
export function useViewedReviewFiles(
  reviewScope: string | undefined,
  diff: ProjectRepoDiff | null | undefined,
) {
  const [revision, setRevision] = React.useState<{
    diff: ProjectRepoDiff;
    value: string;
  } | null>(null);
  const [writeError, setWriteError] = React.useState<string | null>(null);
  const [, refresh] = React.useReducer((value) => value + 1, 0);
  React.useEffect(() => {
    let current = true;
    if (diff) {
      const bytes = new TextEncoder().encode(JSON.stringify(diff.files));
      void crypto.subtle
        .digest("SHA-256", bytes)
        .then((hash) => {
          if (current)
            setRevision({
              diff,
              value: Array.from(new Uint8Array(hash), (byte) =>
                byte.toString(16).padStart(2, "0"),
              ).join(""),
            });
        })
        .catch(() => {
          if (current)
            setWriteError(
              "Could not identify this diff. Reload to save review progress.",
            );
        });
    }
    return () => {
      current = false;
    };
  }, [diff]);
  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === viewedFilesStorageKey || event.key === null) refresh();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  const scope =
    reviewScope && revision && revision.diff === diff
      ? JSON.stringify([reviewScope, revision.value])
      : null;
  const saved = (() => {
    try {
      return {
        paths: new Set(scope ? readViewedFiles(localStorage, scope) : []),
        error: null,
      };
    } catch {
      return {
        paths: new Set<string>(),
        error:
          "Could not read saved review progress. Clear saved progress to retry.",
      };
    }
  })();
  return {
    paths: saved.paths,
    enabled: Boolean(scope),
    error: saved.error ?? writeError,
    clear: () => {
      try {
        localStorage.removeItem(viewedFilesStorageKey);
        setWriteError(null);
        refresh();
      } catch {
        setWriteError(
          "Could not clear saved review progress. Check storage access and retry.",
        );
      }
    },
    toggle: (path: string, viewed: boolean) => {
      if (!scope) return;
      try {
        writeViewedFile(localStorage, scope, path, viewed);
        setWriteError(null);
        refresh();
      } catch (error) {
        setWriteError(
          error instanceof Error
            ? error.message
            : "Could not save review progress. Try again.",
        );
      }
    },
  };
}
