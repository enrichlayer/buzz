import assert from "node:assert/strict";
import test from "node:test";
import {
  readViewedFiles,
  writeViewedFile,
  viewedFilesStorageKey,
} from "./reviewViewedFiles.ts";
function storage() {
  const data = new Map();
  return {
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v),
  };
}
test("viewed files survive reads but never cross identity/community/review/revision scope", () => {
  const store = storage();
  writeViewedFile(store, "community:viewer:review:revision", "a.ts", true);
  assert.deepEqual(readViewedFiles(store, "community:viewer:review:revision"), [
    "a.ts",
  ]);
  for (const scope of [
    "other:viewer:review:revision",
    "community:other:review:revision",
    "community:viewer:other:revision",
    "community:viewer:review:other",
  ])
    assert.deepEqual(readViewedFiles(store, scope), []);
  writeViewedFile(store, "community:viewer:review:revision", "a.ts", false);
  assert.deepEqual(
    readViewedFiles(store, "community:viewer:review:revision"),
    [],
  );
});
test("writes reread the durable snapshot and retain other files and reviews", () => {
  const store = storage();
  writeViewedFile(store, "one", "a.ts", true);
  writeViewedFile(store, "two", "b.ts", true);
  writeViewedFile(store, "one", "c.ts", true);
  assert.deepEqual(readViewedFiles(store, "one"), ["a.ts", "c.ts"]);
  assert.deepEqual(readViewedFiles(store, "two"), ["b.ts"]);
});
test("failed writes propagate and preserve saved progress", () => {
  const store = storage();
  writeViewedFile(store, "one", "a.ts", true);
  assert.throws(
    () =>
      writeViewedFile(
        {
          ...store,
          setItem: () => {
            throw new Error("quota");
          },
        },
        "one",
        "b.ts",
        true,
      ),
    /quota/,
  );
  assert.deepEqual(readViewedFiles(store, "one"), ["a.ts"]);
});
test("corrupt progress is preserved and reports an error", () => {
  const store = storage();
  store.setItem(viewedFilesStorageKey, "broken");
  assert.throws(() => writeViewedFile(store, "one", "a.ts", true));
  assert.equal(store.getItem(viewedFilesStorageKey), "broken");
});
test("review history is bounded", () => {
  const store = storage();
  for (let i = 0; i < 55; i++) writeViewedFile(store, String(i), "a.ts", true);
  assert.deepEqual(readViewedFiles(store, "0"), []);
  assert.deepEqual(readViewedFiles(store, "54"), ["a.ts"]);
  assert.equal(JSON.parse(store.getItem(viewedFilesStorageKey)).length, 50);
});
