import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

// The mock identity owns the seeded `buzz` repository, so the viewer may
// request and judge a stack review; Alice authors the stack, Bob reviews it.
const OWNER = "deadbeef".repeat(8);
const ALICE =
  "953d3363262e86b770419834c53d2446409db6d918a57f8f339d495d54ab001f";
const BOB = "bb22a5299220cad76ffd46190ccbeede8ab5dc260faa28b6e5a2cb31b9aff260";
const CHANNEL = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
const THREAD = "3".repeat(64);
const PR_A = "4".repeat(64);
const PR_B = "5".repeat(64);
const BUNDLE = "6".repeat(64);
const HEAD_A = "1".repeat(40);
const HEAD_B = "2".repeat(40);
const REPO = `30617:${OWNER}:buzz`;

async function seed(page: import("@playwright/test").Page) {
  await page.addInitScript(
    ({
      owner,
      alice,
      bob,
      channel,
      thread,
      prA,
      prB,
      bundle,
      headA,
      headB,
      repo,
    }) => {
      localStorage.setItem(
        "buzz-feature-overrides-v1",
        JSON.stringify({ projects: true }),
      );
      const pullRequest = (
        id: string,
        subject: string,
        head: string,
        issue: string,
        mr: number,
      ) => ({
        id,
        kind: 1618,
        pubkey: alice,
        created_at: 101,
        content: subject,
        tags: [
          ["a", repo],
          ["e", thread, "", "buzz-session"],
          ["h", channel],
          ["p", bob],
          ["r", `https://linear.app/acme/issue/${issue}/slice`, "linear-issue"],
          [
            "r",
            `https://gitlab.com/acme/tools/-/merge_requests/${mr}`,
            "mirror-of",
          ],
          ["subject", subject],
          ["c", head],
          ["branch-name", `feature/${issue.toLowerCase()}`],
          ["target-branch", "main"],
        ],
      });
      window.__BUZZ_E2E_EXTRA_PROJECT_EVENTS__ = [
        pullRequest(prA, "Stack member A", headA, "DEV-1", 11),
        pullRequest(prB, "Stack member B", headB, "DEV-2", 12),
        {
          id: bundle,
          kind: 1,
          pubkey: alice,
          created_at: 102,
          content: "Review the stack as one change.",
          tags: [
            ["a", repo],
            ["subject", "DEV-9 stack"],
            ["t", "review-bundle"],
            ["e", prA, "", "bundle-member"],
            ["bookmark", prA, "feature/dev-1"],
            ["e", prB, "", "bundle-member"],
            ["p", owner],
            ["p", bob],
            ["r", "https://linear.app/acme/issue/DEV-9/stack", "linear-issue"],
          ],
        },
        {
          id: "7".repeat(64),
          kind: 1,
          pubkey: bob,
          created_at: 103,
          content: "Approved the stack",
          tags: [
            ["e", bundle, "", "root"],
            ["a", repo],
            ["t", "bundle-approval"],
            ["member-head", prA, headA],
            ["member-head", prB, headB],
          ],
        },
      ];
    },
    {
      owner: OWNER,
      alice: ALICE,
      bob: BOB,
      channel: CHANNEL,
      thread: THREAD,
      prA: PR_A,
      prB: PR_B,
      bundle: BUNDLE,
      headA: HEAD_A,
      headB: HEAD_B,
      repo: REPO,
    },
  );
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByTestId("channel-general").click();
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          window.__BUZZ_E2E_HAS_MOCK_LIVE_SUBSCRIPTION__?.({
            channelName: "general",
          }) ?? false,
      ),
    )
    .toBe(true);
}

async function openCodingThread(page: import("@playwright/test").Page) {
  await page.evaluate(
    ({ alice, thread }) => {
      const emit = window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__;
      if (!emit) throw new Error("Missing mock message emitter");
      emit({
        channelName: "general",
        id: thread,
        content: "Implement the DEV-9 stack",
        pubkey: alice,
      });
      emit({
        channelName: "general",
        content: "Pushed both slices for review.",
        parentEventId: thread,
        pubkey: alice,
      });
    },
    { alice: ALICE, thread: THREAD },
  );
  await page
    .locator(
      `[data-testid="message-thread-summary"][data-thread-head-id="${THREAD}"]`,
    )
    .click();
  const panel = page.getByTestId("message-thread-panel");
  await expect(panel).toBeVisible();
  return panel;
}

