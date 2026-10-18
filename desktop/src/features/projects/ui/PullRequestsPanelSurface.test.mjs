import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PullRequestsPanelSurface } from "./PullRequestsPanelSurface.tsx";

test("refresh completeness errors remain visible beside retained review detail and list", () => {
  for (const selectedPullRequest of [{ id: "review" }, null]) {
    const props = {
      detail: React.createElement("div", null, "Retained detail"),
      list: React.createElement("div", null, "Retained list"),
      isLoading: false,
      pullRequests: [1],
      selectedPullRequest,
    };
    const failed = renderToStaticMarkup(
      React.createElement(PullRequestsPanelSurface, {
        ...props,
        error: new Error("Too many events share one timestamp"),
      }),
    );
    assert.match(failed, /role="alert"/);
    assert.match(failed, /Displayed data may be out of date/);
    assert.match(failed, /Too many events share one timestamp/);
    assert.match(
      failed,
      selectedPullRequest ? /Retained detail/ : /Retained list/,
    );
    const recovered = renderToStaticMarkup(
      React.createElement(PullRequestsPanelSurface, { ...props, error: null }),
    );
    assert.doesNotMatch(recovered, /role="alert"/);
  }
});
