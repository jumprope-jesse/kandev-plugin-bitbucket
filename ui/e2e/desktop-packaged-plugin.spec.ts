import { expect, test } from "@playwright/test";

async function openFirstLinkedTask(page: import("@playwright/test").Page) {
  const taskIndicator = page.locator(
    '[data-testid^="bitbucket-pr-"][data-testid$="-task-single"], [data-testid^="bitbucket-pr-"][data-testid$="-task-multi"]',
  ).first();
  await expect(taskIndicator).toBeVisible();
  const testId = await taskIndicator.getAttribute("data-testid");
  await taskIndicator.click();
  if (testId?.endsWith("-multi")) await page.getByRole("menuitem").first().click();
  await expect(page).toHaveURL(/\/t\/[^/?]+/);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/bitbucket");
  await expect(page.getByTestId("bitbucket-workbench")).toBeVisible();
});

test("keeps connection management out of the desktop pull-request workbench", async ({ page }) => {
  const workbench = page.getByTestId("bitbucket-workbench");

  await expect(workbench.getByTestId("bitbucket-pr-queue")).toBeVisible();
  await expect(workbench.getByTestId("bitbucket-connection-health")).toHaveCount(0);
});

test("opens connection management from an explicit desktop settings action", async ({ page }) => {
  await page.getByRole("button", { name: "Open Bitbucket settings" }).click();

  await expect(page).toHaveURL(/\/settings\/workspace\/[^/]+\/integrations\/bitbucket$/);
  await expect(page.getByTestId("bitbucket-connection-health")).toBeVisible();
});

test("matches GitHub's list-first hierarchy and keeps review inside tasks", async ({ page }) => {
  const workbench = page.getByTestId("bitbucket-workbench");
  const results = page.getByTestId("bitbucket-results");
  const queue = page.getByTestId("bitbucket-pr-queue");

  await expect(page.getByTestId("bitbucket-scope-bar")).toBeVisible();
  await expect(page.getByTestId("bitbucket-list-toolbar")).toBeVisible();
  await expect(results).toBeVisible();
  await expect(queue).toBeVisible();
  await expect(page.getByTestId("bitbucket-review-detail")).toHaveCount(0);
  const [workbenchBox, resultsBox] = await Promise.all([
    workbench.boundingBox(),
    results.boundingBox(),
  ]);
  expect(workbenchBox).not.toBeNull();
  expect(resultsBox).not.toBeNull();
  expect(resultsBox!.width).toBeGreaterThan(workbenchBox!.width * 0.8);

  await expect(queue.getByRole("button", { name: /Review pull request/ })).toHaveCount(0);
  await expect(queue.locator(".bb-change-request-metadata > span").first()).toHaveText(
    /^[^/\s]+\/[^#\s]+#\d+$/,
  );
  const title = queue.locator('a[target="_blank"]').first();
  await expect(title).toHaveAttribute("href", /bitbucket/);

  await queue.getByTestId("bitbucket-start-task-trigger").first().click();
  await expect(page.getByTestId("bitbucket-start-task-preset")).toHaveCount(3);
  await expect(page.getByText("Read the diff, flag issues", { exact: true })).toBeVisible();
  await expect(page.getByText("Apply review comments", { exact: true })).toBeVisible();
  await expect(page.getByText("Diagnose failing checks", { exact: true })).toBeVisible();
  await expect(
    page.locator('[data-preset-id="review"] svg.tabler-icon-eye'),
  ).toBeVisible();
  await expect(
    page.locator('[data-preset-id="address-feedback"] svg.tabler-icon-message-dots'),
  ).toBeVisible();
  await expect(
    page.locator('[data-preset-id="fix-ci"] svg.tabler-icon-tool'),
  ).toBeVisible();
  await page
    .locator('[data-testid="bitbucket-start-task-preset"][data-preset-id="review"]')
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByTestId("task-title-input")).toHaveValue(/^Review:/);
});

test("commits scope filters into the visible query and uses host semantic icons", async ({ page }) => {
  const scope = page.getByTestId("bitbucket-scope-bar");
  const query = page.getByTestId("bitbucket-list-query");

  await expect(query).toHaveValue("state:open");
  await expect(
    scope.getByRole("button", { name: "Open" }).locator('[data-integration-icon="pull-request"]'),
  ).toBeVisible();

  await scope.getByRole("button", { name: "Merged" }).click();

  await expect(query).toHaveValue("state:merged");
  await expect(
    scope.getByRole("button", { name: "Merged" }).locator('[data-integration-icon="merged"]'),
  ).toBeVisible();
});

test("saves, restores, and deletes a workspace query with the shared host dialog", async ({
  page,
}) => {
  const query = page.getByTestId("bitbucket-list-query");
  await query.fill("state:open reviewer:me");
  await page.getByTestId("bitbucket-saved-filters").click();
  await page.getByRole("menuitem", { name: "Save current query" }).click();

  const dialog = page.getByRole("dialog", { name: "Save query" });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("Name").fill("Needs my review");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("bitbucket-saved-filters")).toContainText("Needs my review");

  await page.reload();
  await page.getByTestId("bitbucket-saved-filters").click();
  await page.getByRole("menuitem", { name: "Needs my review" }).click();
  await expect(query).toHaveValue("state:open reviewer:me");

  await page.getByTestId("bitbucket-saved-filters").click();
  const savedItem = page.getByRole("menuitem", { name: "Needs my review" });
  await savedItem.hover();
  await savedItem.getByTitle("Delete saved query").click();
  await expect(page.getByRole("menuitem", { name: "Needs my review" })).toHaveCount(0);
});

test("feeds shared topbar, composer CI, and review detail surfaces", async ({ page }) => {
  await openFirstLinkedTask(page);

  await expect(
    page.locator('[data-testid^="registered-change-request-task-icon-"]').first(),
  ).toBeVisible({ timeout: 15_000 });
  const topbarStatus = page.getByTestId("integration-change-request-status-trigger");
  const composerStatus = page.getByTestId("integration-change-request-status-chip");
  await expect(topbarStatus).toBeVisible({ timeout: 15_000 });
  await expect(composerStatus).toBeVisible({ timeout: 15_000 });

  await topbarStatus.hover();
  await expect(page.getByTestId("integration-change-request-status-popover")).toBeVisible();
  await expect(page.getByText("Checks", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Unlink pull request/ })).toBeVisible();

  await topbarStatus.click();
  const detail = page.getByTestId("change-request-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-presentation", "desktop");
  await expect(detail.getByText("Reviews", { exact: true })).toBeVisible();
  await expect(detail.getByText("Checks", { exact: true })).toBeVisible();
  await expect(detail.getByText("Comments", { exact: true })).toBeVisible();
  await expect(detail.getByRole("tablist")).toHaveCount(0);
  await expect(detail.locator('a[href*="bitbucket"]').first()).toBeVisible();

  await page.route("**/api/plugins/kandev-plugin-bitbucket/actions/reviews.action", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"Test review action unavailable"}' });
  });
  const reviewAction = detail.getByRole("button", { name: /^(Approve|Remove approval)$/ }).first();
  await expect(reviewAction).toBeVisible();
  await reviewAction.click();
  await expect(detail.getByRole("alert")).toContainText("Test review action unavailable");
});
