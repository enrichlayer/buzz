import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

test("session review entry exposes the issue and exact commit and opens the existing review by identity", async () => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const React = await import("react");
  const { render, fireEvent, cleanup } = await import("@testing-library/react");
  const { ThreadReviewList } = await import("./ThreadReviewList.tsx");
  const { eventToProjectPullRequest } = await import(
    "../projectPullRequests.mjs"
  );
  const owner = "b".repeat(64),
    id = "c".repeat(64),
    commit = "d".repeat(40);
  const review = eventToProjectPullRequest({
    id,
    pubkey: owner,
    kind: 1618,
    created_at: 1,
    content: "Fix discounts",
    tags: [
      ["a", `30617:${owner}:demo`],
      ["c", commit],
      ["branch-name", "fix-discounts"],
      ["e", "a".repeat(64), "", "buzz-session"],
      ["r", "https://linear.app/acme/issue/DEV-1/fix", "linear-issue"],
    ],
  });
  let opened, issue;
  const ui = render(
    React.createElement(ThreadReviewList, {
      reviews: [review],
      onOpenReview: (link) => {
        opened = link;
      },
      onOpenIssue: (url) => {
        issue = url;
      },
    }),
  );
  try {
    assert.equal(
      ui.getByTitle(commit).textContent.trim(),
      `· ${commit.slice(0, 12)}`,
    );
    assert.ok(ui.getByText(/Association claimed by reviewer:/));
    assert.equal(ui.getByText(owner).textContent, owner);
    // A signed association from an unrelated identity is explicitly a claim.
    ui.rerender(
      React.createElement(ThreadReviewList, {
        reviews: [{ ...review, author: "e".repeat(64) }],
        onOpenReview: (link) => {
          opened = link;
        },
        onOpenIssue: (url) => {
          issue = url;
        },
      }),
    );
    assert.ok(ui.getByText(/Association claimed by reviewer:/));
    assert.ok(ui.getByText("e".repeat(64)));
    fireEvent.click(
      ui.getByRole("button", { name: "Review changes: Fix discounts" }),
    );
    assert.equal(opened.type, "pr");
    assert.equal(opened.id, id);
    assert.equal(opened.owner, owner);
    fireEvent.click(ui.getByRole("button", { name: "DEV-1" }));
    assert.equal(issue, "https://linear.app/acme/issue/DEV-1/fix");
    ui.rerender(
      React.createElement(ThreadReviewList, {
        reviews: [{ ...review, repoAddress: `30617:${owner}:.bad` }],
        onOpenReview() {},
        onOpenIssue() {},
      }),
    );
    assert.equal(ui.queryByRole("button"), null);
  } finally {
    cleanup();
    dom.window.close();
  }
});
