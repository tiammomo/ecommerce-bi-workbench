import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, Package, Info, RefreshCw } from "lucide-react";
import { useApi, post, request, idempotencyKey } from "@/api/client";
import { useWorkspace } from "@/app/context";
import { Sheet } from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { DataTable } from "@/components/bi/table";
import { Panel, QueryState, Status } from "@/components/bi/common";
import { Chart, chartBase } from "@/components/bi/chart";
import {
  money,
  percent,
  shortDate,
  integer,
  compact,
  trendColors,
  chartColors,
} from "@/lib/utils";

const refundNames: Record<string, string> = {
  refund_only: "仅退款",
  return_refund: "退货退款",
  cancel_before_shipping: "未发货取消退款",
};
const feeNames: Record<string, string> = {
  platform: "平台费用",
  packaging: "包装费用",
  logistics: "物流费用",
  advertising: "广告推广费用",
};

export function DetailDrawer({
  row,
  kind,
  onClose,
}: {
  row: any;
  kind: string;
  onClose: () => void;
}) {
  const { query, go, meta } = useWorkspace();
  const id = row?.id || row?.sku_id;
  const selectedSku = row?.sku_id || row?.id;
  const scoped = new URLSearchParams(query);
  ["page", "page_size", "group_by", "sort_by", "sort_dir"].forEach((key) =>
    scoped.delete(key),
  );
  if (kind === "sku") scoped.set("sku_ids", selectedSku);
  if (kind === "product") {
    const ids = meta.skus
      .filter((sku) => sku.product_id === id)
      .map((sku) => sku.id);
    scoped.set(
      "sku_ids",
      id === "unmapped" ? "unmapped" : ids.join(",") || "__no_matching_sku__",
    );
  }
  if (kind === "listing") {
    if (
      selectedSku === "unmapped" ||
      meta.skus.some((sku) => sku.id === selectedSku)
    )
      scoped.set("sku_ids", selectedSku);
    if (row.store_id) scoped.set("store_ids", row.store_id);
    if (row.platform_sku) scoped.set("platform_sku", row.platform_sku);
  }
  if (kind === "store") scoped.set("store_ids", id);
  if (kind === "channel") scoped.set("channel_ids", id);
  const localQuery = scoped.toString();
  const [tab, setTab] = useState("performance");
  const [compareBy, setCompareBy] = useState("channel");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ id: "date", desc: true });
  useEffect(() => {
    setPage(1);
    setSearch("");
    setTab("performance");
  }, [id, kind, localQuery]);
  const financial = ["sku", "store", "channel", "product", "listing"].includes(
    kind,
  );
  const productScope = ["sku", "product", "listing"].includes(kind);
  const group = productScope ? compareBy : kind === "channel" ? "store" : "sku";
  const analytics = useApi(
    `/analytics?${localQuery}&group_by=${group}&page_size=200`,
    financial,
  );
  const evidenceParams = new URLSearchParams(localQuery);
  evidenceParams.set("page", String(page));
  evidenceParams.set("page_size", "20");
  evidenceParams.set("sort_by", sort.id);
  evidenceParams.set("sort_dir", sort.desc ? "desc" : "asc");
  if (search) evidenceParams.set("search", search);
  const orders = useApi(
    `/orders?${evidenceParams}`,
    financial && tab === "orders",
  );
  const feeKind =
    row?.expense_type ||
    row?.kind ||
    Object.keys(feeNames).find((key) => row?.name?.includes(feeNames[key]));
  const expenseParams = new URLSearchParams(evidenceParams);
  if (feeKind && feeNames[feeKind]) expenseParams.set("kind", feeKind);
  else expenseParams.delete("kind");
  const expenses = useApi(`/expenses?${expenseParams}`, kind === "expense");
  const refundParams = new URLSearchParams(localQuery);
  refundParams.set("refund_id", id || "");
  refundParams.set("page_size", "1");
  const refundQuery = useApi(`/refunds?${refundParams}`, kind === "refund");
  const refund = refundQuery.data?.items?.[0] || (row?.order_id ? row : null);
  const costParams = new URLSearchParams(localQuery);
  costParams.set("effective_date", meta.as_of.slice(0, 10));
  costParams.set("page_size", "200");
  const costs = useApi(
    `/costs?${costParams}`,
    productScope && tab === "performance",
  );
  const labels: Record<string, string> = {
    sku: "标准 SKU 经营详情",
    product: "标准商品详情",
    listing: "平台商品详情",
    store: "店铺经营详情",
    channel: "渠道经营详情",
    expense: "费用来源与分摊",
    refund: "退款事件详情",
    mapping: "平台 SKU 映射",
  };
  const filters = Object.fromEntries(scoped.entries());
  const detailTitle =
    kind === "refund"
      ? refund?.name || "退款事件详情"
      : kind === "expense"
        ? feeNames[feeKind] || "费用来源与分摊"
        : row?.name || labels[kind] || "经营明细";
  const compareColumns: any[] = [
    {
      accessorKey: "name",
      header:
        group === "channel"
          ? "销售渠道"
          : group === "store"
            ? "店铺"
            : "标准商品",
    },
    {
      accessorKey: "revenue",
      header: "净销售收入",
      meta: { numeric: true },
      cell: ({ getValue }: any) => `¥${money(getValue())}`,
    },
    {
      accessorKey: "avg_price",
      header: "加权标准单位售价",
      meta: { numeric: true },
      cell: ({ getValue }: any) => money(getValue(), 4),
    },
    {
      accessorKey: "weighted_unit_cost",
      header: "历史加权单位成本",
      meta: { numeric: true },
      cell: ({ getValue }: any) => money(getValue(), 4),
    },
    {
      accessorKey: "logistics_fee",
      header: "物流费用",
      meta: { numeric: true },
      cell: ({ getValue }: any) => money(getValue()),
    },
    {
      accessorKey: "advertising_fee",
      header: "广告估算分摊",
      meta: { numeric: true },
      cell: ({ getValue }: any) => money(getValue()),
    },
    {
      accessorKey: "profit",
      header: "已核算贡献利润",
      meta: { numeric: true },
      cell: ({ getValue }: any) => (
        <span
          style={{
            color: Number(getValue()) < 0 ? trendColors.fall : undefined,
          }}
        >
          {money(getValue())}
        </span>
      ),
    },
    {
      accessorKey: "profit_margin",
      header: "贡献利润率",
      meta: { numeric: true },
      cell: ({ getValue }: any) => percent(getValue()),
    },
  ];
  const inherited =
    costs.data?.items.flatMap((item: any) =>
      (item.inheritance || []).map((entry: any) => ({
        ...entry,
        id: `${item.sku_id}:${entry.store_id}`,
        sku_id: item.sku_id,
        name: item.name,
        spec: item.spec,
        base_cost: item.base_cost,
      })),
    ) || [];
  const evidenceServer = (data: any) => ({
    total: data.total ?? data.items.length,
    page,
    onPageChange: setPage,
    onSearchChange: (value: string) => {
      setSearch(value);
      setPage(1);
    },
    onSortChange: (value: { id: string; desc: boolean }) => {
      setSort(value);
      setPage(1);
    },
  });
  return (
    <Sheet
      open={!!row}
      onOpenChange={(open) => !open && onClose()}
      title={detailTitle}
      description={labels[kind] || "查看来源与核算依据"}
      wide={kind !== "refund"}
    >
      {kind === "mapping" ? (
        <MappingManager />
      ) : kind === "refund" ? (
        <div className="form-stack">
          <QueryState
            loading={refundQuery.isLoading}
            error={refundQuery.error}
            retry={() => refundQuery.refetch()}
          />
          {refund ? (
            <>
              <span className="badge badge-amber">已完成退款</span>
              <div className="detail-pairs">
                {[
                  ["原订单", refund.order_id],
                  ["订单行", refund.line_id],
                  ["店铺", refund.store_name],
                  ["原订单支付日期", shortDate(refund.paid_date)],
                  ["退款完成", shortDate(refund.date)],
                  ["退款类型", refundNames[refund.kind] || refund.kind],
                  ["退款原因", refund.reason],
                  ["商品退款金额", `¥${money(refund.amount)}`],
                  ["可回收标准数量", money(refund.recoverable_quantity, 4)],
                  ["成本转回金额", `¥${money(refund.cost_reversal)}`],
                  ["订单行支付商品收入", `¥${money(refund.line_sales)}`],
                  ["订单行累计已完成退款", `¥${money(refund.line_refunds)}`],
                  [
                    "订单行剩余可退金额",
                    `¥${money(refund.remaining_refundable)}`,
                  ],
                  [
                    "原始商品成本快照",
                    `¥${money(refund.original_cost_snapshot)}`,
                  ],
                  [
                    "历史标准单位成本",
                    `¥${money(refund.unit_cost_snapshot, 4)}`,
                  ],
                  ["原订单标准单位数量", money(refund.standard_quantity, 4)],
                  ["累计商品成本转回", `¥${money(refund.total_cost_reversal)}`],
                  ["成本版本依据", refund.cost_version_id || "待核算"],
                ].map(([label, value]) => (
                  <div key={label}>
                    <span>{label}</span>
                    <strong>{value}</strong>
                  </div>
                ))}
              </div>
              <div className="inline-controls">
                <span className="muted small">历史成本来源</span>
                <Status value={refund.cost_source} />
                <Status value={refund.accounting_status} />
              </div>
              <div className="info-box">
                <Info size={17} />
                <span>
                  退款使用原支付订单汇率。本次确认可回收{" "}
                  {money(refund.recoverable_quantity, 4)}{" "}
                  个标准单位，按历史单位成本{" "}
                  {money(refund.unit_cost_snapshot, 4)} 元计算，已转回{" "}
                  {money(refund.cost_reversal)}{" "}
                  元；累计转回不超过原始成本快照。仅退款不退货时保留商品成本，平台、广告与物流费用不自动退还。
                </span>
              </div>
              <Button
                onClick={() =>
                  go("/reports", {
                    ...filters,
                    report_type: "orders",
                    order_id: refund.order_id,
                    search: "",
                    start: refund.paid_date || "2026-04-02",
                    end: refund.paid_date || meta.as_of.slice(0, 10),
                    date_basis: "paid",
                    reason: "",
                    kind: "",
                    status: "",
                  })
                }
              >
                查看原订单核算依据
                <ArrowUpRight size={14} />
              </Button>
            </>
          ) : !refundQuery.isLoading && !refundQuery.error ? (
            <div className="info-box">
              当前筛选范围内没有这笔退款。返回退款列表重新选择。
            </div>
          ) : null}
        </div>
      ) : kind === "expense" ? (
        <div className="form-stack">
          <div className="info-box">
            <Info size={17} />
            <span>
              来源金额来自费用原始记录，当前已核算分摊额可与贡献利润核对；待核算部分单列。筛选商品不会重新分摊整店费用。
            </span>
          </div>
          <QueryState
            loading={expenses.isLoading}
            error={expenses.error}
            retry={() => expenses.refetch()}
          />
          {expenses.data && (
            <DataTable
              data={expenses.data.items}
              pageSize={20}
              server={evidenceServer(expenses.data)}
              columns={[
                {
                  accessorKey: "date",
                  header: "业务日期",
                  cell: ({ getValue }: any) => shortDate(getValue()),
                },
                { accessorKey: "store_name", header: "店铺" },
                {
                  accessorKey: "kind",
                  header: "费用科目",
                  cell: ({ getValue }: any) =>
                    feeNames[getValue()] || getValue(),
                },
                { accessorKey: "source", header: "原始费用来源" },
                {
                  accessorKey: "source_amount",
                  header: "完整来源金额",
                  meta: { numeric: true },
                  cell: ({ row: current }: any) =>
                    `¥${money(current.original.source_amount ?? current.original.amount)}`,
                },
                {
                  accessorKey: "allocated_amount",
                  header: "当前已核算分摊额",
                  meta: { numeric: true },
                  cell: ({ getValue }: any) => money(getValue()),
                },
                {
                  accessorKey: "pending_amount",
                  header: "待核算分摊额",
                  meta: { numeric: true },
                  cell: ({ getValue }: any) => money(getValue()),
                },
                { accessorKey: "allocation_method", header: "分摊方法" },
                {
                  accessorKey: "allocated",
                  header: "归属状态",
                  cell: ({ getValue }: any) => (
                    <span
                      className={`badge ${getValue() ? "badge-green" : "badge-amber"}`}
                    >
                      {getValue() ? "已分摊" : "未分摊费用"}
                    </span>
                  ),
                },
                {
                  accessorKey: "order_id",
                  header: "关联订单",
                  cell: ({ getValue }: any) => getValue() || "店铺日费用",
                },
              ]}
            />
          )}
        </div>
      ) : (
        <div className="form-stack">
          <div className="detail-product">
            <span className="product-thumb large">
              <Package size={28} />
            </span>
            <div>
              <h3>{row?.name}</h3>
              <p>{row?.spec || id} · 数据截至 2026-09-28</p>
              {kind === "listing" && (
                <p>
                  平台 SKU {row.platform_sku} ·{" "}
                  {meta.stores.find((store) => store.id === row.store_id)
                    ?.name || row.store_id}
                </p>
              )}
            </div>
          </div>
          {analytics.data && (
            <div className="detail-kpis">
              <div>
                <span>净销售收入</span>
                <strong>¥{money(analytics.data.summary.revenue)}</strong>
              </div>
              <div>
                <span>
                  {analytics.data.summary.accounting_label || "经营贡献利润"}
                </span>
                <strong>¥{money(analytics.data.summary.profit)}</strong>
              </div>
              <div>
                <span>核算覆盖率</span>
                <strong>{percent(analytics.data.summary.coverage)}</strong>
              </div>
            </div>
          )}
          <div className="tabs">
            <button
              className={tab === "performance" ? "active" : ""}
              onClick={() => {
                setTab("performance");
                setPage(1);
              }}
            >
              经营对比
            </button>
            <button
              className={tab === "orders" ? "active" : ""}
              onClick={() => {
                setTab("orders");
                setPage(1);
              }}
            >
              订单与成本证据
            </button>
          </div>
          {tab === "performance" ? (
            <>
              {productScope && (
                <div className="inline-controls">
                  <span className="muted small">沿用当前渠道与店铺筛选</span>
                  <div className="segmented small">
                    <button
                      className={compareBy === "channel" ? "active" : ""}
                      onClick={() => setCompareBy("channel")}
                    >
                      按渠道对比
                    </button>
                    <button
                      className={compareBy === "store" ? "active" : ""}
                      onClick={() => setCompareBy("store")}
                    >
                      按店铺对比
                    </button>
                  </div>
                </div>
              )}
              <QueryState
                loading={analytics.isLoading}
                error={analytics.error}
                retry={() => analytics.refetch()}
              />
              {analytics.data && (
                <DetailInsights
                  data={analytics.data}
                  filterQuery={localQuery}
                  skuId={
                    ["sku", "listing"].includes(kind) ? selectedSku : undefined
                  }
                />
              )}
              {analytics.data && (
                <DataTable
                  data={analytics.data.rows}
                  columns={compareColumns}
                  pageSize={8}
                  onRowClick={(current) => {
                    if (group === "channel")
                      go("/stores", {
                        ...filters,
                        channel_ids: current.channel_id || current.id,
                        store_ids: "",
                      });
                    else if (group === "store")
                      go("/products", {
                        ...filters,
                        store_ids: current.store_id || current.id,
                      });
                    else
                      go("/products", {
                        ...filters,
                        sku_ids: current.sku_id || current.id,
                      });
                  }}
                />
              )}
              {productScope && (
                <>
                  <h3>各店铺当前成本来源</h3>
                  <p className="muted small">
                    查看 {meta.as_of.slice(0, 10)}{" "}
                    生效的单位成本；上方历史加权单位成本来自订单快照，两者日期口径分别保留。
                  </p>
                  <QueryState
                    loading={costs.isLoading}
                    error={costs.error}
                    retry={() => costs.refetch()}
                  />
                  {costs.data && (
                    <DataTable
                      data={inherited}
                      pageSize={9}
                      columns={[
                        { accessorKey: "sku_id", header: "标准 SKU" },
                        { accessorKey: "store_name", header: "店铺" },
                        {
                          accessorKey: "channel_id",
                          header: "渠道",
                          cell: ({ getValue }: any) =>
                            meta.channels.find(
                              (channel) => channel.id === getValue(),
                            )?.name || getValue(),
                        },
                        {
                          accessorKey: "base_cost",
                          header: "基础单位成本",
                          meta: { numeric: true },
                          cell: ({ getValue }: any) => money(getValue(), 4),
                        },
                        {
                          accessorKey: "unit_cost",
                          header: "当前有效单位成本",
                          meta: { numeric: true },
                          cell: ({ getValue }: any) => money(getValue(), 4),
                        },
                        {
                          accessorKey: "source",
                          header: "成本来源",
                          cell: ({ getValue }: any) => (
                            <Status value={getValue()} />
                          ),
                        },
                      ]}
                    />
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <QueryState
                loading={orders.isLoading}
                error={orders.error}
                retry={() => orders.refetch()}
              />
              {orders.data && (
                <DataTable
                  data={orders.data.items}
                  pageSize={20}
                  server={evidenceServer(orders.data)}
                  columns={[
                    {
                      accessorKey: "order_id",
                      header: "订单 / 原币金额",
                      cell: ({ row: current }: any) => (
                        <div className="stack-cell">
                          <strong>{current.original.order_id}</strong>
                          <small>
                            {current.original.currency}{" "}
                            {money(current.original.original_amount)} · 汇率{" "}
                            {current.original.fx_rate ?? "缺失"}
                          </small>
                        </div>
                      ),
                    },
                    {
                      accessorKey: "name",
                      header: "商品 / 核算状态",
                      cell: ({ row: current }: any) => (
                        <div className="stack-cell">
                          <span>{current.original.name}</span>
                          <small>
                            平台 SKU {current.original.platform_sku}
                          </small>
                          <Status value={current.original.status} />
                        </div>
                      ),
                    },
                    {
                      accessorKey: "standard_quantity",
                      header: "平台 / 标准数量",
                      meta: { numeric: true },
                      cell: ({ row: current }: any) =>
                        `${money(current.original.quantity, 2)} / ${money(current.original.standard_quantity, 2)}`,
                    },
                    {
                      accessorKey: "unit_cost",
                      header: "历史单位成本",
                      meta: { numeric: true },
                      cell: ({ row: current }: any) => (
                        <div className="stack-cell">
                          <strong>
                            {money(current.original.unit_cost, 4)}
                          </strong>
                          <Status value={current.original.cost_source} />
                        </div>
                      ),
                    },
                    {
                      accessorKey: "cost",
                      header: "有效商品成本",
                      meta: { numeric: true },
                      cell: ({ getValue }: any) => money(getValue()),
                    },
                    { accessorKey: "cost_version_id", header: "成本版本" },
                    {
                      accessorKey: "advertising_fee",
                      header: "广告估算分摊",
                      meta: { numeric: true },
                      cell: ({ getValue }: any) => money(getValue()),
                    },
                    {
                      accessorKey: "profit",
                      header: "贡献利润",
                      meta: { numeric: true },
                      cell: ({ getValue }: any) => money(getValue()),
                    },
                  ]}
                />
              )}
              <div className="info-box">
                广告按店铺每日支付商品收入比例估算分摊；订单包装、物流与平台费用按订单行收入分摊。筛选不会重新分配原始费用。
              </div>
            </>
          )}
          <div className="drawer-actions">
            {productScope && (
              <Button onClick={() => go("/costs", filters)}>
                维护该范围成本
                <ArrowUpRight size={14} />
              </Button>
            )}
            <Button
              variant="default"
              onClick={() =>
                go(
                  kind === "channel"
                    ? "/stores"
                    : kind === "store"
                      ? "/products"
                      : "/reports",
                  filters,
                )
              }
            >
              深入分析
              <ArrowUpRight size={14} />
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function DetailInsights({
  data,
  filterQuery,
  skuId,
}: {
  data: any;
  filterQuery: string;
  skuId?: string;
}) {
  const { go } = useWorkspace();
  const [eventEvidence, setEventEvidence] = useState("");
  const filters = new URLSearchParams(filterQuery);
  const start = filters.get("start") || "2026-08-30";
  const end = filters.get("end") || "2026-09-28";
  const history = useApi(
    `/costs/${encodeURIComponent(skuId || "")}/history`,
    !!skuId && skuId !== "unmapped",
  );
  const refundParams = new URLSearchParams(filterQuery);
  refundParams.set("date_basis", "refund");
  refundParams.set("page_size", "1");
  refundParams.delete("page");
  const refundDays = useApi(`/refunds?${refundParams}`);
  const days: { date: string; amount: string }[] =
    refundDays.data?.summary?.by_day || [];
  const peak = [...days].sort(
    (left, right) => Number(right.amount) - Number(left.amount),
  )[0];
  const costEvents = (history.data?.items || []).filter((version: any) => {
    const day = shortDate(version.effective_from);
    if (day < start || day > end) return false;
    const stores = filters.get("store_ids")?.split(",").filter(Boolean) || [];
    const channels =
      filters.get("channel_ids")?.split(",").filter(Boolean) || [];
    return (
      version.scope === "base" ||
      (version.scope === "store" &&
        (!stores.length || stores.includes(version.scope_id))) ||
      (version.scope === "channel" &&
        (!channels.length || channels.includes(version.scope_id)))
    );
  });
  const trend: any[] = data.trend || [];
  const labels = trend.map((point) => point.date);
  const eventsByDay = new Map<string, any[]>();
  costEvents.forEach((event: any) => {
    const date = shortDate(event.effective_from);
    eventsByDay.set(date, [...(eventsByDay.get(date) || []), event]);
  });
  const costMarkers = [...eventsByDay.entries()]
    .filter(([date]) => labels.includes(date))
    .slice(-6)
    .map(([date, versions]) => ({
      xAxis: date,
      name: "成本版本生效",
      evidence: versions
        .map(
          (version) =>
            `${date} · ${version.scope === "base" ? "基础" : version.scope === "channel" ? "渠道" : "店铺"} ${version.scope_id} · ¥${money(version.unit_cost, 4)} · ${version.note || ""} · 版本 ${version.id}`,
        )
        .join("；"),
      label: {
        show: true,
        formatter: "成本变更",
        position: "insideEndTop",
        fontSize: 13,
        color: chartColors.event,
      },
      lineStyle: { color: chartColors.event, type: "dashed" },
    }));
  const peakPoint =
    peak && labels.includes(peak.date) && Number(peak.amount) > 0
      ? {
          name: "退款完成日峰值",
          coord: [
            peak.date,
            Number(
              trend.find((point) => point.date === peak.date)?.revenue || 0,
            ),
          ],
          value: Number(peak.amount),
          evidence: `${peak.date} 实际完成退款 ¥${money(peak.amount)}，为当前范围退款完成金额最高日；此标记使用退款发生时间，与收入折线的支付归属口径分别计算。`,
          itemStyle: { color: chartColors.event },
          label: {
            show: true,
            formatter: "退款峰值",
            fontSize: 13,
            color: chartColors.surface,
            offset: [0, -2],
          },
        }
      : null;
  const fees = data.breakdown || [];
  const reasons = data.refund_reasons || [];
  const knownLabel = data.summary.accounting_label || "经营贡献利润";
  return (
    <div className="form-stack">
      <Panel
        title="收入与利润趋势"
        subtitle="当前对象、当前筛选 · 支付订单归属口径 · 人民币 / 元"
      >
        <div className="chart-legend">
          <span>
            <i style={{ background: chartColors.income }} />
            净销售收入
          </span>
          <span>
            <i style={{ background: chartColors.profit }} />
            {knownLabel}
          </span>
        </div>
        <Chart
          height={290}
          description="当前商品或店铺的每日收入与贡献利润趋势，以及可追溯的成本和退款事件"
          option={{
            grid: {
              left: 12,
              right: 14,
              top: 38,
              bottom: 14,
              containLabel: true,
            },
            tooltip: {
              ...chartBase.tooltip,
              trigger: "axis",
              valueFormatter: (value: unknown) => `¥${money(value)}`,
            },
            xAxis: {
              ...chartBase.xAxis,
              data: labels,
              axisLabel: {
                fontSize: 13,
                color: chartColors.axis,
                formatter: (value: string) => value.slice(5),
                interval: Math.max(0, Math.floor(labels.length / 6)),
              },
            },
            yAxis: {
              ...chartBase.yAxis,
              axisLabel: {
                fontSize: 13,
                color: chartColors.axis,
                formatter: (value: number) => compact(value),
              },
            },
            series: [
              {
                name: "净销售收入",
                type: "line",
                data: trend.map((point) => Number(point.revenue)),
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 2.75, color: chartColors.income },
                itemStyle: { color: chartColors.income },
                areaStyle: { opacity: 0.12, color: chartColors.income },
                markLine: { symbol: ["none", "none"], data: costMarkers },
              },
              {
                name: knownLabel,
                type: "line",
                data: trend.map((point) => Number(point.profit)),
                showSymbol: false,
                connectNulls: false,
                lineStyle: { width: 2.75, color: chartColors.profit },
                itemStyle: { color: chartColors.profit },
              },
              ...(peakPoint
                ? [
                    {
                      name: "退款完成日峰值",
                      type: "scatter",
                      symbol: "pin",
                      symbolSize: 72,
                      tooltip: {
                        trigger: "item",
                        formatter: () => peakPoint.evidence,
                      },
                      data: [{ ...peakPoint, value: peakPoint.coord }],
                    },
                  ]
                : []),
            ],
          }}
          onClick={(event) => {
            if (event.data?.evidence) setEventEvidence(event.data.evidence);
            else if (
              event.componentType === "series" &&
              event.dataIndex != null
            ) {
              const date = trend[event.dataIndex]?.date;
              if (date)
                setEventEvidence(
                  `${date} 净销售收入 ¥${money(trend[event.dataIndex].revenue)}，${knownLabel} ¥${money(trend[event.dataIndex].profit)}。`,
                );
            }
          }}
        />
        {eventEvidence && (
          <div className="info-box">
            <Info size={16} />
            <span>{eventEvidence}</span>
          </div>
        )}
        {peak && Number(peak.amount) > 0 && (
          <div className="panel-footnote">
            退款完成日峰值：{peak.date} · ¥{money(peak.amount)}
            。退款标记取事件发生时间；收入、利润折线按支付归属。
          </div>
        )}
        {costEvents.length > 0 && (
          <div
            className="form-stack"
            style={{ padding: "0 16px 16px", gap: 8 }}
          >
            <span className="muted small">
              期间成本版本事件 · 点击查看依据（覆盖规则仍以订单实际快照为准）
            </span>
            {costEvents.slice(0, 8).map((event: any) => (
              <Button
                key={event.id}
                variant="ghost"
                size="sm"
                onClick={() =>
                  setEventEvidence(
                    `${shortDate(event.effective_from)} · ${event.scope_id} · 单位成本 ¥${money(event.unit_cost, 4)} · ${event.note || "成本规则变更"} · 版本 ${event.id}`,
                  )
                }
              >
                {shortDate(event.effective_from)} · {event.scope_id} · ¥
                {money(event.unit_cost, 4)}
              </Button>
            ))}
          </div>
        )}
      </Panel>
      <Panel
        title="费用结构"
        subtitle="已核算订单的费用与已知未分摊费用；显式费用调整可为负值"
      >
        <Chart
          height={245}
          description="平台包装物流广告四类费用金额，保留正负方向"
          option={{
            grid: {
              left: 8,
              right: 32,
              top: 14,
              bottom: 14,
              containLabel: true,
            },
            tooltip: {
              ...chartBase.tooltip,
              trigger: "axis",
              valueFormatter: (value: unknown) => `¥${money(value)}`,
            },
            xAxis: {
              ...chartBase.yAxis,
              axisLabel: {
                fontSize: 13,
                formatter: (value: number) => compact(value),
              },
            },
            yAxis: {
              ...chartBase.xAxis,
              type: "category",
              inverse: true,
              data: fees.map((fee: any) => fee.name),
              axisLabel: { fontSize: 13, color: chartColors.axis },
            },
            series: [
              {
                name: "费用金额",
                type: "bar",
                barWidth: 18,
                data: fees.map((fee: any) => ({
                  value: Number(fee.amount),
                  itemStyle: {
                    color:
                      Number(fee.amount) < 0
                        ? trendColors.fall
                        : chartColors.income,
                    borderRadius: [0, 3, 3, 0],
                  },
                })),
              },
            ],
          }}
        />
        <div className="panel-footnote">
          广告为店铺每日收入比例估算分摊，商品筛选沿用已固定的费用分配。
        </div>
      </Panel>
      <Panel
        title="退款原因与成本关注"
        subtitle="与当前分析对象保持一致，可继续进入事件或维护证据"
      >
        {reasons.length ? (
          <div className="bridge-list">
            {reasons.map((reason: any) => (
              <button
                key={reason.name}
                className="insight-item"
                onClick={() =>
                  go("/refunds", {
                    ...Object.fromEntries(filters),
                    reason: reason.name,
                    date_basis: "paid",
                    page: "1",
                  })
                }
              >
                <div>
                  <strong>{reason.name}</strong>
                  <p>已完成商品退款 ¥{money(reason.value)}</p>
                </div>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="panel-footnote">当前筛选对象没有已完成退款事件。</div>
        )}
        {data.anomalies?.length ? (
          <div className="insight-list">
            {data.anomalies.map((anomaly: any, index: number) => (
              <button
                key={`${anomaly.title}-${index}`}
                className="insight-item"
                onClick={() =>
                  go(anomaly.target, {
                    ...Object.fromEntries(filters),
                    ...anomaly.filters,
                  })
                }
              >
                <span className="insight-icon">
                  <Info size={16} />
                </span>
                <div>
                  <strong>{anomaly.title}</strong>
                  <p>{anomaly.description}</p>
                </div>
                <ArrowUpRight size={14} />
              </button>
            ))}
          </div>
        ) : (
          <div className="panel-footnote">
            当前范围没有触发成本缺失、成本上涨或低利润等异常提醒。
          </div>
        )}
      </Panel>
    </div>
  );
}

function MappingManager() {
  const { meta } = useWorkspace();
  const client = useQueryClient();
  const q = useApi("/mappings");
  const [selected, setSelected] = useState<any>(null);
  const [sku, setSku] = useState("");
  const [factor, setFactor] = useState("1");
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const run = async (commit = false) => {
    setBusy(true);
    setError("");
    try {
      if (commit) {
        await post("/operations/commit", {
          preview_id: preview.preview_id,
          idempotency_key: `mapping-${preview.preview_id}`,
        });
        client.invalidateQueries();
        setSelected(null);
        setPreview(null);
        toast.success("映射已保存，历史补全请前往成本管理执行");
      } else
        setPreview(
          await post("/mappings/preview", {
            mapping_id: selected.id,
            sku_id: sku,
            unit_factor: factor,
          }),
        );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-stack">
      <div className="info-box">
        映射将平台销售单位转换为标准单位，例如 1688 的一包 = 10
        个标准单位。历史快照需通过独立重算流程更新。
      </div>
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
      {q.data && (
        <DataTable
          data={q.data.items}
          columns={[
            { accessorKey: "platform_sku", header: "平台 SKU" },
            {
              accessorKey: "store_id",
              header: "店铺",
              cell: ({ getValue }) =>
                meta.stores.find((s) => s.id === getValue())?.name ||
                getValue(),
            },
            { accessorKey: "sku_id", header: "标准 SKU" },
            { accessorKey: "unit_factor", header: "数量系数" },
            {
              accessorKey: "status",
              header: "状态",
              cell: ({ getValue }) => <Status value={getValue()} />,
            },
          ]}
          onRowClick={(r) => {
            setSelected(r);
            setSku(r.sku_id || meta.skus[0]?.id);
            setFactor(String(r.unit_factor));
            setPreview(null);
          }}
        />
      )}
      {selected && (
        <>
          <h3>维护映射：{selected.platform_sku}</h3>
          <label className="field">
            关联标准 SKU
            <select
              aria-label="映射标准 SKU"
              value={sku}
              onChange={(e) => {
                setSku(e.target.value);
                setPreview(null);
              }}
            >
              {meta.skus.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.spec} ({s.id})
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            平台数量转标准数量系数
            <input
              aria-label="数量换算系数"
              value={factor}
              onChange={(e) => {
                setFactor(e.target.value);
                setPreview(null);
              }}
            />
          </label>
          <Button disabled={busy} variant="default" onClick={() => run(false)}>
            预览映射变更
          </Button>
          {preview && (
            <div className="preview-summary">
              <strong>预览已生成</strong>
              <p>
                变更映射不会自动更改历史成本快照。请在保存后按需执行历史补全。
              </p>
              <Button
                disabled={busy}
                variant="default"
                onClick={() => run(true)}
              >
                确认保存映射
              </Button>
            </div>
          )}
          {error && <p className="form-error">{error}</p>}
        </>
      )}
    </div>
  );
}
export function TargetsDrawer({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const [month, setMonth] = useState("2026-09");
  const q = useApi(`/targets?month=${month}`, open);
  const client = useQueryClient();
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState("");
  const [retryKeys, setRetryKeys] = useState<Record<string, string>>({});
  return (
    <Sheet
      open={open}
      onOpenChange={(value) => !value && onClose()}
      title="店铺月度销售目标"
      description="以店铺 × 自然月维护净销售收入目标，渠道与整体目标汇总自店铺"
    >
      <div className="form-stack">
        <label className="field">
          目标月份
          <input
            type="month"
            aria-label="目标月份"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        </label>
        <QueryState
          loading={q.isLoading}
          error={q.error}
          retry={() => q.refetch()}
        />
        {q.data?.items.map((target: any) => {
          const key = `${month}:${target.store_id}`;
          return (
            <div className="target-editor" key={key}>
              <div>
                <strong>{target.name}</strong>
                <span>
                  {month} · 实际 ¥{money(target.actual)} · 完成{" "}
                  {percent(target.rate)}
                </span>
              </div>
              <label>
                <span>¥</span>
                <input
                  aria-label={`${target.name}目标`}
                  inputMode="decimal"
                  value={values[key] ?? target.target}
                  onChange={(event) => {
                    setValues((previous) => ({
                      ...previous,
                      [key]: event.target.value,
                    }));
                    setRetryKeys((previous) => ({
                      ...previous,
                      [key]: idempotencyKey(),
                    }));
                  }}
                />
              </label>
              <Button
                size="sm"
                disabled={!!saving}
                onClick={async () => {
                  setSaving(key);
                  const mutationKey = retryKeys[key] || idempotencyKey();
                  setRetryKeys((previous) => ({
                    ...previous,
                    [key]: mutationKey,
                  }));
                  try {
                    await request(`/targets/${target.store_id}/${month}`, {
                      method: "PUT",
                      body: JSON.stringify({
                        target: values[key] ?? target.target,
                        idempotency_key: mutationKey,
                      }),
                    });
                    setValues((previous) => {
                      const next = { ...previous };
                      delete next[key];
                      return next;
                    });
                    setRetryKeys((previous) => {
                      const next = { ...previous };
                      delete next[key];
                      return next;
                    });
                    client.invalidateQueries();
                    toast.success(`${month} 月度目标已保存`);
                  } catch (error) {
                    toast.error((error as Error).message);
                  } finally {
                    setSaving("");
                  }
                }}
              >
                {saving === key ? "保存中" : "保存"}
              </Button>
            </div>
          );
        })}
      </div>
    </Sheet>
  );
}

export function HelpDrawer({
  mode,
  onClose,
}: {
  mode: "metrics" | "demo" | null;
  onClose: () => void;
}) {
  const { meta } = useWorkspace();
  const client = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={!!mode}
      onOpenChange={(o) => !o && onClose()}
      title={mode === "metrics" ? "指标口径说明" : "演示工作区"}
      description={
        mode === "metrics"
          ? "统一经营分析口径 · Asia/Shanghai · 人民币"
          : "单工作区、单演示操作人；所有业务更改保存在 SQLite"
      }
    >
      {mode === "metrics" ? (
        <div className="metric-guide">
          {[
            [
              "净销售收入",
              "支付商品收入 − 已完成商品退款金额。未支付订单不计入；商品金额采用约定不含税口径。",
            ],
            [
              "商品毛利",
              "净销售收入 − 有效商品成本。有效成本 = 原始商品成本 − 已确认可转回成本。",
            ],
            [
              "经营贡献利润",
              "商品毛利 − 平台费 − 包装费 − 物流费 − 广告费。不包含人员、房租等固定成本，不等于财务净利润。",
            ],
            [
              "已核算经营贡献利润",
              "成本、映射、汇率完整的订单行贡献利润，另扣已知未分摊费用。核算覆盖率按完整订单行数量计算；利润率分母为同一已核算子集净收入。",
            ],
            [
              "支付订单归属口径",
              "销售按支付时间过滤；该批订单的退款、成本与费用统计至演示截至日。退款发生时间视图是单独的事件流。",
            ],
            [
              "成本与汇率",
              "店铺覆盖 > 渠道覆盖 > 基础成本，先判断生效日期。单位成本保留 4 位小数。订单保存成本和汇率快照，退款使用原订单汇率。",
            ],
            [
              "费用分摊",
              "订单级费用按订单行收入分配；店铺广告费按日收入比例估算分摊。先在完整来源范围分配，再筛选；无可分摊收入时保留未分摊费用。",
            ],
            [
              "比例与前期对比",
              "汇总率按汇总金额计算。分母为 0 或净收入非正时显示 —。率变化用百分点；前期为 0 时无可比基数。180 天数据不提供虚构同比。",
            ],
          ].map(([title, text]) => (
            <section key={title}>
              <h3>{title}</h3>
              <p>{text}</p>
            </section>
          ))}
          <div className="warning-box">
            全部经营数据、费率、汇率和异常都是演示假设，不代表平台实际收费或官方结算口径。
          </div>
        </div>
      ) : (
        <div className="form-stack">
          <div className="demo-hero">
            <span className="badge badge-green">本机演示模式</span>
            <h3>每个数字，都来自同一份数据</h3>
            <p>
              9 家店铺 · 24 个标准商品 · 72 个 SKU · 连续 180
              天模拟订单。业务读写经后端 API 完成并持久化。
            </p>
          </div>
          <div className="detail-pairs">
            <div>
              <span>数据截至</span>
              <strong>{shortDate(meta.as_of)}</strong>
            </div>
            <div>
              <span>统计时区</span>
              <strong>{meta.timezone}</strong>
            </div>
            <div>
              <span>数据集版本</span>
              <strong>{meta.dataset_version}</strong>
            </div>
            <div>
              <span>工作区修订</span>
              <strong>{meta.revision}</strong>
            </div>
          </div>
          <div className="warning-box">
            恢复演示数据会删除当前工作区的成本维护、月度目标、保存视图和导入数据，并恢复固定演示场景。此操作不能从界面撤销。
          </div>
          <label className="check-option">
            <input
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            我确认恢复整个演示工作区
          </label>
          <Button
            variant="destructive"
            disabled={!confirmed || busy}
            onClick={async () => {
              setBusy(true);
              try {
                await post("/demo/reset", { confirm: true });
                client.invalidateQueries();
                toast.success("演示数据已恢复");
                setConfirmed(false);
                onClose();
              } catch (e) {
                toast.error((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <RefreshCw size={15} />
            {busy ? "正在恢复…" : "恢复演示数据"}
          </Button>
        </div>
      )}
    </Sheet>
  );
}
