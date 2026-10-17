import { expect, test, type Page } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";
import { waitForAnimations } from "../helpers/animations";

const path = "desktop/src/features/projects/ui/ProjectDetailScreen.tsx";
async function openReview(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await page.getByTestId("projects-section-projects").click();
  await page
    .locator(
      '[data-testid="project-card-buzz"], [data-testid="project-row-buzz"]',
    )
    .first()
    .click();
  await page.getByTestId("project-home-context-repo-buzz").click();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByTestId("project-pull-request-row")
    .filter({ has: page.getByRole("button", { name: "alice", exact: true }) })
    .first()
    .getByRole("button", { name: /^#/ })
    .click();
  await page.getByRole("button", { name: /^Files changed/ }).click();
  await expect(page.getByTestId("project-diff-line").first()).toBeVisible();
}
async function setup(page: Page) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ projects: true }),
    ),
  );
  // The general mock history regenerates random IDs on reload. Pin this review
  // so reload tests revisit the same identity/review/commit, as a real relay does.
  await page.addInitScript(() => {
    window.__BUZZ_E2E_EXTRA_PROJECT_EVENTS__ = [
      {
        id: "e".repeat(64),
        kind: 1618,
        pubkey:
          "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f",
        created_at: Math.floor(Date.now() / 1000),
        content: "Review workspace verification",
        tags: [
          ["a", `30617:${"deadbeef".repeat(8)}:buzz`],
          ["subject", "Review workspace verification"],
          ["c", "1".repeat(40)],
          ["branch-name", "review-workspace"],
          ["target-branch", "main"],
        ],
      },
    ];
  });
  await installMockBridge(page);
  await openReview(page);
}
async function addLineComment(
  page: Page,
  side: "old" | "new",
  content: string,
) {
  const line = page.getByTestId("project-diff-line").filter({
    hasText:
      side === "old"
        ? "function CommunityTabs()"
        : "function CommunityTabs({ selectedCommitHash })",
  });
  await line.hover();
  await line
    .getByRole("button", { name: `Comment on ${path} ${side} line 3` })
    .click();
  const composer = page
    .getByTestId("project-inline-comment-thread")
    .filter({ has: page.locator('[contenteditable="true"]') });
  await composer.locator('[contenteditable="true"]').fill(content);
  await composer.getByRole("button", { name: "Send message" }).click();
  const discussion = page
    .getByRole("region", { name: "Review discussion", exact: true })
    .filter({ hasText: content });
  await expect(discussion).toBeVisible();
  return discussion;
}

test("review workspace supports split search viewed progress and durable thread operations", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1100 });
  await setup(page);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator('[data-diff-layout="split"]')).toBeVisible();
  await expect(
    page.getByRole("button", { name: `Comment on ${path} old line 3` }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: `Comment on ${path} new line 3` }),
  ).toHaveCount(1);
  const search = page.getByRole("textbox", {
    name: "Search diff",
    exact: true,
  });
  await search.fill("return");
  await expect(
    page.getByText("1 of 3 matching lines", { exact: true }),
  ).toBeVisible();
  await search.press("Enter");
  await expect(page.locator('[data-search-active="true"]')).toHaveAttribute(
    "data-path",
    "desktop/src/features/projects/hooks.ts",
  );
  await search.press("Shift+Enter");
  await expect(page.locator('[data-search-active="true"]')).toHaveAttribute(
    "data-path",
    path,
  );
  await search.fill("no-such-line");
  await expect(page.getByText("No matches", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Next diff match" }),
  ).toBeDisabled();
  await search.press("Escape");
  const viewed = page.getByRole("checkbox", { name: `Mark ${path} viewed` });
  await viewed.check();
  await expect(viewed).toBeChecked();
  // Full reload proves the persisted local snapshot, not just component state.
  await openReview(page);
  await expect(
    page.getByRole("checkbox", { name: `Mark ${path} viewed` }),
  ).toBeChecked();
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const discussion = await addLineComment(
    page,
    "old",
    "Keep the original behavior documented.",
  );
  await discussion.getByRole("button", { name: "Reply", exact: true }).click();
  await discussion
    .getByRole("textbox", { name: "Reply to discussion" })
    .fill("The replacement is covered by a regression test.");
  await discussion
    .getByRole("textbox", { name: "Reply to discussion" })
    .press("Control+Enter");
  await expect(discussion).toContainText(
    "The replacement is covered by a regression test.",
  );
  await discussion
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(discussion.getByRole("status")).toHaveText("Resolved");
  await discussion.getByRole("button", { name: "Reopen", exact: true }).click();
  await expect(discussion.getByRole("status")).toHaveText("Unresolved");
  // Force the review surface to unmount and remount; state must come from event history.
  await page.getByRole("button", { name: /^Files changed/ }).click();
  await page.getByRole("button", { name: /^Files changed/ }).click();
  await expect(
    page
      .getByRole("region", { name: "Review discussion", exact: true })
      .filter({ hasText: "Keep the original behavior documented." }),
  ).toContainText("The replacement is covered by a regression test.");
  const events = await page.evaluate(
    () => window.__BUZZ_E2E_SIGNED_EVENTS__ ?? [],
  );
  const reply = events.find(
    (event) =>
      event.content === "The replacement is covered by a regression test.",
  );
  expect(reply?.tags).toContainEqual(["side", "old"]);
  expect(reply?.tags.some((tag) => tag[0] === "e" && tag[3] === "reply")).toBe(
    true,
  );
  expect(
    events.filter((event) =>
      event.tags.some((tag) => tag[1] === "review-thread-resolve"),
    ),
  ).toHaveLength(1);
  expect(
    events.filter((event) =>
      event.tags.some((tag) => tag[1] === "review-thread-reopen"),
    ),
  ).toHaveLength(1);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/review-workspace/complete.png" });
});

