import {
  StoreRanking,
  ChannelTrends,
  ChannelExpenses,
} from "./analytics-panels";
import { useState } from "react";
import { waterfallSeries } from "@/lib/waterfall";
import type { ColumnDef } from "@tanstack/react-table";
import {
  ArrowRight,
  ArrowUpRight,
  ArrowDownRight,
  ChevronRight,
  Wallet,
  Store,
  TrendingUp,
  TriangleAlert,
  Target,
  SlidersHorizontal,
  ExternalLink,
  Package,
} from "lucide-react";
import { useApi } from "@/api/client";
import type { Analytics, Metrics, MetricRow } from "@/api/types";
import { useWorkspace } from "@/app/context";
import { Button } from "@/components/ui/button";
import {
  Panel,
  Kpis,
  QueryState,
  Change,
  Status,
} from "@/components/bi/common";
import { Chart, chartBase } from "@/components/bi/chart";
import { DataTable } from "@/components/bi/table";
import {
  money,
  compact,
  integer,
  percent,
  colors,
  channelColors,
  escapeHtml,
  trendColors,
  chartColors,
} from "@/lib/utils";
export const metricColumns: ColumnDef<any, any>[] = [
  {
    accessorKey: "name",
    header: "名称",
    cell: ({ row }) => (
      <div className="name-cell">
        <span className="table-avatar">
          <Package size={15} />
        </span>
        <span>
          <strong>{row.original.name}</strong>
          <small>{row.original.spec || row.original.id}</small>
        </span>
      </div>
    ),
  },
  {
    accessorKey: "revenue",
    header: "净销售收入",
    meta: { numeric: true },
    cell: ({ getValue }) => `¥${money(getValue())}`,
  },
  {
    accessorKey: "orders",
    header: "支付订单",
    meta: { numeric: true },
    cell: ({ getValue }) => integer(getValue()),
  },
  {
    accessorKey: "gross_profit",
    header: "商品毛利",
    meta: { numeric: true },
    cell: ({ getValue }) => `¥${money(getValue())}`,
  },
  {
    accessorKey: "profit",
    header: "已核算贡献利润",
    meta: { numeric: true },
    cell: ({ getValue }) => (
      <span
        style={{
          color:
            Number(getValue()) > 0
              ? trendColors.rise
              : Number(getValue()) < 0
                ? trendColors.fall
                : trendColors.neutral,
        }}
      >
        ¥{money(getValue())}
      </span>
    ),
  },
  {
    accessorKey: "profit_margin",
    header: "贡献利润率",
    meta: { numeric: true },
    cell: ({ getValue }) => percent(getValue()),
  },
  {
    accessorKey: "refund_rate",
    header: "退款金额率",
    meta: { numeric: true },
    cell: ({ getValue }) => percent(getValue()),
  },
  {
    accessorKey: "coverage",
    header: "核算覆盖率",
    meta: { numeric: true },
    cell: ({ getValue }) => (
      <span className={Number(getValue()) < 1 ? "warning" : ""}>
        {percent(getValue())}
      </span>
    ),
  },
];
const axisMoney = (value: number) =>
  Math.abs(value) >= 10000
    ? `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`
    : value.toLocaleString();
