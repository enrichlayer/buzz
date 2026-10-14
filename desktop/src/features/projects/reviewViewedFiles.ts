const STORAGE_KEY = "buzz-review-viewed-v1";
const MAX_REVIEWS = 50;
const MAX_FILES = 2000;
type Entry = { scope: string; paths: string[] };

function readEntries(storage: Pick<Storage, "getItem">): Entry[] {
  const raw = storage.getItem(STORAGE_KEY);
  if (!raw) return [];
  if (raw.length > 4_000_000)
    throw new Error("Saved review progress is too large.");
  const entries: unknown = JSON.parse(raw);
  if (
    !Array.isArray(entries) ||
    entries.length > MAX_REVIEWS ||
    entries.some(
      (entry) =>
        !entry ||
        typeof entry.scope !== "string" ||
        !Array.isArray(entry.paths) ||
        entry.paths.length > MAX_FILES ||
        entry.paths.some((path: unknown) => typeof path !== "string"),
    )
  ) {
    throw new Error("Saved review progress is invalid.");
  }
  return entries;
}

/** Read progress for one identity/community/review/revision; invalid data is not overwritten. */
export function readViewedFiles(
  storage: Pick<Storage, "getItem">,
  scope: string,
): string[] {
  return (
    readEntries(storage).find((entry) => entry.scope === scope)?.paths ?? []
  );
}

/** A single synchronous snapshot write; re-read durable state to preserve other review updates. */
export function writeViewedFile(
  storage: Pick<Storage, "getItem" | "setItem">,
  scope: string,
  path: string,
  viewed: boolean,
) {
  const entries = readEntries(storage);
  const paths = new Set(
    entries.find((entry) => entry.scope === scope)?.paths ?? [],
  );
  if (viewed) paths.add(path);
  else paths.delete(path);
  if (paths.size > MAX_FILES)
    throw new Error("This review has too many viewed files.");
  const next = [
    ...entries.filter((entry) => entry.scope !== scope),
    { scope, paths: [...paths] },
  ].slice(-MAX_REVIEWS);
  const value = JSON.stringify(next);
  if (value.length > 4_000_000)
    throw new Error("Saved review progress is full.");
  storage.setItem(STORAGE_KEY, value);
}

export const viewedFilesStorageKey = STORAGE_KEY;
