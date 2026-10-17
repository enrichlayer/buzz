import type { ProjectRepoDiffFile } from "@/shared/api/types";

export type DiffRow = {
  content: string;
  key: string;
  newLine: number | null;
  oldLine: number | null;
  type: "add" | "context" | "delete" | "hunk" | "meta";
};

/** Parse only hunk bodies; metadata must never create a commentable line. */
export function diffRows(file: ProjectRepoDiffFile): DiffRow[] {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const rows: DiffRow[] = [];
  for (const [index, line] of file.patch.split("\n").entries()) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    const key = `${file.path}:${index}`;
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      rows.push({
        key,
        content: line,
        oldLine: null,
        newLine: null,
        type: "hunk",
      });
    } else if (inHunk && line.startsWith("+")) {
      rows.push({
        key,
        content: line.slice(1),
        oldLine: null,
        newLine: newLine++,
        type: "add",
      });
    } else if (inHunk && line.startsWith("-")) {
      rows.push({
        key,
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: null,
        type: "delete",
      });
    } else if (inHunk && line.startsWith(" ")) {
      rows.push({
        key,
        content: line.slice(1),
        oldLine: oldLine++,
        newLine: newLine++,
        type: "context",
      });
    } else if (inHunk && line.startsWith("\\")) {
      rows.push({
        key,
        content: line,
        oldLine: null,
        newLine: null,
        type: "meta",
      });
    }
  }
  return rows;
}

/** Pair replacement blocks by position, preserving unequal sides and hunk boundaries. */
export function splitDiffRows(
  rows: DiffRow[],
): { old: DiffRow | null; next: DiffRow | null }[] {
  const result: { old: DiffRow | null; next: DiffRow | null }[] = [];
  let removed: DiffRow[] = [];
  let added: DiffRow[] = [];
  const flush = () => {
    for (
      let index = 0;
      index < Math.max(removed.length, added.length);
      index++
    ) {
      result.push({ old: removed[index] ?? null, next: added[index] ?? null });
    }
    removed = [];
    added = [];
  };
  for (const row of rows) {
    if (row.type === "delete") {
      if (added.length) flush();
      removed.push(row);
    } else if (row.type === "add") added.push(row);
    else {
      flush();
      result.push({ old: row, next: row.type === "context" ? row : null });
    }
  }
  flush();
  return result;
}

/** Literal, case-insensitive, line-level matches across the loaded diff. */
export function searchDiff(files: ProjectRepoDiffFile[], query: string) {
  const needle = query.toLowerCase();
  if (!needle) return [];
  return files.flatMap((file) =>
    diffRows(file)
      .filter(
        (row) =>
          (row.oldLine !== null || row.newLine !== null) &&
          row.content.toLowerCase().includes(needle),
      )
      .map((row) => ({
        path: file.path,
        rowKey: row.key,
        side: row.type === "delete" ? ("old" as const) : ("new" as const),
        line: (row.type === "delete" ? row.oldLine : row.newLine) as number,
      })),
  );
}
