import { mkdir, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { hexToBytes } from "@noble/hashes/utils.js";
import { finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { installRelayBridge, TEST_IDENTITIES } from "../helpers/bridge";
import { assertRelaySeeded } from "../helpers/seed";
import { waitForAnimations } from "../helpers/animations";

const relay = process.env.BUZZ_E2E_RELAY_URL ?? "http://localhost:3000";
const dtag = `review-proof-${Date.now()}`;
const repoAddress = `30617:${TEST_IDENTITIES.tyler.pubkey}:${dtag}`;
// scripts/setup-desktop-test-data.sh: UUIDv5(DNS, "buzz.channel.general").
const channel = "9f28288a-d724-587a-9709-92dc7f967110";
const filePath = "desktop/src/features/projects/ui/ProjectDetailScreen.tsx";

async function publish(
  user: "tyler" | "alice",
  kind: number,
  content: string,
  tags: string[][],
) {
  const identity = TEST_IDENTITIES[user];
  const event = finalizeEvent(
    { kind, content, tags, created_at: Math.floor(Date.now() / 1000) },
    hexToBytes(identity.privateKey),
  );
  const response = await fetch(`${relay}/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Pubkey": identity.pubkey,
    },
    body: JSON.stringify(event),
  });
  expect(response.ok, await response.text()).toBeTruthy();
  return event;
}
async function openReview(page: Page) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("open-projects-view").click();
  await page.getByTestId("projects-section-projects").click();
  await page
    .locator(
      `[data-testid="project-card-${dtag}"], [data-testid="project-row-${dtag}"]`,
    )
    .first()
    .click();
  await page.getByTestId(`project-home-context-repo-${dtag}`).click();
  await page.getByRole("tab", { name: "Review", exact: true }).click();
  await page
    .getByTestId("project-pull-request-row")
    .filter({ hasText: "Live review workflow" })
    .getByRole("button", { name: /^#/ })
    .click();
  await page.getByRole("button", { name: /^Files changed/ }).click();
}

test("two reviewers persist replies and resolution through the real relay", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  // Public fixture keys must never be used against an external workspace.
  expect(["localhost", "127.0.0.1"]).toContain(new URL(relay).hostname);
  await assertRelaySeeded();
  await publish("tyler", 30617, "Local review verification", [
    ["d", dtag],
    ["name", dtag],
    ["clone", `${relay}/git/${TEST_IDENTITIES.tyler.pubkey}/${dtag}`],
    ["buzz-channel", channel],
  ]);
  await publish("tyler", 30621, "", [
    ["d", dtag],
    ["name", dtag],
    ["a", repoAddress],
    ["buzz-channel", channel],
  ]);
  const root = await publish("alice", 1618, "Live review workflow", [
    ["a", repoAddress],
    ["subject", "Live review workflow"],
    ["c", "1".repeat(40)],
    ["branch-name", "review-proof"],
    ["target-branch", "main"],
    ["p", TEST_IDENTITIES.tyler.pubkey],
  ]);
  const first = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
  });
  const second = await browser.newContext({
    viewport: { width: 1600, height: 1100 },
  });
  try {
    const owner = await first.newPage();
    const author = await second.newPage();
    for (const [page, user] of [
      [owner, "tyler"],
      [author, "alice"],
    ] as const) {
      page.setDefaultTimeout(15_000);
      await page.addInitScript(() =>
        localStorage.setItem(
          "buzz-feature-overrides-v1",
          JSON.stringify({ projects: true }),
        ),
      );
      await installRelayBridge(page, user);
    }
    await openReview(owner);
    await owner.getByRole("button", { name: "Split", exact: true }).click();
    const search = owner.getByRole("textbox", { name: "Search diff" });
    await search.fill("return");
    await expect(
      owner.getByText("1 of 3 matching lines", { exact: true }),
    ).toBeVisible();
    await search.press("Enter");
    await expect(owner.locator('[data-search-active="true"]')).toHaveAttribute(
      "data-path",
      "desktop/src/features/projects/hooks.ts",
    );
    await search.press("Shift+Enter");
    await search.press("Escape");
    await owner
      .getByRole("checkbox", { name: `Mark ${filePath} viewed` })
      .check();
    const line = owner
      .getByTestId("project-diff-line")
      .filter({ hasText: "function CommunityTabs()" });
    await line.hover();
    await line.getByTestId("project-diff-add-comment").click();
    const composer = owner
      .getByTestId("project-inline-comment-thread")
      .filter({ has: owner.locator('[contenteditable="true"]') });
    await composer
      .locator('[contenteditable="true"]')
      .fill("Verify the old-side behavior before merging.");
    await composer.getByRole("button", { name: "Send message" }).click();
    const discussion = owner
      .getByRole("region", { name: "Review discussion", exact: true })
      .filter({ hasText: "Verify the old-side behavior" });
    await expect(discussion).toBeVisible();
    await discussion
      .getByRole("button", { name: "Reply", exact: true })
      .click();
    await discussion
      .getByRole("textbox", { name: "Reply to discussion" })
      .fill("The regression test covers the original behavior.");
    await discussion.getByRole("button", { name: "Send reply" }).click();
    await expect(discussion).toContainText(
      "The regression test covers the original behavior.",
    );

    // A separate identity/context must reconstruct the thread solely from the relay.
    await openReview(author);
    const remote = author
      .getByRole("region", { name: "Review discussion", exact: true })
      .filter({ hasText: "Verify the old-side behavior" });
    await expect(remote).toContainText(
      "The regression test covers the original behavior.",
    );
    await remote.getByRole("button", { name: "Resolve", exact: true }).click();
    await expect(remote.getByRole("status")).toHaveText("Resolved");
    await openReview(owner);
    await expect(
      owner.getByRole("checkbox", { name: `Mark ${filePath} viewed` }),
    ).toBeChecked();
    await expect(discussion.getByRole("status")).toHaveText("Resolved");
    await discussion
      .getByRole("button", { name: "Reopen", exact: true })
      .click();
    await expect(discussion.getByRole("status")).toHaveText("Unresolved");
    await openReview(author);
    await expect(remote.getByRole("status")).toHaveText("Unresolved");
    await author.getByRole("button", { name: "Split", exact: true }).click();
    await waitForAnimations(author);
    await author.screenshot({
      path: "test-results/review-workspace/live-two-reviewers.png",
    });

    // New head invalidates viewed progress; history retains its original location.
    await publish("alice", 1619, "New revision", [
      ["E", root.id],
      ["a", repoAddress],
      ["c", "2".repeat(40)],
    ]);
    await openReview(owner);
    await expect(
      owner.getByRole("checkbox", { name: `Mark ${filePath} viewed` }),
    ).not.toBeChecked();
    await expect(discussion).toContainText("Earlier revision");
    const response = await fetch(`${relay}/query`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Pubkey": TEST_IDENTITIES.tyler.pubkey,
      },
      body: JSON.stringify([{ kinds: [1], "#e": [root.id], limit: 100 }]),
    });
    expect(response.ok).toBeTruthy();
    const events = await response.json();
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(
      events.every((event: Parameters<typeof verifyEvent>[0]) =>
        verifyEvent(event),
      ),
    ).toBe(true);
    await mkdir("test-results/review-workspace", { recursive: true });
    await writeFile(
      "test-results/review-workspace/live-relay-events.json",
      JSON.stringify(
        { relay, reviewId: root.id, verifiedSignatures: true, events },
        null,
        2,
      ),
    );
    expect(
      events.filter((event: { tags: string[][] }) =>
        event.tags.some((tag) => tag[1] === "review-thread-resolve"),
      ),
    ).toHaveLength(1);
    expect(
      events.filter((event: { tags: string[][] }) =>
        event.tags.some((tag) => tag[1] === "review-thread-reopen"),
      ),
    ).toHaveLength(1);
  } finally {
    await first.close();
    await second.close();
  }
});
