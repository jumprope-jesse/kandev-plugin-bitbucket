import { expect, test } from "@playwright/test";

test("renders native desktop queue and connection health from the packaged plugin", async ({ page }) => {
  await page.goto("/bitbucket");

  await expect(page.getByTestId("bitbucket-workbench")).toBeVisible();
  await expect(page.getByTestId("bitbucket-connection-health")).toBeVisible();
  await expect(page.getByRole("button", { name: "Refresh pull request queue" })).toBeVisible();
});
