import { expect, test, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

async function loaded(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByTestId("page-title")).toBeVisible();
  await expect(page.getByTestId("page-content")).toHaveAttribute(
    "data-load-state",
    "ready",
  );
  await page.waitForTimeout(400);
}

test("eight real-data pages render without browser errors", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const route of [
    "overview",
    "channels",
    "stores",
    "products",
    "profit",
    "refunds",
    "reports",
    "costs",
  ]) {
    await loaded(page, "/" + route);
    await expect(page.getByTestId("page-title")).not.toBeEmpty();
    await expect(page.locator("body")).not.toContainText(
      "Internal Server Error",
    );
  }
  expect(errors).toEqual([]);
});

test("URL channel filter changes metrics and survives refresh", async ({
  page,
}) => {
  await loaded(page, "/overview");
  const all = await page.getByTestId("kpi-revenue").innerText();
  await loaded(page, "/overview?channel_ids=temu");
  const filtered = await page.getByTestId("kpi-revenue").innerText();
  expect(filtered).not.toEqual(all);
  await page.reload();
  await expect(page.getByTestId("page-content")).toHaveAttribute(
    "data-load-state",
    "ready",
  );
  await expect(page.getByTestId("kpi-revenue")).toHaveText(filtered);
});

test("overview and cost management visual evidence", async ({ page }) => {
  await mkdir("docs/screenshots", { recursive: true });
  for (const width of [1440, 1280]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ["overview", "costs"]) {
      await loaded(page, "/" + route);
      await page.screenshot({
        path: `docs/screenshots/${route}-${width}.png`,
        fullPage: true,
      });
      const overflowing = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth + 2,
      );
      expect(overflowing, `${route} global overflow at ${width}px`).toBe(false);
    }
  }
  await page.setViewportSize({ width: 768, height: 1024 });
  await loaded(page, "/overview");
  await page.screenshot({
    path: "docs/screenshots/overview-768.png",
    fullPage: true,
  });
});
