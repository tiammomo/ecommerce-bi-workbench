import { expect, test, type Page } from "@playwright/test";

async function open(page: Page, route: string) {
  await page.goto(route);
  await expect(page.getByTestId("page-content")).toHaveAttribute(
    "data-load-state",
    "ready",
  );
}

test("cost maintenance, missing-cost recovery and read-only simulation work through UI", async ({
  page,
  request,
}) => {
  const query = "/api/v1/analytics?sku_ids=SKU071";
  const initial = await (await request.get(query)).json();
  expect(Number(initial.summary.coverage)).toBeLessThan(1);
  await open(page, "/costs?sku_ids=SKU071");
  await page.getByRole("button", { name: "新增成本", exact: true }).click();
  const drawer = page.getByRole("dialog");
  await drawer.getByLabel("成本标准 SKU").selectOption("SKU071");
  await drawer.getByLabel("单位成本", { exact: true }).fill("25.1234");
  await drawer.getByLabel("成本生效日期").fill("2026-04-02");
  await drawer
    .getByLabel("变更说明")
    .fill("浏览器验收：补全历史缺失的采购成本");
  await drawer.getByRole("button", { name: "预览变更" }).click();
  await expect(drawer.getByText("预览已生成 · 等待确认")).toBeVisible();
  await drawer.getByRole("button", { name: "确认保存", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const maintained = await (await request.get(query)).json();
  expect(maintained.summary.coverage).toBe(initial.summary.coverage);
  expect(maintained.summary.profit).toBe(initial.summary.profit);

  await page.getByRole("button", { name: "历史重算", exact: true }).click();
  await drawer.getByLabel("重算标准 SKU").selectOption("SKU071");
  await drawer.getByRole("button", { name: "预览重算" }).click();
  await expect(drawer.getByText("预览已生成 · 等待确认")).toBeVisible();
  await drawer.getByRole("button", { name: "确认重算", exact: true }).click();
  await expect(drawer).not.toBeVisible();
  const recovered = await (await request.get(query)).json();
  expect(recovered.summary.coverage).toBe("1.00000000");
  expect(recovered.summary.profit).not.toBe(initial.summary.profit);

  await page.getByRole("button", { name: "成本试算", exact: true }).click();
  await drawer.getByLabel("试算标准 SKU").selectOption("SKU071");
  await drawer.getByLabel("试算单位成本", { exact: true }).fill("40.0000");
  await drawer.getByRole("button", { name: "计算试算结果" }).click();
  await expect(drawer.getByText("仅试算 · 未写入经营数据")).toBeVisible();
  const firstSimulation = await drawer.locator(".simulation-delta").innerText();
  await drawer.getByLabel("试算单位成本", { exact: true }).fill("10.0000");
  await drawer.getByRole("button", { name: "计算试算结果" }).click();
  await expect(drawer.locator(".simulation-delta")).not.toHaveText(
    firstSimulation,
  );
  const afterSimulation = await (await request.get(query)).json();
  expect(afterSimulation.summary.profit).toBe(recovered.summary.profit);
  expect(afterSimulation.meta.revision).toBe(recovered.meta.revision);
});

test("saved report view restores channel and store and exports all filtered rows", async ({
  page,
  request,
}) => {
  await open(page, "/reports?channel_ids=temu&store_ids=temu-1");
  await page.getByRole("button", { name: /店铺经营报表/ }).click();
  await page.getByRole("button", { name: "保存当前视图", exact: true }).click();
  const name = "验收 · Temu 美国店铺";
  await page.getByLabel("视图名称").fill(name);
  await page.getByRole("button", { name: "保存视图", exact: true }).click();
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await page.goto("/reports");
  await page.getByRole("button", { name, exact: true }).click();
  await expect(page).toHaveURL(/store_ids=temu-1/);
  await expect(page).toHaveURL(/channel_ids=temu/);
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出全部 CSV", exact: true }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/\.csv$/);
  expect(await download.failure()).toBeNull();
  const views = await (await request.get("/api/v1/reports/views")).json();
  const view = views.items.find((row: { name: string }) => row.name === name);
  expect(view.filters.store_ids).toBe("temu-1");
});

test("CSV import UI commits valid data and blocks conflicting original records", async ({
  page,
}) => {
  await open(page, "/reports");
  await page.getByRole("button", { name: "数据导入", exact: true }).click();
  await expect(page.getByText("标准数据模板", { exact: true })).toBeVisible();
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "下载 费用记录 模板", exact: true })
    .click();
  expect(await (await downloading).failure()).toBeNull();
  const id = `UI-EXP-${Date.now()}`;
  const upload = async (amount: string) => {
    await page.getByLabel("上传 CSV 文件").setInputFiles({
      name: "expenses.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        "\uFEFFid,store_id,date,kind,amount_original,currency,fx_rate,order_id,line_id,source\n" +
          `${id},temu-1,2026-09-28,advertising,${amount},CNY,1,,,浏览器导入验收\n`,
      ),
    });
    await page.getByRole("button", { name: "预览与校验", exact: true }).click();
    await expect(page.getByText("导入校验结果", { exact: true })).toBeVisible();
  };
  await upload("2.34");
  await page.getByRole("button", { name: "确认导入", exact: true }).click();
  await expect(page.getByText("导入完成，工作区数据已更新")).toBeVisible();
  await upload("8.88");
  await expect(
    page.getByRole("button", { name: "确认导入", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "下载错误行 CSV" }),
  ).toBeVisible();
});