test("a coding thread shows its stack as one card and fans a review request out to every member", async ({
  page,
}) => {
  await seed(page);
  const panel = await openCodingThread(page);
  const card = panel.getByTestId("review-bundle-card");
  await expect(card).toBeVisible();
  await expect(card.getByText("DEV-9 stack")).toBeVisible();
  await expect(card.getByTestId("review-bundle-decision")).toHaveText(
    "Approved",
  );
  const members = card.getByTestId("review-bundle-member");
  await expect(members).toHaveCount(2);
  await expect(members.nth(0)).toContainText("1. Stack member A");
  await expect(members.nth(0)).toContainText("feature/dev-1");
  await expect(
    members.nth(0).getByRole("button", { name: "DEV-1" }),
  ).toBeVisible();
  await expect(
    members.nth(0).getByRole("button", { name: "Merge request" }),
  ).toBeVisible();
  await expect(members.nth(1)).toContainText("2. Stack member B");
  // Bundled members are not repeated as loose thread reviews.
  await expect(
    panel.getByRole("button", { name: "Review changes: Stack member A" }),
  ).toHaveCount(1);

  await card.getByRole("button", { name: "Request stack review" }).click();
  await expect
    .poll(() =>
      page.evaluate(
        ({ bob }) =>
          (window.__BUZZ_E2E_SIGNED_EVENTS__ ?? [])
            .filter(
              (event) =>
                event.kind === 1 &&
                event.tags.some(
                  (tag) => tag[0] === "t" && tag[1] === "review-request",
                ),
            )
            .map((event) => [
              event.tags.find((tag) => tag[0] === "e")?.[1],
              event.tags.some((tag) => tag[0] === "p" && tag[1] === bob),
            ]),
        { bob: BOB },
      ),
    )
    .toEqual([
      [PR_A, true],
      [PR_B, true],
    ]);

  await members
    .nth(0)
    .getByRole("button", { name: "Review changes: Stack member A" })
    .click();
  await expect(page).toHaveURL(
    (url) =>
      new URLSearchParams(url.hash.split("?")[1]).get("pullRequestId") ===
      JSON.stringify(PR_A),
  );
});

test("a buzz://bundle link renders as a stack chip and opens the stack on the Reviews tab", async ({
  page,
}) => {
  await seed(page);
  const href = `buzz://bundle?id=${BUNDLE}&owner=${OWNER}&d=buzz`;
  await page.evaluate(
    ({ alice, href }) => {
      window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__?.({
        channelName: "general",
        content: `Please review ${href}`,
        pubkey: alice,
      });
    },
    { alice: ALICE, href },
  );
  const chip = page.locator('[data-buzz-link-kind="bundle"]').first();
  await expect(chip).toBeVisible();
  await expect(chip).toHaveAttribute(
    "aria-label",
    `Open review stack ${BUNDLE.slice(0, 8)} in repository buzz`,
  );
  await chip.click();
  await expect(page).toHaveURL(
    (url) =>
      new URLSearchParams(url.hash.split("?")[1]).get("bundleId") ===
      JSON.stringify(BUNDLE),
  );
  const stack = page.getByTestId("project-review-bundle");
  await expect(stack.getByTestId("review-bundle-card")).toBeVisible();
  await expect(stack.getByTestId("review-bundle-member")).toHaveCount(2);
  await stack
    .getByRole("button", { name: "Review changes: Stack member B" })
    .click();
  // A member opens in place on the Reviews tab, like a row of the list.
  await expect(
    page.getByRole("heading", { name: "Stack member B", exact: true }),
  ).toBeVisible();
  await expect(stack).toHaveCount(0);
});