function useAnalytics(group = "channel") {
  const { query } = useWorkspace();
  return useApi<Analytics>(
    `/analytics?${query}&group_by=${group}&page_size=500`,
  );
}
function Coverage({ summary }: { summary: Metrics }) {
  const incomplete = Number(summary.coverage) < 1;
  const missingFx = Number(summary.missing_fx_lines || 0);
  const excluded = summary.excluded_unallocated_fees;
  if (!incomplete && !missingFx && !Number(excluded || 0)) return null;
  return (
    <div className="coverage-note">
      <span className="note-icon">
        <TriangleAlert size={14} />
      </span>
      <span>
        {incomplete && (
          <>
            部分数据待核算：已换算的未核算净销售收入{" "}
            <strong>¥{money(summary.unknown_revenue)}</strong>
            。当前利润仅覆盖已核算订单行，核算覆盖率{" "}
            <strong>{percent(summary.coverage)}</strong>。
          </>
        )}
        {missingFx > 0 && (
          <>
            {" "}
            另有 <strong>{integer(missingFx)} 条订单行缺少汇率</strong>
            ，人民币收入尚不完整。原币金额保留在订单明细，请导入对应日期汇率后预览重算。
          </>
        )}
        {Number(excluded || 0) !== 0 && (
          <>
            {" "}
            当前商品筛选未纳入 <strong>¥{money(excluded)}</strong>{" "}
            未分摊费用；这些费用仍计入店铺及整体利润。
          </>
        )}
      </span>
    </div>
  );
}
function Trend({ data }: { data: Analytics }) {
  const { setFilters, setFilter, params } = useWorkspace();
  const grain = params.get("trend_grain") || "day";
  const [metric, setMetric] = useState("revenue");
  const m = metric === "revenue" ? "净销售收入" : "支付商品收入";
  const option = {
    tooltip: {
      ...chartBase.tooltip,
      valueFormatter: (v: unknown) => `¥${money(v)}`,
    },
    grid: { left: 6, right: 22, top: 32, bottom: 12, containLabel: true },
    xAxis: {
      ...chartBase.xAxis,
      data: data.trend.map((d) => d.date.slice(5).replace("-", "/")),
      axisLabel: {
        ...chartBase.xAxis.axisLabel,
        interval: Math.max(1, Math.floor(data.trend.length / 7)),
      },
    },
    yAxis: {
      ...chartBase.yAxis,
      axisLabel: { formatter: axisMoney, color: chartColors.axis },
    },
    series: [
      {
        name: m,
        type: "line",
        data: data.trend.map((d) => Number(d[metric as keyof Metrics])),
        showSymbol: false,
        symbolSize: 7,
        lineStyle: { width: 3, color: chartColors.income },
        itemStyle: { color: chartColors.income },
        areaStyle: {
          color: {
            type: "linear",
            x: 0,
            y: 0,
            x2: 0,
            y2: 1,
            colorStops: [
              { offset: 0, color: chartColors.incomeAreaFrom },
              { offset: 1, color: chartColors.incomeAreaTo },
            ],
          },
        },
      },
      {
        name: "已核算经营贡献利润",
        type: "line",
        data: data.trend.map((d) => Number(d.profit)),
        showSymbol: false,
        lineStyle: { width: 2.75, color: chartColors.profit },
        itemStyle: { color: chartColors.profit },
      },
    ],
  };
  return (
    <Panel
      title="销售与利润趋势"
      subtitle={`按${grain === "week" ? "周" : "日"}观察经营变化，点击期间查看明细`}
      action={
        <div className="trend-controls">
          <div className="segmented small">
            <button
              className={grain === "day" ? "active" : ""}
              onClick={() => setFilter("trend_grain", "day")}
            >
              按日
            </button>
            <button
              className={grain === "week" ? "active" : ""}
              onClick={() => setFilter("trend_grain", "week")}
            >
              按周
            </button>
          </div>
          <div className="segmented small">
            <button
              className={metric === "revenue" ? "active" : ""}
              onClick={() => setMetric("revenue")}
            >
              净销售收入
            </button>
            <button
              className={metric === "sales" ? "active" : ""}
              onClick={() => setMetric("sales")}
            >
              支付收入
            </button>
          </div>
        </div>
      }
    >
      <div className="chart-legend">
        <span>
          <i style={{ background: chartColors.income }} />
          {m}
        </span>
        <span>
          <i style={{ background: chartColors.profit }} />
          已核算经营贡献利润
        </span>
        <span className="legend-unit">单位：人民币 / 元</span>
      </div>
      <Chart
        height={300}
        option={option}
        description="按日期显示净销售收入与已核算经营贡献利润"
        onClick={(e) => {
          const date = data.trend[e.dataIndex]?.date;
          if (date)
            setFilters({
              start: date,
              end: String(data.trend[e.dataIndex].end_date || date),
            });
        }}
      />
    </Panel>
  );
}
export function Overview() {
  const [allInsights, setAllInsights] = useState(false);
  const [channelMetric, setChannelMetric] = useState<"revenue" | "profit">(
    "revenue",
  );
  const { go, openTargets, openDetail } = useWorkspace();
  const q = useAnalytics();
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const d = q.data;
  return (
    <div className="page-stack" data-load-state="ready">
      <Kpis summary={d.summary} previous={d.previous} />
      <div className="business-summary">
        <span className="summary-symbol">
          <TrendingUp size={16} />
        </span>
        <div>
          <strong>经营摘要</strong>
          <p>
            {typeof d.summary.narrative === "string"
              ? d.summary.narrative
              : "正在读取后端经营摘要…"}
          </p>
        </div>
        <div className="summary-additional">
          <span>
            支付商品收入 <b>¥{compact(d.summary.sales)}</b>
          </span>
          <span>
            已核算商品毛利 <b>¥{compact(d.summary.gross_profit)}</b>
          </span>
          <span>
            核算覆盖 <b>{percent(d.summary.coverage)}</b>
          </span>
        </div>
      </div>
      <div className="overview-top">
        <Trend data={d} />
        <Panel
          title="经营关注"
          subtitle="从数据变化中，找到下一步"
          action={
            <span className="badge badge-amber">
              {d.anomalies.length} 项关注
            </span>
          }
          className="insights-panel"
        >
          <div className="insight-list">
            {d.anomalies
              .slice(0, allInsights ? d.anomalies.length : 3)
              .map((a, i) => (
                <button
                  className="insight-item"
                  key={i}
                  onClick={() =>
                    go(
                      a.target.startsWith("/") ? a.target : `/${a.target}`,
                      a.filters,
                    )
                  }
                >
                  <span
                    className={`insight-icon ${a.severity === "high" || a.severity === "danger" ? "risk" : ""}`}
                  >
                    {i === 0 ? (
                      <TrendingUp size={17} />
                    ) : i === 1 ? (
                      <TriangleAlert size={17} />
                    ) : (
                      <Package size={17} />
                    )}
                  </span>
                  <div>
                    <strong>{a.title}</strong>
                    <p>{a.description}</p>
                    <span className="insight-link">
                      查看分析 <ArrowRight size={12} />
                    </span>
                  </div>
                </button>
              ))}
            {!d.anomalies.length && (
              <div className="empty-insight">
                <span className="status-dot" />
                当前筛选范围经营数据正常
              </div>
            )}
          </div>
          <button
            className="insight-more"
            onClick={() => setAllInsights(!allInsights)}
          >
            {allInsights ? "收起关注" : `查看全部 ${d.anomalies.length} 项关注`}
            <ChevronRight size={13} />
          </button>
          <button
            className="insight-footer"
            onClick={() => go("/costs", { status: "missing_cost" })}
          >
            <span>数据完整性</span>
            <span>
              {percent(d.summary.coverage)} 已核算 <ChevronRight size={13} />
            </span>
          </button>
        </Panel>
      </div>
      <div className="overview-bottom">
        <Panel
          title="渠道经营表现"
          subtitle={
            channelMetric === "revenue"
              ? "一眼看清每个渠道的销售与利润"
              : "已核算利润贡献 · 中线为零，负值向左"
          }
          action={
            <div className="inline-controls">
              <div className="segmented small">
                <button
                  className={channelMetric === "revenue" ? "active" : ""}
                  onClick={() => setChannelMetric("revenue")}
                >
                  销售贡献
                </button>
                <button
                  className={channelMetric === "profit" ? "active" : ""}
                  onClick={() => setChannelMetric("profit")}
                >
                  利润贡献
                </button>
              </div>
              <Button variant="ghost" size="sm" onClick={() => go("/channels")}>
                详情
                <ArrowUpRight size={14} />
              </Button>
            </div>
          }
        >
          <div className="channel-summary-list">
            {d.rows.map((r, i) => (
              <button
                className="channel-summary-row"
                key={r.id}
                onClick={() => go("/channels", { channel_ids: r.id })}
              >
                <div className={`platform-icon platform-${r.id}`}>
                  {r.name === "拼多多"
                    ? "拼"
                    : r.name.includes("1688")
                      ? "1688"
                      : "T"}
                </div>
                <div className="channel-summary-name">
                  <strong>{r.name}</strong>
                  <span>{integer(r.orders)} 笔支付订单</span>
                </div>
                <div className="channel-summary-sales">
                  <strong
                    style={{
                      color:
                        Number(r[channelMetric]) < 0
                          ? trendColors.fall
                          : undefined,
                    }}
                  >
                    ¥{compact(r[channelMetric])}
                  </strong>
                  <span>
                    {channelMetric === "revenue"
                      ? "净销售收入"
                      : "已核算贡献利润"}
                  </span>
                </div>
                <div className="channel-summary-bar">
                  <div
                    className={
                      channelMetric === "profit" ? "diverging-mini-bar" : ""
                    }
                  >
                    <i
                      style={{
                        width: `${(Math.abs(Number(r[channelMetric])) / Math.max(...d.rows.map((r) => Math.abs(Number(r[channelMetric]))), 1)) * (channelMetric === "profit" ? 50 : 100)}%`,
                        left:
                          channelMetric === "profit"
                            ? Number(r.profit) < 0
                              ? `${50 - (Math.abs(Number(r.profit)) / Math.max(...d.rows.map((r) => Math.abs(Number(r.profit))), 1)) * 50}%`
                              : "50%"
                            : undefined,
                        background:
                          Number(r[channelMetric]) < 0
                            ? trendColors.fall
                            : channelColors[r.id] || colors[i],
                      }}
                    />
                  </div>
                  <span>
                    贡献利润率 <b>{percent(r.profit_margin)}</b>
                  </span>
                </div>
                <ChevronRight size={15} />
              </button>
            ))}
          </div>
          <div className="panel-footnote">
            跨渠道统一以人民币汇总 · Temu 半托管 · 汇率保留订单快照
          </div>
        </Panel>
        <Panel
          title="月度目标"
          subtitle="2026 年 9 月 · 净销售收入目标"
          action={
            <Button
              variant="ghost"
              size="icon"
              onClick={openTargets}
              aria-label="编辑月度目标"
            >
              <SlidersHorizontal size={15} />
            </Button>
          }
        >
          <div className="target-list">
            {d.targets.slice(0, 4).map((t) => (
              <button
                className="target-item"
                key={t.store_id}
                onClick={openTargets}
              >
                <div>
                  <strong>{t.name}</strong>
                  <span>{percent(t.rate)}</span>
                </div>
                <div className="progress-track">
                  <i
                    style={{
                      width: `${Math.max(0, Math.min(Number(t.rate) * 100, 100))}%`,
                    }}
                  />
                </div>
                <div className="target-amount">
                  <span>¥{compact(t.actual)}</span>
                  <span>目标 ¥{compact(t.target)}</span>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </div>
      <Coverage summary={d.summary} />
      <StoreRanking rows={(d as any).store_rankings || []} />
      <Panel
        title="经营数据速览"
        subtitle="可追溯的收入、利润和核算完整性"
        action={
          <Button variant="ghost" size="sm" onClick={() => go("/reports")}>
            前往报表中心
            <ArrowRight size={14} />
          </Button>
        }
      >
        <DataTable
          data={d.rows}
          columns={metricColumns}
          onRowClick={(r) => openDetail(r, "channel")}
        />
      </Panel>
    </div>
  );
}
export function Channels() {
  const { go } = useWorkspace();
  const q = useAnalytics();
  const [metric, setMetric] = useState<"revenue" | "profit" | "orders">(
    "revenue",
  );
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const d = q.data;
  return (
    <div className="page-stack" data-load-state="ready">
      <Kpis summary={d.summary} previous={d.previous} />
      <div className="channel-cards">
        {d.rows.map((r, i) => (
          <div className="channel-card" key={r.id}>
            <div className="channel-card-top">
              <div className={`platform-icon platform-${r.id}`}>
                {r.name === "拼多多"
                  ? "拼"
                  : r.name.includes("1688")
                    ? "1688"
                    : "T"}
              </div>
              <div>
                <h2>{r.name}</h2>
                <span>
                  {r.id === "temu"
                    ? "半托管 · 人民币核算"
                    : "多店铺经营 · 人民币核算"}
                </span>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => go("/stores", { channel_ids: r.id })}
                aria-label={`查看${r.name}店铺`}
              >
                <ArrowUpRight size={17} />
              </Button>
            </div>
            <div className="channel-card-revenue">
              <span>净销售收入</span>
              <strong>¥{compact(r.revenue)}</strong>
            </div>
            <div className="channel-card-metrics">
              <div>
                <span>贡献利润</span>
                <strong
                  style={{
                    color: Number(r.profit) < 0 ? trendColors.fall : undefined,
                  }}
                >
                  ¥{compact(r.profit)}
                </strong>
              </div>
              <div>
                <span>贡献利润率</span>
                <strong>{percent(r.profit_margin)}</strong>
              </div>
              <div>
                <span>核算覆盖</span>
                <strong>{percent(r.coverage)}</strong>
              </div>
            </div>
            <div
              className="channel-card-stripe"
              style={{ background: channelColors[r.id] || colors[i] }}
            />
          </div>
        ))}
      </div>
      <div className="two-columns">
        <Panel
          title="渠道横向对比"
          subtitle="点击柱形，定位渠道内的店铺表现"
          action={
            <select
              value={metric}
              onChange={(e) => setMetric(e.target.value as typeof metric)}
              aria-label="渠道比较指标"
            >
              <option value="revenue">净销售收入</option>
              <option value="profit">经营贡献利润</option>
              <option value="orders">支付订单数</option>
            </select>
          }
        >
          <Chart
            description="各销售渠道经营指标对比"
            option={{
              xAxis: { ...chartBase.xAxis, data: d.rows.map((r) => r.name) },
              yAxis: {
                ...chartBase.yAxis,
                axisLabel: { formatter: axisMoney },
              },
              series: [
                {
                  name:
                    metric === "revenue"
                      ? "净销售收入"
                      : metric === "profit"
                        ? "经营贡献利润"
                        : "支付订单数",
                  type: "bar",
                  barWidth: 48,
                  data: d.rows.map((r, i) => ({
                    value: Number(r[metric]),
                    itemStyle: {
                      color:
                        Number(r[metric]) < 0
                          ? trendColors.fall
                          : channelColors[r.id] || colors[i],
                      borderRadius: [5, 5, 0, 0],
                    },
                  })),
                },
              ],
            }}
            onClick={(e) =>
              go("/stores", { channel_ids: d.rows[e.dataIndex].id })
            }
          />
        </Panel>
        <Panel title="收入与贡献利润" subtitle="销售规模和盈利能力同时观察">
          <Chart
            description="渠道销售收入和贡献利润散点分析"
            option={{
              grid: {
                left: 20,
                right: 30,
                top: 40,
                bottom: 40,
                containLabel: true,
              },
              xAxis: {
                ...chartBase.yAxis,
                name: "净销售收入 / 元",
                nameLocation: "middle",
                nameGap: 42,
                axisLabel: { formatter: axisMoney },
              },
              yAxis: {
                ...chartBase.yAxis,
                name: "经营贡献利润 / 元",
                nameTextStyle: {
                  ...chartBase.yAxis.nameTextStyle,
                  align: "left",
                },
                axisLabel: { formatter: axisMoney },
              },
              tooltip: {
                trigger: "item",
                formatter: (p: any) =>
                  `${escapeHtml(p.name)}<br/>销售收入：¥${money(p.value[0])}<br/>贡献利润：¥${money(p.value[1])}`,
              },
              series: [
                {
                  type: "scatter",
                  symbolSize: 42,
                  data: d.rows.map((r, i) => ({
                    name: r.name,
                    value: [Number(r.revenue), Number(r.profit)],
                    itemStyle: {
                      color: channelColors[r.id] || colors[i],
                      opacity: 0.95,
                    },
                    label: {
                      show: true,
                      formatter: "{b}",
                      position: "top",
                      color: chartColors.axis,
                      fontSize: 14,
                    },
                  })),
                },
              ],
            }}
          />
        </Panel>
      </div>
      <div className="two-columns">
        <ChannelTrends data={d} />
        <ChannelExpenses rows={d.rows} />
      </div>
      <Coverage summary={d.summary} />
      <Panel
        title="渠道经营明细"
        subtitle="汇总利润率按金额计算，订单量按各渠道去重"
      >
        <DataTable
          data={d.rows}
          columns={[
            metricColumns[0],
            {
              accessorKey: "store_count",
              header: "店铺数",
              meta: { numeric: true },
              cell: ({ getValue }) => integer(getValue()),
            },
            ...metricColumns.slice(1),
            {
              accessorKey: "advertising_rate",
              header: "已核算广告费用率",
              meta: { numeric: true },
              cell: ({ getValue }) => percent(getValue()),
            },
            {
              accessorKey: "logistics_rate",
              header: "已核算物流费用率",
              meta: { numeric: true },
              cell: ({ getValue }) => percent(getValue()),
            },
          ]}
          onRowClick={(r) => go("/stores", { channel_ids: r.id })}
        />
      </Panel>
    </div>
  );
}
export function Stores() {
  const { openDetail, openTargets, meta, params, setFilter } = useWorkspace();
  const [display, setDisplay] = useState<"table" | "cards">("table");
  const q = useAnalytics("store");
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const d = q.data;
  const rows = d.rows.map((row) => {
    const store = meta.stores.find((s) => s.id === row.id);
    return {
      ...row,
      site: store?.site || "—",
      channel_name:
        meta.channels.find(
          (c) => c.id === (row.channel_id || store?.channel_id),
        )?.name || "—",
    };
  });
  const columns: ColumnDef<any, any>[] = [
    metricColumns[0],
    { accessorKey: "channel_name", header: "渠道" },
    { accessorKey: "site", header: "站点 / 市场" },
    metricColumns[1],
    metricColumns[2],
    {
      accessorKey: "aov",
      header: "支付客单价",
      meta: { numeric: true },
      cell: ({ getValue }) => `¥${money(getValue())}`,
    },
    metricColumns[4],
    metricColumns[5],
    {
      accessorKey: "revenue_growth",
      header: "净收入较上期",
      meta: { numeric: true },
      cell: ({ getValue }) =>
        getValue() == null ? (
          <span title="前期非正或历史不足">无可比基数</span>
        ) : (
          <span
            style={{
              color:
                Number(getValue()) > 0
                  ? trendColors.rise
                  : Number(getValue()) < 0
                    ? trendColors.fall
                    : trendColors.neutral,
            }}
          >
            {Number(getValue()) > 0 ? "+" : ""}
            {percent(getValue())}
          </span>
        ),
    },
    metricColumns[6],
    metricColumns[7],
  ];
  return (
    <div className="page-stack" data-load-state="ready">
      <Kpis summary={d.summary} previous={d.previous} />
      <div className="two-columns">
        <StoreRanking rows={d.rows} />
        <Panel
          title="目标完成进度"
          subtitle="独立自然月：2026 年 9 月，截至 9 月 28 日"
          action={
            <Button size="sm" onClick={openTargets}>
              <Target size={14} />
              调整目标
            </Button>
          }
        >
          <div className="target-list large">
            {d.targets.map((t) => (
              <button
                className="target-item"
                key={t.store_id}
                onClick={openTargets}
              >
                <div>
                  <strong>{t.name}</strong>
                  <span>{percent(t.rate)}</span>
                </div>
                <div className="progress-track">
                  <i
                    style={{
                      width: `${Math.max(0, Math.min(Number(t.rate) * 100, 100))}%`,
                    }}
                  />
                </div>
                <div className="target-amount">
                  <span>实际 ¥{compact(t.actual)}</span>
                  <span>目标 ¥{compact(t.target)}</span>
                </div>
              </button>
            ))}
          </div>
        </Panel>
      </div>
      <Coverage summary={d.summary} />
      <Panel
        title="店铺经营表现"
        subtitle="从店铺表现下钻到商品、订单和费用依据"
        action={
          <div className="inline-controls">
            <select
              aria-label="店铺表现筛选"
              value={params.get("status") || ""}
              onChange={(e) => setFilter("status", e.target.value)}
            >
              <option value="">全部表现</option>
              <option value="negative">负贡献利润</option>
              <option value="low_margin">低贡献率</option>
              <option value="high_refund">退款偏高</option>
              <option value="missing_cost">成本缺失</option>
            </select>
            <div className="segmented small">
              <button
                className={display === "table" ? "active" : ""}
                onClick={() => setDisplay("table")}
              >
                明细表
              </button>
              <button
                className={display === "cards" ? "active" : ""}
                onClick={() => setDisplay("cards")}
              >
                概览卡片
              </button>
            </div>
          </div>
        }
      >
        {display === "table" ? (
          <DataTable
            data={rows}
            columns={columns}
            onRowClick={(row) => openDetail(row, "store")}
          />
        ) : (
          <div className="store-overview-grid">
            {rows.map((row) => (
              <button
                className="store-overview-card"
                key={row.id}
                onClick={() => openDetail(row, "store")}
              >
                <div className="store-card-heading">
                  <span className={`platform-icon platform-${row.channel_id}`}>
                    <Store size={17} />
                  </span>
                  <div>
                    <strong>{row.name}</strong>
                    <span>
                      {row.channel_name} · {row.site}
                    </span>
                  </div>
                  <ArrowUpRight size={15} />
                </div>
                <div className="store-card-revenue">
                  <span>净销售收入</span>
                  <strong>¥{compact(row.revenue)}</strong>
                </div>
                <div className="store-card-metrics">
                  <div>
                    <span>支付订单</span>
                    <strong>{integer(row.orders)}</strong>
                  </div>
                  <div>
                    <span>支付客单价</span>
                    <strong>¥{money(row.aov)}</strong>
                  </div>
                  <div>
                    <span>贡献利润率</span>
                    <strong
                      style={{
                        color:
                          Number(row.profit) < 0 ? trendColors.fall : undefined,
                      }}
                    >
                      {percent(row.profit_margin)}
                    </strong>
                  </div>
                </div>
                <div className="store-card-footer">
                  <span>
                    已核算贡献利润 <b>¥{compact(row.profit)}</b>
                  </span>
                  <span>覆盖 {percent(row.coverage)}</span>
                </div>
              </button>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}
export function Products() {
  const { params, setFilter, setFilters, openDetail, go } = useWorkspace();
  const group = ["sku", "product", "listing"].includes(
    params.get("product_group") || "",
  )
    ? params.get("product_group")!
    : "sku";
  const listingPage = Math.max(1, Number(params.get("page") || "1") || 1);
  const setListingPage = (page: number) => setFilters({ page: String(page) });
  const listingSearch = params.get("search") || "";
  const listingSort = {
    id:
      params.get("sort_by") ||
      (params.get("product_view") === "contribution"
        ? "profit"
        : params.get("product_view") === "bestsellers"
          ? "units"
          : "revenue"),
    desc: params.get("sort_dir") !== "asc",
  };
  const { query } = useWorkspace();
  const listingQuery = useApi(
    `/analytics?${query}&group_by=${group}&page=${listingPage}&page_size=20&search=${encodeURIComponent(listingSearch)}&sort_by=${listingSort.id}&sort_dir=${listingSort.desc ? "desc" : "asc"}`,
  );
  const q = useAnalytics(group);
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const d = q.data;
  const views = [
    ["", "全部商品"],
    ["bestsellers", "畅销"],
    ["contribution", "高贡献"],
    ["negative", "负贡献"],
    ["low_margin", "低贡献率"],
    ["high_refund", "高退款"],
    ["missing_cost", "待核算"],
  ];
  return (
    <div className="page-stack" data-load-state="ready">
      <Kpis summary={d.summary} previous={d.previous} />
      <div className="page-subbar">
        <div className="segmented">
          {views.map(([value, label]) => (
            <button
              key={value}
              className={
                (params.get("product_view") || params.get("status") || "") ===
                value
                  ? "active"
                  : ""
              }
              onClick={() => {
                const ranking =
                  value === "bestsellers" || value === "contribution";
                setFilters({
                  status: ranking ? "" : value,
                  product_view: ranking ? value : "",
                  page: "",
                  sort_by:
                    value === "contribution"
                      ? "profit"
                      : value === "bestsellers"
                        ? "units"
                        : "revenue",
                  sort_dir: "desc",
                });
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="inline-controls">
          <Button
            onClick={() =>
              openDetail({ id: "mappings", name: "平台 SKU 映射" }, "mapping")
            }
          >
            平台 SKU 映射
          </Button>
          <Button onClick={() => go("/costs")}>
            管理商品成本
            <ArrowUpRight size={14} />
          </Button>
        </div>
      </div>
      <div className="two-columns">
        <Panel title="畅销商品 TOP 6" subtitle="统一 SKU 关联后的净销售收入">
          <Chart
            height={310}
            description="标准商品销售排名"
            option={{
              xAxis: {
                ...chartBase.yAxis,
                axisLabel: { formatter: axisMoney },
              },
              yAxis: {
                ...chartBase.xAxis,
                type: "category",
                inverse: true,
                data: d.rows.slice(0, 6).map((r) => r.name),
                axisLabel: {
                  width: 145,
                  overflow: "truncate",
                  color: chartColors.axis,
                },
              },
              series: [
                {
                  type: "bar",
                  barWidth: 17,
                  data: d.rows.slice(0, 6).map((r, i) => ({
                    value: Number(r.revenue),
                    itemStyle: {
                      color:
                        Number(r.revenue) < 0
                          ? trendColors.fall
                          : chartColors.income,
                      borderRadius: [0, 4, 4, 0],
                    },
                  })),
                },
              ],
            }}
            onClick={(e) => openDetail(d.rows[e.dataIndex], group)}
          />
        </Panel>
        <Panel
          title="商品盈利分布"
          subtitle={`关注高销售、低利润组合 · 展示收入排名前 ${d.rows.length} 个分组 / 共 ${d.total} 个`}
        >
          <Chart
            height={310}
            description="商品收入和贡献利润率分布"
            option={{
              grid: {
                left: 10,
                right: 30,
                top: 30,
                bottom: 40,
                containLabel: true,
              },
              xAxis: {
                ...chartBase.yAxis,
                name: "净销售收入",
                nameLocation: "middle",
                nameGap: 36,
                axisLabel: { formatter: axisMoney },
              },
              yAxis: {
                ...chartBase.yAxis,
                name: "贡献利润率",
                axisLabel: {
                  formatter: (v: number) => `${(v * 100).toFixed(0)}%`,
                },
              },
              tooltip: {
                trigger: "item",
                formatter: (p: any) =>
                  `${escapeHtml(p.name)}<br/>收入：¥${money(p.value[0])}<br/>贡献利润率：${percent(p.value[1])}`,
              },
              series: [
                {
                  type: "scatter",
                  symbolSize: 12,
                  data: d.rows
                    .filter((r) => r.profit_margin !== null)
                    .map((r) => ({
                      name: r.name,
                      value: [Number(r.revenue), Number(r.profit_margin)],
                      itemStyle: {
                        color:
                          Number(r.profit) < 0
                            ? trendColors.fall
                            : chartColors.profit,
                        opacity: 0.88,
                      },
                    })),
                },
              ],
            }}
          />
        </Panel>
      </div>
      <Coverage summary={d.summary} />
      <Panel
        title="商品经营明细"
        subtitle={`${params.get("product_view") === "contribution" ? "按贡献利润降序 · " : params.get("product_view") === "bestsellers" ? "按标准单位销量降序 · " : ""}同款商品跨店铺对比 · 加权成本来自历史订单快照`}
        action={
          <div className="segmented small">
            {[
              ["sku", "标准 SKU"],
              ["product", "标准商品"],
              ["listing", "平台商品"],
            ].map(([v, l]) => (
              <button
                className={group === v ? "active" : ""}
                key={v}
                onClick={() => {
                  setFilters({ product_group: v, page: "" });
                }}
              >
                {l}
              </button>
            ))}
          </div>
        }
      >
        <DataTable
          data={listingQuery.data?.rows || []}
          searchValue={listingSearch}
          sortingValue={listingSort}
          columns={[
            metricColumns[0],
            {
              accessorKey: "channel_count",
              header: "覆盖渠道",
              meta: { numeric: true },
              cell: ({ getValue }) => integer(getValue()),
            },
            {
              accessorKey: "store_count",
              header: "覆盖店铺",
              meta: { numeric: true },
              cell: ({ getValue }) => integer(getValue()),
            },
            {
              accessorKey: "units",
              header: "标准单位销量",
              meta: { numeric: true },
              cell: ({ getValue }) => integer(getValue()),
            },
            {
              accessorKey: "avg_price",
              header: "平均售价 / 标准单位",
              meta: { numeric: true },
              cell: ({ getValue }) => money(getValue(), 4),
            },
            {
              accessorKey: "weighted_unit_cost",
              header: "历史加权单位成本",
              meta: { numeric: true },
              cell: ({ getValue }) => money(getValue(), 4),
            },
            ...metricColumns.slice(1),
          ]}
          pageSize={20}
          server={{
            total: listingQuery.data?.total || 0,
            page: listingPage,
            onPageChange: setListingPage,
            onSearchChange: (v) => {
              setFilters({ search: v, page: "" });
            },
            onSortChange: (v) => {
              setFilters({
                sort_by: v.id,
                sort_dir: v.desc ? "desc" : "asc",
                page: "",
              });
            },
          }}
          onRowClick={(r) => openDetail(r, group)}
        />
      </Panel>
    </div>
  );
}
export function Profit() {
  const { openDetail, params, setFilters } = useWorkspace();
  const group = ["channel", "store", "sku"].includes(
    params.get("profit_group") || "",
  )
    ? params.get("profit_group")!
    : "channel";
  const setGroup = (value: string) =>
    setFilters({ profit_group: value, page: "" });
  const q = useAnalytics(group);
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const d = q.data;
  const waterfall = (d as any).waterfall as
    { name: string; amount: string; kind: string }[] | undefined;
  const entries =
    waterfall || d.breakdown.map((r) => ({ ...r, kind: "delta" }));
  const expenseKeys = [
    ["平台费用", "platform_fee"],
    ["包装费用", "packaging_fee"],
    ["物流费用", "logistics_fee"],
    ["广告推广费用", "advertising_fee"],
  ] as const;
  const expenseData = expenseKeys.map(([name, k]) => ({
    name,
    value: Number(d.summary[k]),
  }));
  return (
    <div className="page-stack" data-load-state="ready">
      <Kpis summary={d.summary} previous={d.previous} />
      <Coverage summary={d.summary} />
      <Panel
        title="经营贡献利润形成"
        subtitle="支付商品收入 → 退款与商品成本 → 各项费用 → 经营贡献利润 · 已核算范围"
      >
        <Chart
          height={390}
          description="经营贡献利润瀑布图，包含中间小计和各项扣减"
          option={{
            grid: {
              left: 8,
              right: 12,
              top: 24,
              bottom: 10,
              containLabel: true,
            },
            xAxis: {
              ...chartBase.xAxis,
              data: entries.map((r) => r.name),
              axisLabel: {
                interval: 0,
                width: 94,
                overflow: "break",
                fontSize: 13,
              },
            },
            yAxis: { ...chartBase.yAxis, axisLabel: { formatter: axisMoney } },
            tooltip: {
              trigger: "axis",
              formatter: (p: any) =>
                `${escapeHtml(entries[p[0].dataIndex].name)}<br/>¥${money(entries[p[0].dataIndex].amount)}`,
            },
            series: [waterfallSeries(entries)],
          }}
          onClick={(e) =>
            openDetail({ name: entries[e.dataIndex]?.name }, "expense")
          }
        />
      </Panel>
      <div className="two-columns">
        <Panel
          title="费用结构"
          subtitle="每项费用独立核算，退款通过显式调整记录抵减"
        >
          <Chart
            height={315}
            description="平台包装物流广告费用结构"
            option={{
              tooltip: {
                trigger: "item",
                valueFormatter: (v: unknown) => `¥${money(v)}`,
              },
              legend: {
                show: true,
                orient: "vertical",
                right: 16,
                top: "center",
                itemWidth: 11,
                itemHeight: 11,
                textStyle: { fontSize: 14, color: chartColors.axis },
              },
              series: [
                {
                  type: "pie",
                  radius: ["46%", "65%"],
                  center: ["33%", "49%"],
                  label: { show: false },
                  itemStyle: {
                    borderColor: chartColors.surface,
                    borderWidth: 5,
                    borderRadius: 5,
                  },
                  data: expenseData.filter((r) => r.value >= 0),
                },
              ],
            }}
            onClick={(e) => openDetail({ name: e.name }, "expense")}
          />
        </Panel>
        <Panel
          title="利润变化桥接"
          subtitle="相对于上期的算术变化，不等同于业务因果"
        >
          <div className="bridge-list">
            {((d as any).profit_bridge || []).map((r: any) => (
              <div key={r.name}>
                <span>{r.name}</span>
                <strong
                  style={{
                    color:
                      Number(r.amount) > 0
                        ? trendColors.rise
                        : Number(r.amount) < 0
                          ? trendColors.fall
                          : trendColors.neutral,
                  }}
                >
                  {Number(r.amount) > 0 ? "+" : ""}¥{money(r.amount)}
                </strong>
              </div>
            ))}
            <div className="bridge-total">
              <span>经营贡献利润变化</span>
              <Change current={d.summary.profit} previous={d.previous.profit} />
            </div>
          </div>
        </Panel>
      </div>
      <Panel
        title="经营利润表"
        subtitle="支持分组核对与费用证据追溯"
        action={
          <select
            aria-label="利润表分组"
            value={group}
            onChange={(e) => setGroup(e.target.value)}
          >
            <option value="channel">按渠道</option>
            <option value="store">按店铺</option>
            <option value="sku">按 SKU</option>
          </select>
        }
      >
        <DataTable
          data={d.rows}
          columns={[
            metricColumns[0],
            {
              accessorKey: "sales",
              header: "支付收入",
              meta: { numeric: true },
              cell: ({ getValue }) => money(getValue()),
            },
            {
              accessorKey: "refunds",
              header: "商品退款",
              meta: { numeric: true },
              cell: ({ getValue }) => money(getValue()),
            },
            {
              accessorKey: "cost",
              header: "有效商品成本",
              meta: { numeric: true },
              cell: ({ getValue }) => money(getValue()),
            },
            ...metricColumns.slice(3, 6),
          ]}
          onRowClick={(r) => openDetail(r, group)}
        />
      </Panel>
    </div>
  );
}