test("an unavailable API has an actionable retry and recovers real data", async ({
  page,
}) => {
  await page.route("**/api/v1/analytics?**", (route) =>
    route.abort("connectionrefused"),
  );
  await page.goto("/overview");
  await expect(
    page.getByText("暂时无法加载数据", { exact: true }),
  ).toBeVisible();
  await page.unroute("**/api/v1/analytics?**");
  await page.getByRole("button", { name: "重新连接", exact: true }).click();
  await expect(page.getByTestId("kpi-revenue")).toBeVisible();
  await expect(page.getByTestId("kpi-revenue")).not.toContainText("—");
});

test("channel and store controls keep metrics, export and browser history consistent", async ({
  page,
  request,
}) => {
  await open(page, "/overview");
  await page.getByTestId("channel-filter").click();
  await page.getByLabel("Temu", { exact: true }).click();
  await expect(page.getByLabel("Temu", { exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/channel_ids=temu/);
  await page.getByTestId("store-filter").click();
  await page.getByLabel("Nestora US", { exact: true }).click();
  await expect(page.getByLabel("Nestora US", { exact: true })).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/store_ids=temu-1/);
  const scoped = await (
    await request.get("/api/v1/analytics?channel_ids=temu&store_ids=temu-1")
  ).json();
  await expect(page.getByTestId("kpi-revenue")).toHaveAttribute(
    "title",
    scoped.summary.revenue,
  );
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出报表", exact: true }).click();
  const url = new URL((await downloading).url());
  expect(url.searchParams.get("channel_ids")).toBe("temu");
  expect(url.searchParams.get("store_ids")).toBe("temu-1");
  expect(await (await downloading).failure()).toBeNull();
  await page.goBack();
  await expect(page).not.toHaveURL(/store_ids=/);
  await expect(page).toHaveURL(/channel_ids=temu/);
  await page.goForward();
  await expect(page).toHaveURL(/store_ids=temu-1/);
  await expect(page.getByTestId("kpi-revenue")).toHaveAttribute(
    "title",
    scoped.summary.revenue,
  );
});

test("monthly target edits reach overview and month switching preserves separate inputs", async ({
  page,
  request,
}) => {
  await open(page, "/overview?store_ids=pdd-1");
  await page.getByRole("button", { name: "编辑月度目标", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog
    .getByLabel("栖物家居旗舰店目标", { exact: true })
    .fill("123456.78");
  const targetRow = dialog
    .locator(".target-editor")
    .filter({ hasText: "栖物家居旗舰店" });
  await targetRow.getByRole("button", { name: "保存", exact: true }).click();
  await expect(
    page.getByText("2026-09 月度目标已保存", { exact: true }),
  ).toBeVisible();
  const targets = await (
    await request.get("/api/v1/targets?month=2026-09")
  ).json();
  expect(
    targets.items.find((row: { store_id: string }) => row.store_id === "pdd-1")
      .target,
  ).toBe("123456.78");
  await dialog.getByLabel("目标月份").fill("2026-08");
  await expect(
    dialog.getByLabel("栖物家居旗舰店目标", { exact: true }),
  ).not.toHaveValue("123456.78");
  await dialog.getByRole("button", { name: "关闭抽屉" }).click();
  await expect(
    page.locator(".target-item").filter({ hasText: "栖物家居旗舰店" }),
  ).toContainText("12.35万");
});

test("refund date basis changes actual results and survives refresh", async ({
  page,
  request,
}) => {
  const paid = await (
    await request.get("/api/v1/refunds?date_basis=paid")
  ).json();
  const events = await (
    await request.get("/api/v1/refunds?date_basis=refund")
  ).json();
  expect(events.summary.amount).not.toBe(paid.summary.amount);
  await open(page, "/refunds");
  await page.getByRole("button", { name: "退款发生时间", exact: true }).click();
  await expect(page).toHaveURL(/date_basis=refund/);
  await expect(
    page.getByText("无同批订单收入分母", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("当期事件口径", { exact: true })).toBeVisible();
});

test("store cost comparison shows all three inheritance levels and detail drawer fits", async ({
  page,
}) => {
  await open(page, "/costs?sku_ids=SKU001");
  await page
    .getByRole("button", { name: "渠道 / 店铺成本对照", exact: true })
    .click();
  await expect(page.getByTestId("cost-table")).toContainText("¥15.9000");
  await expect(page.getByTestId("cost-table")).toContainText("¥16.8000");
  await expect(page.getByTestId("cost-table")).toContainText("店铺覆盖");
  await expect(page.getByTestId("cost-table")).toContainText("渠道覆盖");
  await page.getByTestId("cost-table").locator("tbody tr").first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog")).toContainText("各店铺实际继承成本");
  await page.screenshot({
    path: "docs/screenshots/cost-detail-1440.png",
    fullPage: true,
  });
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(1440);
});
