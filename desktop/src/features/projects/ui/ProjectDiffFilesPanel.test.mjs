import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("an inline anchor survives initial and asynchronous diff selection, then permits manual navigation", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
    pretendToBeVisual: true,
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const React = await import("react");
  const { render, fireEvent, cleanup } = await import("@testing-library/react");
  const { ProjectDiffFilesPanel } = await import(
    "./ProjectPullRequestFilesChangedPanel.tsx"
  );
  const files = ["price.ts", "receipt.ts"].map((path) => ({
    path: `src/${path}`,
    additions: 1,
    deletions: 1,
    truncated: false,
    patch: `diff --git a/src/${path} b/src/${path}\n--- a/src/${path}\n+++ b/src/${path}\n@@ -1 +1 @@\n-old\n+new\n`,
  }));
  const props = {
    reviewScope: "regression",
    error: null,
    isLoading: false,
    headerLabel: "Review",
    subjectLabel: "Test",
    focusedAnchor: { path: "src/receipt.ts", side: "new", line: 1 },
    diff: { files, additions: 2, deletions: 2 },
  };
  try {
    for (const delayed of [false, true]) {
      const ui = render(
        React.createElement(
          ProjectDiffFilesPanel,
          delayed ? { ...props, diff: null, isLoading: true } : props,
        ),
      );
      if (delayed)
        ui.rerender(React.createElement(ProjectDiffFilesPanel, props));
      assert.ok(
        ui.getByRole("checkbox", { name: "Mark src/receipt.ts viewed" }),
      );
      fireEvent.click(ui.getByRole("button", { name: "price.ts" }));
      assert.ok(ui.getByRole("checkbox", { name: "Mark src/price.ts viewed" }));
      ui.rerender(
        React.createElement(ProjectDiffFilesPanel, {
          ...props,
          diff: { ...props.diff, files: [...files] },
        }),
      );
      assert.ok(ui.getByRole("checkbox", { name: "Mark src/price.ts viewed" }));
      ui.unmount();
    }
  } finally {
    cleanup();
    dom.window.close();
  }
});
