import { expect, test } from "@playwright/test";
import { installMockBridge } from "../helpers/bridge";

async function seed(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "buzz-feature-overrides-v1",
      JSON.stringify({ projects: true }),
    );
    const owner = "a".repeat(64);
    const channel = "9a1657ac-f7aa-5db0-b632-d8bbeb6dfb50";
    const organizationId = "22222222-2222-4222-8222-222222222222";
    const projectId = "33333333-3333-4333-8333-333333333333";
    const issueId = "44444444-4444-4444-8444-444444444444";
    const source = {
      provider: "linear",
      organizationId,
      projectId,
      workspace: "acme",
    };
    const dtag = (id: string) => `linear:${channel}:${organizationId}:${id}`;
    const address = `30624:${owner}:${dtag(issueId)}`;
    const observedAt = new Date().toISOString();
    const base = { updatedAt: observedAt, archivedAt: null };
    const mirror = (
      kind: number,
      type: string,
      record: Record<string, unknown>,
      id: string,
    ) => ({
      id: id.repeat(64),
      kind,
      pubkey: owner,
      created_at: Math.floor(Date.now() / 1000),
      content: JSON.stringify({
        schema: "buzz.linear-record.v1",
        source,
        type,
        observedAt,
        record,
      }),
      tags: [
        ["h", channel],
        ["d", dtag(String(record.id))],
        ["l", projectId],
      ],
    });
    window.__BUZZ_E2E_EXTRA_PROJECT_EVENTS__ = [
      mirror(
        30623,
        "project",
        {
          ...base,
          id: projectId,
          name: "Mirrored planning project",
          description: "Linear remains authoritative",
          content: "Project acceptance context",
          url: "https://linear.app/acme/project/planning",
          teams: [],
        },
        "1",
      ),
      mirror(
        30624,
        "issue",
        {
          ...base,
          id: issueId,
          project: { id: projectId },
          identifier: "DEV-42",
          title: "Connected source task",
          description:
            "Acceptance: preserve the same issue across coding and review.",
          url: "https://linear.app/acme/issue/DEV-42/task",
          state: { name: "In Progress", type: "started" },
        },
        "2",
      ),
      {
        id: "3".repeat(64),
        kind: 9,
        pubkey: owner,
        created_at: 100,
        content: "Implement the source task",
        tags: [
          ["h", channel],
          ["a", address, "", "buzz-task"],
        ],
      },
      {
        id: "4".repeat(64),
        kind: 1618,
        pubkey: owner,
        created_at: 101,
        content: "Task review acceptance",
        tags: [
          ["a", `30617:${"deadbeef".repeat(8)}:buzz`],
          ["a", address, "", "buzz-task"],
          ["e", "3".repeat(64), "", "buzz-session"],
          ["h", channel],
          ["r", "https://linear.app/acme/issue/DEV-42/task", "linear-issue"],
          ["subject", "Connected task review"],
          ["c", "1".repeat(40)],
          ["branch-name", "task-work"],
          ["target-branch", "main"],
        ],
      },
    ];
  });
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
  await page.evaluate(() => {
    const root = window.__BUZZ_E2E_EXTRA_PROJECT_EVENTS__?.find(
      (event) => event.kind === 9,
    );
    if (!root || !window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__)
      throw new Error("Missing coding-thread fixture");
    window.__BUZZ_E2E_EMIT_MOCK_MESSAGE__({
      channelName: "general",
      id: root.id,
      content: root.content,
      pubkey: root.pubkey,
      kind: 9,
      createdAt: root.created_at,
      extraTags: root.tags.filter((tag) => tag[0] !== "h"),
    });
  });
  await page.getByTestId("open-projects-view").click();
  await page.getByTestId("projects-section-projects").click();
}

test("Linear project opens native tasks with full context, coding roots and real review navigation", async ({
  page,
}) => {
  await seed(page);
  await page.getByRole("button", { name: /Mirrored planning project/ }).click();
  await expect(
    page.getByRole("heading", {
      name: "Mirrored planning project",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText("Project acceptance context")).toBeVisible();
  await page
    .getByRole("button", { name: /DEV-42.*Connected source task/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Connected source task", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Acceptance: preserve the same issue across coding and review.",
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Implement the source task/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Work on this task" }),
  ).toBeEnabled();
  await page
    .getByRole("button", { name: "Review changes: Connected task review" })
    .click();
  await expect(page).toHaveURL(/pullRequestId=444444/);
  await page.getByRole("button", { name: "Open task", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connected source task", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: /Implement the source task/ }).click();
  await expect(page).toHaveURL(/thread=333333/);
  await expect(
    page
      .getByTestId("message-thread-panel")
      .getByTestId("message-body")
      .filter({ hasText: "Implement the source task" }),
  ).toBeVisible();
});

test("failed private mirror reads hide cached source cards and expose retry", async ({
  page,
}) => {
  await seed(page);
  await expect(
    page.getByRole("button", { name: /Mirrored planning project/ }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.__BUZZ_E2E_REJECT_PROJECT_QUERY_KINDS__ = [30623, 30624];
  });
  await page.getByRole("button", { name: "Refresh view", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Retry Linear work" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Mirrored planning project/ }),
  ).toHaveCount(0);
  await page.evaluate(() => {
    window.__BUZZ_E2E_REJECT_PROJECT_QUERY_KINDS__ = [];
  });
  await page.getByRole("button", { name: "Retry Linear work" }).click();
  await expect(
    page.getByRole("button", { name: /Mirrored planning project/ }),
  ).toBeVisible();
});
