import { useState } from "react";
import type { Analytics, MetricRow } from "@/api/types";
import { useWorkspace } from "@/app/context";
import { Panel } from "@/components/bi/common";
import { Chart, chartBase } from "@/components/bi/chart";
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
const axisMoney = (value: number) =>
  Math.abs(value) >= 10000
    ? `${(value / 10000).toLocaleString("zh-CN", { maximumFractionDigits: 1 })}万`
    : value.toLocaleString();
export function StoreRanking({ rows }: { rows: MetricRow[] }) {
  const { openDetail } = useWorkspace();
  const [ranking, setRanking] = useState<
    "revenue" | "profit" | "profit_margin"
  >("revenue");
  const labels = {
    revenue: "净销售收入",
    profit: "贡献利润",
    profit_margin: "贡献利润率",
  };
  const sorted = [...rows]
    .filter((r) => r[ranking] != null)
    .sort((a, b) => Number(b[ranking]) - Number(a[ranking]))
    .slice(0, 9);
  return (
    <Panel
      title="店铺经营排行"
      subtitle="同时保留销售规模与订单样本，点击查看店铺证据"
      action={
        <div className="segmented small">
          {(["revenue", "profit", "profit_margin"] as const).map((key) => (
            <button
              key={key}
              className={ranking === key ? "active" : ""}
              onClick={() => setRanking(key)}
            >
              {labels[key]}
            </button>
          ))}
        </div>
      }
    >
      <Chart
        height={340}
        description={`店铺${labels[ranking]}排名，显示订单样本与净销售收入`}
        option={{
          grid: {
            left: 8,
            right: 104,
            top: 12,
            bottom: 14,
            containLabel: true,
          },
          xAxis: {
            ...chartBase.yAxis,
            axisLabel: {
              formatter:
                ranking === "profit_margin"
                  ? (v: number) => percent(v)
                  : axisMoney,
            },
          },
          yAxis: {
            ...chartBase.xAxis,
            type: "category",
            inverse: true,
            data: sorted.map((r) => `${r.name} · ${integer(r.orders)}单`),
            axisLabel: {
              color: chartColors.axis,
              width: 190,
              overflow: "truncate",
              fontSize: 13,
            },
          },
          tooltip: {
            trigger: "axis",
            formatter: (params: any) => {
              const r = sorted[params[0].dataIndex];
              return `${escapeHtml(r.name)}<br/>${labels[ranking]}：${ranking === "profit_margin" ? percent(r[ranking]) : `¥${money(r[ranking])}`}<br/>净销售收入：¥${money(r.revenue)}<br/>支付订单：${integer(r.orders)}`;
            },
          },
          series: [
            {
              type: "bar",
              barWidth: 16,
              data: sorted.map((r) => ({
                value: Number(r[ranking]),
                itemStyle: {
                  color:
                    Number(r[ranking]) < 0
                      ? trendColors.fall
                      : channelColors[r.channel_id || ""] || chartColors.profit,
                  borderRadius: [0, 3, 3, 0],
                },
              })),
              label: {
                show: true,
                position: "right",
                fontSize: 13,
                color: chartColors.axis,
                formatter: (p: any) =>
                  ranking === "profit_margin"
                    ? percent(p.value)
                    : `¥${compact(p.value)}`,
              },
            },
          ],
        }}
        onClick={(event) => openDetail(sorted[event.dataIndex], "store")}
      />
    </Panel>
  );
}
export function ChannelTrends({ data }: { data: Analytics }) {
  const { go } = useWorkspace();
  const [metric, setMetric] = useState<
    "revenue" | "profit" | "profit_margin" | "refund_rate"
  >("revenue");
  const series = (data as any).channel_trends || [];
  const dates = [
    ...new Set<string>(
      series.flatMap((channel: any) => channel.trend.map((p: any) => p.date)),
    ),
  ].sort();
  const rate = metric === "profit_margin" || metric === "refund_rate";
  const names = {
    revenue: "净销售收入",
    profit: "经营贡献利润",
    profit_margin: "经营贡献利润率",
    refund_rate: "退款金额率",
  };
  return (
    <Panel
      title="渠道趋势对比"
      subtitle={`同一期间 · ${rate ? "比例指标，以相同口径比较" : "统一人民币金额"} · 点击渠道数据点下钻`}
      action={
        <select
          aria-label="渠道趋势指标"
          value={metric}
          onChange={(e) => setMetric(e.target.value as typeof metric)}
        >
          {Object.entries(names).map(([value, label]) => (
            <option value={value} key={value}>
              {label}
            </option>
          ))}
        </select>
      }
    >
      <div className="chart-legend">
        {series.map((channel: any, i: number) => (
          <span key={channel.id}>
            <i style={{ background: channelColors[channel.id] || colors[i] }} />
            {channel.name}
          </span>
        ))}
        <span className="legend-unit">
          {rate ? "单位：%" : "单位：人民币 / 元"}
        </span>
      </div>
      <Chart
        height={315}
        description={`拼多多、Temu和1688的${names[metric]}趋势比较`}
        option={{
          grid: { left: 9, right: 24, top: 32, bottom: 14, containLabel: true },
          tooltip: {
            ...chartBase.tooltip,
            valueFormatter: (value: unknown) =>
              rate ? percent(value) : `¥${money(value)}`,
          },
          xAxis: {
            ...chartBase.xAxis,
            data: dates.map((date) => date.slice(5).replace("-", "/")),
            axisLabel: {
              ...chartBase.xAxis.axisLabel,
              interval: Math.max(1, Math.floor(dates.length / 7)),
            },
          },
          yAxis: {
            ...chartBase.yAxis,
            axisLabel: {
              formatter: rate ? (value: number) => percent(value) : axisMoney,
            },
          },
          series: series.map((channel: any, i: number) => ({
            name: channel.name,
            type: "line",
            showSymbol: false,
            connectNulls: false,
            symbolSize: 6,
            itemStyle: { color: channelColors[channel.id] || colors[i] },
            lineStyle: {
              width: 2.75,
              color: channelColors[channel.id] || colors[i],
            },
            data: dates.map((date) => {
              const point = channel.trend.find((p: any) => p.date === date);
              return point?.[metric] == null ? null : Number(point[metric]);
            }),
          })),
        }}
        onClick={(event) => {
          const channel = series[event.seriesIndex];
          const date = dates[event.dataIndex];
          const point = channel?.trend.find((p: any) => p.date === date);
          if (channel && date)
            go("/stores", {
              channel_ids: channel.id,
              start: date,
              end: point?.end_date || date,
            });
        }}
      />
    </Panel>
  );
}
export function ChannelExpenses({ rows }: { rows: MetricRow[] }) {
  const { go } = useWorkspace();
  const fields = [
    ["有效商品成本", "cost"],
    ["平台费用", "platform_fee"],
    ["包装费用", "packaging_fee"],
    ["物流费用", "logistics_fee"],
    ["广告费用", "advertising_fee"],
  ] as const;
  const palette = colors.slice(0, 5);
  return (
    <Panel
      title="渠道成本与费用结构"
      subtitle="已核算范围 · 各科目独立，保留负费用调整"
    >
      <Chart
        height={340}
        description="各渠道的商品成本、平台、包装、物流和广告费用堆叠对比"
        option={{
          grid: { left: 8, right: 22, top: 28, bottom: 66, containLabel: true },
          tooltip: {
            ...chartBase.tooltip,
            valueFormatter: (value: unknown) => `¥${money(value)}`,
          },
          legend: {
            show: true,
            bottom: 5,
            itemWidth: 11,
            itemHeight: 11,
            itemGap: 15,
            textStyle: { fontSize: 13, color: chartColors.axis },
          },
          xAxis: { ...chartBase.xAxis, data: rows.map((r) => r.name) },
          yAxis: { ...chartBase.yAxis, axisLabel: { formatter: axisMoney } },
          series: fields.map(([name, key], i) => ({
            name,
            type: "bar",
            stack: "expenses",
            barWidth: 50,
            data: rows.map((r) => ({
              value: Number(r[key]),
              itemStyle: {
                color: Number(r[key]) < 0 ? trendColors.fall : palette[i],
              },
            })),
            itemStyle: {
              color: palette[i],
              borderRadius: i === fields.length - 1 ? [3, 3, 0, 0] : 0,
            },
          })),
        }}
        onClick={(event) =>
          go("/stores", { channel_ids: rows[event.dataIndex].id })
        }
      />
    </Panel>
  );
}