test("rejected replies preserve drafts and failed resolution leaves discussion open", async ({
  page,
}) => {
  await setup(page);
  const discussion = await addLineComment(
    page,
    "new",
    "Please verify the new parameter.",
  );
  await discussion.getByRole("button", { name: "Reply", exact: true }).click();
  const draft = discussion.getByRole("textbox", {
    name: "Reply to discussion",
  });
  await draft.fill("Cancel keeps this unsent.");
  const beforeCancel = await page.evaluate(
    () => window.__BUZZ_E2E_SIGNED_EVENTS__?.length ?? 0,
  );
  await discussion.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(draft).toHaveCount(0);
  expect(
    await page.evaluate(() => window.__BUZZ_E2E_SIGNED_EVENTS__?.length ?? 0),
  ).toBe(beforeCancel);
  await discussion.getByRole("button", { name: "Reply", exact: true }).click();
  await expect(draft).toHaveValue("Cancel keeps this unsent.");
  await draft.fill("This draft must survive a rejected event.");
  await page.evaluate(() => {
    window.__BUZZ_E2E_REJECT_PROJECT_EVENT_KINDS__ = [1];
  });
  await discussion.getByRole("button", { name: "Send reply" }).click();
  await expect(discussion.getByRole("alert")).toBeVisible();
  await expect(draft).toHaveValue("This draft must survive a rejected event.");
  await discussion.getByRole("button", { name: "Send reply" }).click();
  await expect(draft).toHaveCount(0);
  await expect(discussion).toContainText(
    "This draft must survive a rejected event.",
  );
  await page.evaluate(() => {
    window.__BUZZ_E2E_REJECT_PROJECT_EVENT_KINDS__ = [1];
  });
  await discussion
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(discussion.getByRole("alert")).toBeVisible();
  await expect(discussion.getByRole("status")).toHaveText("Unresolved");
  await discussion
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(discussion.getByRole("status")).toHaveText("Resolved");
});

test("viewed progress reports storage failure and preserves the previous checkbox state", async ({
  page,
}) => {
  await setup(page);
  await page.evaluate(() => {
    const set = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "buzz-review-viewed-v1")
        throw new Error("Review progress storage unavailable");
      return set.call(this, key, value);
    };
  });
  const checkbox = page.getByRole("checkbox", { name: `Mark ${path} viewed` });
  await checkbox.click();
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Review progress storage unavailable" }),
  ).toBeVisible();
  await expect(checkbox).not.toBeChecked();
});

test("old-side context discussions remain reachable in unified view", async ({
  page,
}) => {
  await setup(page);
  await page.getByRole("button", { name: "Split", exact: true }).click();
  const line = page.locator(
    '[data-testid="project-diff-line"][data-side="old"][data-line="1"]',
  );
  await line.hover();
  await line.getByTestId("project-diff-add-comment").click();
  const composer = page
    .getByTestId("project-inline-comment-thread")
    .filter({ has: page.locator('[contenteditable="true"]') });
  await composer
    .locator('[contenteditable="true"]')
    .fill("Discuss unchanged context on the old side.");
  await composer.getByRole("button", { name: "Send message" }).click();
  await page.getByRole("button", { name: "Unified", exact: true }).click();
  const discussion = page
    .getByRole("region", { name: "Review discussion", exact: true })
    .filter({ hasText: "Discuss unchanged context on the old side." });
  await expect(discussion).toContainText("Before line 1");
  await discussion
    .getByRole("button", { name: "Resolve", exact: true })
    .click();
  await expect(discussion.getByRole("status")).toHaveText("Resolved");
});
