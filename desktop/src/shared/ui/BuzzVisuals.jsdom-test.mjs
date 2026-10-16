import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import { BUZZ_ICON_NAMES, BuzzActivity, BuzzIcon } from "@el/buzz-ui";
import { BuzzLoadingState } from "./BuzzLoadingState.tsx";
import { ImportStatusIcon } from "./import-status-icon.tsx";

afterEach(cleanup);

test("icons leave control labels to their host and support standalone names", () => {
  const view = render(
    createElement(
      "div",
      null,
      ...BUZZ_ICON_NAMES.map((name) =>
        createElement(BuzzIcon, { name, key: name }),
      ),
      createElement(BuzzIcon, { name: "bee", label: "el-buzz", width: 32 }),
    ),
  );
  assert.equal(view.getAllByRole("img").length, 1);
  assert.equal(
    view.getByRole("img", { name: "el-buzz" }).getAttribute("width"),
    "32",
  );
  assert.equal(
    view.container.querySelectorAll('svg[aria-hidden="true"]').length,
    12,
  );
});

test("page and import loading have one accessible status and no nested image", () => {
  const view = render(
    createElement(BuzzLoadingState, { label: "Loading projects" }),
  );
  assert.equal(view.getAllByRole("status").length, 1);
  assert.ok(view.getByRole("status", { name: "Loading projects" }));
  assert.equal(view.queryByRole("img"), null);
  view.rerender(createElement(ImportStatusIcon, { status: "importing" }));
  assert.ok(view.getByRole("status", { name: "Importing" }));
  view.rerender(createElement(ImportStatusIcon, { status: "done" }));
  assert.equal(view.queryByRole("status"), null);
});

test("decorative activity adds no status announcement", () => {
  const view = render(
    createElement(BuzzActivity, { decorative: true, variant: "transfer" }),
  );
  assert.equal(view.queryByRole("status"), null);
});

test("activity pauses outside the viewport and in background tabs, then cleans up", () => {
  let notify;
  let disconnected = false;
  const originalObserver = globalThis.IntersectionObserver;
  const originalHidden = Object.getOwnPropertyDescriptor(document, "hidden");
  globalThis.IntersectionObserver = class {
    constructor(callback) {
      notify = callback;
    }
    observe() {}
    disconnect() {
      disconnected = true;
    }
  };
  Object.defineProperty(document, "hidden", {
    configurable: true,
    value: false,
  });
  try {
    const view = render(createElement(BuzzActivity));
    const status = view.getByRole("status");
    assert.equal(status.dataset.running, "true");
    act(() => notify([{ isIntersecting: false }]));
    assert.equal(status.dataset.running, "false");
    act(() => notify([{ isIntersecting: true }]));
    assert.equal(status.dataset.running, "true");
    act(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal(status.dataset.running, "false");
    view.unmount();
    assert.equal(disconnected, true);
  } finally {
    globalThis.IntersectionObserver = originalObserver;
    if (originalHidden)
      Object.defineProperty(document, "hidden", originalHidden);
    else delete document.hidden;
  }
});
