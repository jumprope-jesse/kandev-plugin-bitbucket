import { expect, test, type Page } from "@playwright/test";

async function expectNoDocumentHorizontalOverflow(page: Page) {
  await expect
    .poll(() =>
      page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function expectContainedInViewport(page: Page, selector: string) {
  await expect
    .poll(async () => {
      const element = page.locator(selector);
      const box = await element.boundingBox();
      const viewport = page.viewportSize();
      if (!box || !viewport) return false;
      return (
        box.x >= -1 &&
        box.y >= -1 &&
        box.x + box.width <= viewport.width + 1 &&
        box.y + box.height <= viewport.height + 1
      );
    })
    .toBe(true);
}

async function waitForFiniteAnimations(page: Page) {
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter((animation) => {
      const iterations = animation.effect?.getComputedTiming().iterations;
      return typeof iterations === "number" && Number.isFinite(iterations);
    });
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function openFirstLinkedTask(page: Page) {
  const taskIndicator = page
    .getByTestId("bitbucket-pr-row")
    .filter({ hasText: "Success pipeline · approved" })
    .locator(
      '[data-testid^="bitbucket-pr-"][data-testid$="-task-single"], [data-testid^="bitbucket-pr-"][data-testid$="-task-multi"]',
    )
    .first();
  await expect(taskIndicator).toBeVisible();
  const testId = await taskIndicator.getAttribute("data-testid");
  await taskIndicator.tap();
  if (testId?.endsWith("-multi")) await page.getByRole("menuitem").first().tap();
  await expect(page).toHaveURL(/\/t\/[^/?]+/);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/bitbucket");
  await expect(page.getByTestId("bitbucket-workbench")).toBeVisible();
});

test("uses a one-dimensional pull-request list with external titles and one Task action", async ({ page }) => {
  const workbench = page.getByTestId("bitbucket-workbench");
  const queue = workbench.getByTestId("bitbucket-pr-queue");

  await expect(queue).toBeVisible();
  await expect(workbench.getByTestId("bitbucket-connection-health")).toHaveCount(0);
  await expectNoDocumentHorizontalOverflow(page);

  await expect(queue.getByRole("button", { name: /Review pull request/ })).toHaveCount(0);
  await expect(queue.locator('a[target="_blank"]').first()).toHaveAttribute("href", /bitbucket/);
  const taskButton = queue.getByTestId("bitbucket-start-task-trigger").first();
  expect((await taskButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await taskButton.tap();
  await expect(page.getByTestId("bitbucket-start-task-preset")).toHaveCount(3);
  await expect(
    page.locator('[data-preset-id="review"] svg.tabler-icon-eye'),
  ).toBeVisible();
  await expect(
    page.locator('[data-preset-id="address-feedback"] svg.tabler-icon-message-dots'),
  ).toBeVisible();
  await expect(
    page.locator('[data-preset-id="fix-ci"] svg.tabler-icon-tool'),
  ).toBeVisible();
  await expectNoDocumentHorizontalOverflow(page);
});

test("contains native scope and saved-query controls in the mobile sheet", async ({ page }) => {
  const filterTrigger = page.getByRole("button", { name: "Open Bitbucket filters" });
  await expect(filterTrigger.locator('[data-integration-icon="filter"]')).toBeVisible();
  await filterTrigger.tap();

  await expect(page.getByRole("heading", { name: "Bitbucket filters" })).toBeVisible();
  await expect(page.getByLabel("Repository")).toBeVisible();
  await expect(page.getByTestId("bitbucket-scope-bar")).toBeVisible();
  await page.getByTestId("bitbucket-scope-bar").getByRole("button", { name: "Merged" }).tap();
  await expect(page.getByTestId("bitbucket-list-query")).toHaveValue("state:merged");

  await filterTrigger.tap();
  await page.getByTestId("bitbucket-saved-filters").tap();
  await page.getByRole("menuitem", { name: "Save current query" }).click();
  const saveDialog = page.getByRole("dialog", { name: "Save query" });
  await expect(saveDialog).toBeVisible();
  await saveDialog.getByLabel("Name").fill("Merged queue");
  const saveButton = saveDialog.getByRole("button", { name: "Save" });
  await waitForFiniteAnimations(page);
  expect((await saveButton.boundingBox())?.height).toBeCloseTo(44, 0);
  await saveButton.tap();
  await expect(saveDialog).toBeHidden();
  await expect(filterTrigger).toBeVisible();
  await filterTrigger.tap();
  await page.getByTestId("bitbucket-saved-filters").tap();
  await expect(page.getByRole("menuitem", { name: "Merged queue" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Watch current filters" })).toHaveCount(0);
  await expectNoDocumentHorizontalOverflow(page);
});

test("opens native task creation directly from a preset", async ({ page }) => {
  await page.getByTestId("bitbucket-start-task-trigger").first().tap();
  const reviewPreset = page.locator(
    '[data-testid="bitbucket-start-task-preset"][data-preset-id="review"]',
  );
  expect((await reviewPreset.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await reviewPreset.tap();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(
    page.getByPlaceholder("Write a prompt for the agent... (@ to insert a saved prompt)"),
  ).toHaveValue(/^Review Bitbucket pull request/);
});

test("keeps mobile connection settings and watches reachable through one scroll owner", async ({ page }) => {
  const settingsButton = page.getByRole("button", { name: "Open Bitbucket settings" });

  await expect(settingsButton).toBeVisible();
  expect((await settingsButton.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await settingsButton.tap();

  await expect(page).toHaveURL(/\/settings\/workspace\/[^/]+\/integrations\/bitbucket$/);
  await expect(page.getByTestId("bitbucket-connection-health")).toBeVisible();
  const watches = page.getByText("Watches", { exact: true });
  await watches.scrollIntoViewIfNeeded();
  await expect(watches).toBeVisible();
  await expectNoDocumentHorizontalOverflow(page);
});

test("uses shared mobile CI drawer and native Review detail", async ({ page }) => {
  await openFirstLinkedTask(page);

  const topbarStatus = page.getByTestId("integration-change-request-status-trigger");
  const composerStatus = page.getByTestId("integration-change-request-status-chip");
  await expect(topbarStatus).toHaveCount(0);
  await expect(composerStatus).toBeVisible({ timeout: 15_000 });

  await composerStatus.tap();
  const drawer = page.getByTestId("integration-change-request-status-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Pass rate", { exact: true })).toBeVisible();
  await expect(drawer.getByText("2/2 (100%)", { exact: true })).toBeVisible();
  const unlink = drawer.getByRole("button", { name: /Unlink pull request/ });
  await expect(unlink).toBeVisible();
  expect((await unlink.boundingBox())?.height).toBeGreaterThanOrEqual(44);
  await expectContainedInViewport(page, '[data-testid="integration-change-request-status-drawer"]');
  await drawer.getByRole("button", { name: "Open review" }).tap();

  const detail = page.getByTestId("change-request-detail");
  await expect(detail).toBeVisible();
  await expect(detail).toHaveAttribute("data-presentation", "mobile");
  await expect(detail.getByRole("button", { name: /Reviews — 1 approved/ })).toBeVisible();
  await expect(detail.getByRole("button", { name: /CI Checks — 2 passed/ })).toBeVisible();
  await expect(detail.getByRole("button", { name: /Comments \(2\)/ })).toBeVisible();
  await expect(detail.getByRole("tablist")).toHaveCount(0);
  await expectNoDocumentHorizontalOverflow(page);
});
