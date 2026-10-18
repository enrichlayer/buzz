import { expect, test, type Page } from "@playwright/test";
import { waitForAnimations } from "../helpers/animations";
import { installMockBridge } from "../helpers/bridge";

const selection = "plugin:enrichlayer.el-buzz:dark";
const pluginId = "enrichlayer.el-buzz";
const variable = (page: Page, name: string) =>
  page.evaluate(
    (key) =>
      getComputedStyle(document.documentElement).getPropertyValue(key).trim(),
    name,
  );

function trackPageErrors(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (error) => {
    if (!error.message.startsWith("ResizeObserver loop"))
      errors.push(error.message);
  });
  return errors;
}

async function openSettings(page: Page) {
  await page.getByTestId("open-settings").click();
  await page.getByTestId("profile-popover-settings").click();
}

async function installTheme(page: Page) {
  await page.getByTestId("settings-nav-plugins").click();
  await page.getByTestId("runtime-plugin-load-el-buzz").click();
  const raw = await page
    .getByTestId("runtime-plugin-manifest-input")
    .inputValue();
  await page.getByTestId("runtime-plugin-install").click();
  await expect(
    page.getByTestId(`runtime-plugin-row-${pluginId}`),
  ).toBeVisible();
  return JSON.parse(raw);
}

async function chooseTheme(page: Page) {
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("appearance-mode-dark").click();
  await page.getByTestId("theme-style-trigger").click();
  const tile = page.getByTestId(`theme-option-${selection}`);
  await tile.focus();
  await page.keyboard.press("Enter");
  await expect(tile).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => variable(page, "--primary"))
    .toBe("94.5 13.92% 53.5%");
}

test("theme plugin installs, persists, updates and falls back when disabled or removed", async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  test.setTimeout(180_000);
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await openSettings(page);
  const manifest = await installTheme(page);
  await chooseTheme(page);
  await expect.poll(() => variable(page, "--background")).toBe("0 0% 15.7%");
  await expect(page.locator("html")).not.toHaveAttribute("data-buzz-sidebar");
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/el-buzz/appearance.png" });
  await page.getByTestId("settings-back-to-app").click();
  await page.getByTestId("channel-general").click();
  await waitForAnimations(page);
  await page.screenshot({ path: "test-results/el-buzz/conversation.png" });
  await page.reload();
  // Theme CSS restores before the channel route finishes mounting. Wait for
  // its composer before opening a popover that route autofocus would dismiss.
  await expect(page.getByTestId("message-composer")).toBeVisible();
  await waitForAnimations(page);
  await expect.poll(() => variable(page, "--background")).toBe("0 0% 15.7%");
  await openSettings(page);
  await page.getByTestId("settings-nav-plugins").click();
  const originalSecondary = await variable(page, "--secondary");
  manifest.version = "1.1.0";
  manifest.themes[0].colors.background = "#202020";
  delete manifest.themes[0].colors.secondary;
  await page
    .getByTestId("runtime-plugin-manifest-input")
    .fill(JSON.stringify(manifest));
  await page.getByTestId("runtime-plugin-update").click();
  await expect.poll(() => variable(page, "--background")).toBe("0 0% 12.5%");
  await expect
    .poll(() => variable(page, "--secondary"))
    .not.toBe(originalSecondary);
  await page.getByTestId(`runtime-plugin-toggle-${pluginId}`).click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await page.getByTestId("settings-nav-appearance").click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "selected theme is unavailable" }),
  ).toBeVisible();
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await page.getByTestId("settings-nav-plugins").click();
  await page.getByTestId(`runtime-plugin-toggle-${pluginId}`).click();
  await expect.poll(() => variable(page, "--background")).toBe("0 0% 12.5%");
  await page
    .getByRole("button", { name: "Remove el-buzz", exact: true })
    .click();
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await expect(page.getByTestId(`runtime-plugin-row-${pluginId}`)).toHaveCount(
    0,
  );
  expect(pageErrors).toEqual([]);
});

test("invalid theme cannot be installed; a missing package leaves Appearance usable", async ({
  page,
}) => {
  const pageErrors = trackPageErrors(page);
  await page.addInitScript((theme) => {
    localStorage.setItem("buzz-theme", theme);
    localStorage.setItem("buzz-follow-system", "false");
  }, selection);
  await installMockBridge(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator("html")).toHaveAttribute(
    "data-buzz-theme",
    "buzz-dark",
  );
  await openSettings(page);
  await page.getByTestId("settings-nav-plugins").click();
  await page.getByTestId("runtime-plugin-load-el-buzz").click();
  const input = page.getByTestId("runtime-plugin-manifest-input");
  const manifest = JSON.parse(await input.inputValue());
  manifest.themes[0].colors.background = "url(https://example.com)";
  await input.fill(JSON.stringify(manifest));
  await expect(page.getByTestId("runtime-plugin-install")).toBeDisabled();
  await expect(
    page.getByRole("alert").filter({ hasText: "Unsupported theme color" }),
  ).toBeVisible();
  await page.getByTestId("settings-nav-appearance").click();
  await page.getByTestId("appearance-mode-light").click();
  await page.getByTestId("theme-style-trigger").click();
  await page.getByTestId("theme-option-buzz").click();
  await expect(page.locator("html")).toHaveAttribute("data-buzz-theme", "buzz");
  await expect(
    page.getByText("Your selected theme is unavailable", { exact: false }),
  ).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});
