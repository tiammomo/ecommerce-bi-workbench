import { expect, test } from "@playwright/test";

function cents(value: string | number | null): bigint {
  if (value === null) return 0n;
  const text = String(value);
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const result =
    BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2));
  return negative ? -result : result;
}

test("channel/store/SKU totals reconcile to their summaries", async ({
  request,
}) => {
  for (const group of ["channel", "store", "sku"]) {
    const response = await request.get(
      `/api/v1/analytics?group_by=${group}&page_size=200`,
    );
    expect(response.ok(), await response.text()).toBeTruthy();
    const body = await response.json();
    for (const key of ["sales", "revenue", "refunds", "profit"]) {
      const total = body.rows.reduce(
        (sum: bigint, row: Record<string, string>) => sum + cents(row[key]),
        0n,
      );
      expect(total, `${group} ${key}`).toBe(cents(body.summary[key]));
    }
    expect(typeof body.summary.revenue).toBe("string");
    expect(body.trend.length).toBeGreaterThan(0);
  }
});

test("CSV export covers filtered rows and saved views persist", async ({
  request,
}) => {
  const response = await request.get(
    "/api/v1/reports/export?report_type=stores&channel_ids=temu",
  );
  expect(response.ok()).toBeTruthy();
  expect(response.headers()["content-type"]).toContain("text/csv");
  const csv = await response.text();
  expect(csv.length).toBeGreaterThan(100);
  const created = await request.post("/api/v1/reports/views", {
    data: {
      name: "E2E 临时视图",
      report_type: "stores",
      filters: { channel_ids: "temu" },
      columns: ["name", "revenue"],
      sort: { field: "revenue", direction: "desc" },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const item = await created.json();
  const list = await (await request.get("/api/v1/reports/views")).json();
  expect(
    list.items.some((row: { name: string }) => row.name === "E2E 临时视图"),
  ).toBeTruthy();
  const deletion = await request.delete(`/api/v1/reports/views/${item.id}`);
  expect(deletion.ok()).toBeTruthy();
});

test("refund event basis explicitly omits a misleading cohort rate", async ({
  request,
}) => {
  const data = await (
    await request.get("/api/v1/refunds?date_basis=refund")
  ).json();
  expect(data.items.length).toBeGreaterThan(0);
  expect(data.summary.rate).toBeNull();
});

test("future cost is previewed, committed once, and preserves historical profit", async ({
  request,
}) => {
  const query = "/api/v1/analytics?sku_ids=SKU072&store_ids=temu-1";
  const before = await (await request.get(query)).json();
  const payload = {
    sku_ids: ["SKU072"],
    scope: "store",
    scope_id: "temu-1",
    unit_cost: "88.1234",
    adjustment_type: "absolute",
    effective_from: "2026-12-01",
    note: "验收：未来成本不影响历史快照",
  };
  const response = await request.post("/api/v1/costs/preview", {
    data: payload,
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const preview = await response.json();
  const key = `e2e-future-${Date.now()}`;
  const commit = { preview_id: preview.preview_id, idempotency_key: key };
  const first = await request.post("/api/v1/operations/commit", {
    data: commit,
  });
  expect(first.ok(), await first.text()).toBeTruthy();
  const result = await first.json();
  const repeated = await request.post("/api/v1/operations/commit", {
    data: commit,
  });
  expect(repeated.ok(), await repeated.text()).toBeTruthy();
  expect((await repeated.json()).operation_id).toBe(result.operation_id);
  const after = await (await request.get(query)).json();
  expect(after.summary.profit).toBe(before.summary.profit);
  const history = await (
    await request.get("/api/v1/costs/SKU072/history")
  ).json();
  expect(
    history.items.filter((row: { note: string }) => row.note === payload.note),
  ).toHaveLength(1);
});

test("CSV preview, commit, duplicate detection and conflicts use the real database", async ({
  request,
}) => {
  const id = `E2E-EXP-${Date.now()}`;
  const makeCsv = (amount: string) =>
    Buffer.from(
      "\uFEFFid,store_id,date,kind,amount_original,currency,fx_rate,order_id,line_id,source\n" +
        `${id},pdd-1,2026-09-28,advertising,${amount},CNY,1,,,"验收，CSV 含逗号"\n`,
    );
  const preview = async (amount: string) => {
    const response = await request.post("/api/v1/imports/preview", {
      multipart: {
        files: {
          name: "expenses.csv",
          mimeType: "text/csv",
          buffer: makeCsv(amount),
        },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const first = await preview("1.23");
  expect(first.new_count).toBe(1);
  expect(first.errors).toHaveLength(0);
  const result = await request.post("/api/v1/imports/commit", {
    data: {
      preview_id: first.preview_id,
      idempotency_key: id,
    },
  });
  expect(result.ok(), await result.text()).toBeTruthy();
  const duplicate = await preview("1.23");
  expect(duplicate.duplicate_count).toBe(1);
  expect(duplicate.new_count).toBe(0);
  const conflict = await preview("9.99");
  expect(conflict.conflict_count).toBeGreaterThan(0);
  const rejected = await request.post("/api/v1/imports/commit", {
    data: {
      preview_id: conflict.preview_id,
      idempotency_key: `${id}-conflict`,
    },
  });
  expect(rejected.ok()).toBe(false);
});

test("product CSV exports respect the chosen product or listing grouping", async ({
  request,
}) => {
  const listing = await request.get(
    "/api/v1/reports/export?report_type=products&group_by=listing&channel_ids=temu&sku_ids=SKU001",
  );
  expect(listing.ok()).toBeTruthy();
  const csv = await listing.text();
  expect(csv.split("\n")[0]).toContain("platform_sku");
  expect(csv).toContain("temu-1:");
  const products = await (
    await request.get(
      "/api/v1/reports/export?report_type=products&group_by=product&sku_ids=SKU001",
    )
  ).text();
  expect(products).toContain("P001");
});
