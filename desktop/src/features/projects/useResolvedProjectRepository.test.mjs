import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("cold-start implicit URLs resolve without remounting and follow community origin; explicit URLs remain intact", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { renderHook, act } = await import("@testing-library/react");
  const { beginRelayOriginFetch, resetMediaCaches } = await import(
    "../../shared/lib/mediaUrl.ts"
  );
  const { eventToRepository } = await import("./projectModels.ts");
  const { useResolvedProjectRepository } = await import(
    "./useResolvedProjectRepository.ts"
  );
  resetMediaCaches();
  const owner =
    "925e24ee5ad0c04551ccd70bfec01a91b6da9603df9f5437b42df674eb3e5ceb";
  const event = {
    kind: 30617,
    pubkey: owner,
    created_at: 1,
    content: "",
    tags: [
      ["d", "normal-review-proof"],
      ["name", "Normal Review Proof"],
    ],
  };
  const repository = eventToRepository(event, null);
  assert.deepEqual(repository.cloneUrls, []);
  const { result, rerender, unmount } = renderHook(
    useResolvedProjectRepository,
    { initialProps: repository },
  );
  try {
    assert.deepEqual(result.current.cloneUrls, []);
    act(() => beginRelayOriginFetch()("https://buzz-pilot.enrichlayer.com"));
    assert.deepEqual(result.current.cloneUrls, [
      `https://buzz-pilot.enrichlayer.com/git/${owner}/normal-review-proof`,
    ]);
    const derived = result.current;
    rerender(derived);
    act(() => resetMediaCaches());
    assert.deepEqual(result.current.cloneUrls, []);
    act(() => beginRelayOriginFetch()("https://another.example"));
    assert.deepEqual(result.current.cloneUrls, [
      `https://another.example/git/${owner}/normal-review-proof`,
    ]);
    const external = eventToRepository(
      {
        ...event,
        tags: [...event.tags, ["clone", "https://github.com/example/repo.git"]],
      },
      null,
    );
    rerender(external);
    assert.equal(result.current, external);
    act(() => resetMediaCaches());
    assert.equal(result.current, external);
  } finally {
    unmount();
    resetMediaCaches();
    dom.window.close();
  }
});
