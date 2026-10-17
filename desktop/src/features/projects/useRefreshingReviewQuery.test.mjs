import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("an open review refreshes other users' changes, pauses on blur and stops on unmount", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  let focused = true;
  dom.window.document.hasFocus = () => focused;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const React = await import("react");
  const { renderHook, waitFor, act } = await import("@testing-library/react");
  const { QueryClient, QueryClientProvider } = await import(
    "@tanstack/react-query"
  );
  const { useRefreshingReviewQuery } = await import(
    "./useRefreshingReviewQuery.ts"
  );
  const client = new QueryClient({
    defaultOptions: { queries: { gcTime: Infinity, retry: false } },
  });
  let remote = { comments: [], resolved: false };
  let fetches = 0;
  const { result, unmount } = renderHook(
    () =>
      useRefreshingReviewQuery({
        queryKey: ["project", "repo", "pull-requests"],
        queryFn: async () => {
          fetches++;
          return remote;
        },
        staleTime: 30_000,
      }),
    {
      wrapper: ({ children }) =>
        React.createElement(QueryClientProvider, { client }, children),
    },
  );
  try {
    await waitFor(() => assert.deepEqual(result.current.data, remote));
    remote = { comments: ["Other user's reply"], resolved: true };
    await waitFor(() => assert.deepEqual(result.current.data, remote), {
      timeout: 8_000,
    });
    act(() => {
      focused = false;
      window.dispatchEvent(new window.Event("blur"));
    });
    const blurredFetches = fetches;
    remote = { comments: ["Other user's reply"], resolved: false };
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    assert.equal(fetches, blurredFetches);
    act(() => {
      focused = true;
      window.dispatchEvent(new window.Event("focus"));
    });
    await waitFor(() => assert.deepEqual(result.current.data, remote), {
      timeout: 8_000,
    });
    unmount();
    const unmountedFetches = fetches;
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    assert.equal(fetches, unmountedFetches);
  } finally {
    unmount();
    client.clear();
    dom.window.close();
  }
});
