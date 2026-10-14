import assert from "node:assert/strict";
import { after, afterEach, before, test } from "node:test";

import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

before(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
    window: dom.window,
  });
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

after(() => dom.window.close());

const REPO_A = {
  branchOptions: ["main", "release"],
  defaultBranch: "main",
  projectAvailable: true,
  projectPending: false,
  repositoryId: "30617:owner:repo-a",
  tags: [{ name: "v1" }],
};

const REPO_B = {
  branchOptions: ["trunk", "release"],
  defaultBranch: "trunk",
  projectAvailable: true,
  projectPending: false,
  repositoryId: "30617:owner:repo-b",
  tags: [{ name: "v1" }],
};

async function renderSelection(initialProps) {
  const { act, renderHook } = await import("@testing-library/react");
  const rendered = renderHook(
    (props) => {
      const { useProjectRepositoryRefSelection } = hookModule;
      return useProjectRepositoryRefSelection(props);
    },
    { initialProps },
  );
  return { act, ...rendered };
}

let hookModule;
before(async () => {
  hookModule = await import("./useProjectRepositoryRefSelection.ts");
});

test("a repository switch resets a same-named branch selection to the new default", async () => {
  const { act, rerender, result } = await renderSelection(REPO_A);

  act(() => result.current.selectBranch("release"));
  assert.equal(result.current.activeBranch, "release");

  // Repo B also has a `release` branch — it must NOT survive the switch.
  rerender(REPO_B);
  assert.equal(result.current.activeBranch, "trunk");
  assert.equal(result.current.selectedTag, null);
});

test("a repository switch resets a same-named tag selection", async () => {
  const { act, rerender, result } = await renderSelection(REPO_A);

  act(() => result.current.selectTag("v1"));
  assert.equal(result.current.selectedTag, "v1");

  // Repo B also has a `v1` tag — it must NOT survive the switch.
  rerender(REPO_B);
  assert.equal(result.current.selectedTag, null);
  assert.equal(result.current.activeBranch, "trunk");
});

test("selections survive option refreshes within the same repository", async () => {
  const { act, rerender, result } = await renderSelection(REPO_A);

  act(() => result.current.selectBranch("release"));
  act(() => result.current.selectTag("v1"));

  // Same repository, new option arrays (a refetch) — selection is kept.
  rerender({ ...REPO_A, branchOptions: ["main", "release", "feature"] });
  assert.equal(result.current.activeBranch, "release");
  assert.equal(result.current.selectedTag, "v1");
});

test("an unpublished local branch survives remote-only option refreshes", async () => {
  const { act, rerender, result } = await renderSelection(REPO_A);
  act(() => result.current.selectBranch("local-review"));
  rerender({ ...REPO_A, branchOptions: ["main", "release"] });
  assert.equal(result.current.activeBranch, "local-review");
  rerender(REPO_B);
  assert.equal(result.current.activeBranch, "trunk");
});

async function renderSource(initialProps) {
  const React = await import("react");
  const { renderHook } = await import("@testing-library/react");
  const { useReconcileProjectRepositorySource } = await import(
    "./useReconcileProjectRepositorySource.ts"
  );
  return renderHook(
    (props) => {
      const [source, setSource] = React.useState(props.initialSource);
      useReconcileProjectRepositorySource({ ...props, source, setSource });
      return source;
    },
    { initialProps },
  );
}

const LOCAL_SOURCE = {
  initialSource: "local",
  hasLocalCheckout: true,
  localCheckoutPending: false,
  remoteHasContent: true,
  selectedPullRequestId: null,
  selectedTag: null,
};

test("local source survives branch query loading but resets for a missing checkout", async () => {
  const { rerender, result } = await renderSource(LOCAL_SOURCE);
  rerender({
    ...LOCAL_SOURCE,
    hasLocalCheckout: false,
    localCheckoutPending: true,
  });
  assert.equal(result.current, "local");
  rerender(LOCAL_SOURCE);
  assert.equal(result.current, "local");
  rerender({ ...LOCAL_SOURCE, hasLocalCheckout: false });
  assert.equal(result.current, "remote");
});

test("tag selection still uses remote data while local queries are pending", async () => {
  const { result } = await renderSource({
    ...LOCAL_SOURCE,
    hasLocalCheckout: false,
    localCheckoutPending: true,
    selectedTag: "v1",
  });
  assert.equal(result.current, "remote");
});

test("an empty remote still selects a discovered checkout", async () => {
  const { result } = await renderSource({
    ...LOCAL_SOURCE,
    initialSource: "remote",
    remoteHasContent: false,
  });
  assert.equal(result.current, "local");
});
