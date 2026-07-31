import { expect, test } from "@playwright/test";

test("uses phone-focused layout with contained filters from the packaged plugin", async ({ page }) => {
  await page.goto("/bitbucket");

  const workbench = page.getByTestId("bitbucket-workbench");
  await expect(workbench).toBeVisible();
  const filterButton = page.getByRole("button", { name: "Filter pull requests" });
  await expect(filterButton).toBeVisible();
  const filterBox = await filterButton.boundingBox();
  expect(filterBox?.height).toBeGreaterThanOrEqual(44);

  await filterButton.tap();
  await expect(page.getByRole("heading", { name: "Queue filters" })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth))
    .toBe(true);
});
