import { X } from "lucide-react";
import { useApi } from "@/api/client";
import { useWorkspace } from "@/app/context";
import { Panel, QueryState } from "@/components/bi/common";
import { Chart } from "@/components/bi/chart";
import { DataTable } from "@/components/bi/table";
import {
  money,
  compact,
  percent,
  integer,
  shortDate,
  chartColors,
} from "@/lib/utils";

const kindNames: Record<string, string> = {
  refund_only: "仅退款",
  return_refund: "退货退款",
  cancel_before_shipping: "未发货取消退款",
};

export function Refunds() {
  const { query, params, setFilters, openDetail } = useWorkspace();
  const basis = params.get("date_basis") || "paid";
  const reason = params.get("reason") || "";
  const kind = params.get("kind") || "";
  const page = Math.max(1, Number(params.get("page")) || 1);
  const pageSize = 20;
  const requestParams = new URLSearchParams(query);
  requestParams.set("date_basis", basis);
  requestParams.set("page_size", String(pageSize));
  requestParams.set("page", String(page));
  const q = useApi(`/refunds?${requestParams}`);
  const update = (changes: Record<string, string>) =>
    setFilters({ ...changes, page: "1" });
  if (!q.data)
    return (
      <QueryState
        loading={q.isLoading}
        error={q.error}
        retry={() => q.refetch()}
      />
    );
  const data = q.data;
  const reasons = [
    ...new Set(
      [reason, ...data.reasons.map((entry: any) => entry.name)].filter(Boolean),
    ),
  ] as string[];
  return (
    <div className="page-stack" data-load-state="ready">
      <div className="basis-card">
        <div>
          <strong>退款统计口径</strong>
          <p>
            {basis === "paid"
              ? "按所选期间支付的订单归属退款，统计退款截至 2026-09-28。"
              : "按退款完成时间统计事件流，不用当期支付收入作为退款率分母。"}
          </p>
        </div>
        <div className="segmented">
          <button
            className={basis === "paid" ? "active" : ""}
            onClick={() => update({ date_basis: "paid" })}
          >
            支付订单归属
          </button>
          <button
            className={basis === "refund" ? "active" : ""}
            onClick={() => update({ date_basis: "refund" })}
          >
            退款发生时间
          </button>
        </div>
      </div>
      {(reason || kind) && (
        <div className="active-filters">
          <span>售后筛选 · 与导出保持一致</span>
          {reason && (
            <button onClick={() => update({ reason: "" })}>
              原因：{reason}
              <X size={12} />
            </button>
          )}
          {kind && (
            <button onClick={() => update({ kind: "" })}>
              类型：{kindNames[kind] || kind}
              <X size={12} />
            </button>
          )}
        </div>
      )}
      <div className="mini-kpis">
        <div>
          <span>已完成商品退款</span>
          <strong>¥{compact(data.summary.amount)}</strong>
          <small>待处理退款不计入</small>
        </div>
        <div>
          <span>退款关联订单</span>
          <strong>{integer(data.summary.orders)}</strong>
          <small>按订单唯一键去重</small>
        </div>
        <div>
          <span>{basis === "paid" ? "退款金额率" : "当期事件口径"}</span>
          <strong>{basis === "paid" ? percent(data.summary.rate) : "—"}</strong>
          <small>
            {basis === "paid"
              ? "退款 / 同批支付商品收入"
              : "无同批订单收入分母"}
          </small>
        </div>
      </div>
      <QueryState loading={false} error={q.error} retry={() => q.refetch()} />
      <div className="two-columns">
        <Panel title="退款原因分布" subtitle="关注主要售后问题，点击原因筛选">
          <Chart
            height={330}
            description="已完成退款的原因构成"
            option={{
              tooltip: {
                trigger: "item",
                valueFormatter: (value: unknown) => `¥${money(value)}`,
              },
              legend: {
                show: true,
                bottom: 8,
                itemWidth: 11,
                itemHeight: 11,
                textStyle: { fontSize: 13, color: chartColors.axis },
              },
              series: [
                {
                  type: "pie",
                  radius: ["47%", "66%"],
                  center: ["50%", "41%"],
                  label: { show: false },
                  itemStyle: {
                    borderWidth: 4,
                    borderColor: chartColors.surface,
                    borderRadius: 5,
                  },
                  data: data.reasons.map((entry: any) => ({
                    name: entry.name,
                    value: Number(entry.value),
                  })),
                },
              ],
            }}
            onClick={(event) => update({ reason: event.name })}
          />
        </Panel>
        <Panel title="退款类型" subtitle="仅退款、退货退款与未发货取消分别追踪">
          <Chart
            height={330}
            description="退款类型金额对比"
            option={{
              tooltip: {
                trigger: "axis",
                valueFormatter: (value: unknown) => `¥${money(value)}`,
              },
              xAxis: {
                type: "category",
                data: data.types.map(
                  (entry: any) => kindNames[entry.name] || entry.name,
                ),
                axisLine: { show: false },
                axisTick: { show: false },
                axisLabel: { color: chartColors.axis },
              },
              yAxis: {
                type: "value",
                name: "人民币 / 元",
                splitLine: { lineStyle: { color: chartColors.grid } },
                axisLabel: { formatter: (value: number) => compact(value) },
              },
              series: [
                {
                  type: "bar",
                  barWidth: 48,
                  itemStyle: {
                    color: chartColors.profit,
                    borderRadius: [4, 4, 0, 0],
                  },
                  data: data.types.map((entry: any) => Number(entry.value)),
                },
              ],
            }}
            onClick={(event) =>
              update({ kind: data.types[event.dataIndex]?.name || "" })
            }
          />
        </Panel>
      </div>
      <Panel
        title="退款事件明细"
        subtitle="完整分页查询；筛选、图表、退款指标和导出共用同一范围"
        action={
          <div className="inline-controls">
            <select
              aria-label="退款原因"
              value={reason}
              onChange={(event) => update({ reason: event.target.value })}
            >
              <option value="">全部原因</option>
              {reasons.map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            <select
              aria-label="退款类型"
              value={kind}
              onChange={(event) => update({ kind: event.target.value })}
            >
              <option value="">全部类型</option>
              {Object.keys(kindNames).map((name) => (
                <option key={name} value={name}>
                  {kindNames[name]}
                </option>
              ))}
            </select>
          </div>
        }
      >
        <DataTable
          data={data.items}
          pageSize={pageSize}
          server={{
            total: data.total,
            page,
            onPageChange: (value) => setFilters({ page: String(value) }),
            onSearchChange: (value) => update({ search: value }),
            onSortChange: (value) =>
              update({
                sort_by: value.id,
                sort_dir: value.desc ? "desc" : "asc",
              }),
          }}
          columns={[
            {
              accessorKey: "name",
              header: "商品 / 订单",
              cell: ({ row }) => (
                <div className="stack-cell">
                  <strong>{row.original.name}</strong>
                  <small>{row.original.order_id}</small>
                </div>
              ),
            },
            { accessorKey: "store_name", header: "店铺" },
            {
              accessorKey: "date",
              header: "退款完成日期",
              cell: ({ getValue }) => shortDate(getValue()),
            },
            {
              accessorKey: "kind",
              header: "类型",
              cell: ({ getValue }) => kindNames[getValue()] || getValue(),
            },
            { accessorKey: "reason", header: "原因" },
            {
              accessorKey: "amount",
              header: "退款金额",
              meta: { numeric: true },
              cell: ({ getValue }) => `¥${money(getValue())}`,
            },
            {
              accessorKey: "cost_reversal",
              header: "成本转回",
              meta: { numeric: true },
              cell: ({ getValue }) => `¥${money(getValue())}`,
            },
          ]}
          onRowClick={(row) => openDetail(row, "refund")}
        />
      </Panel>
    </div>
  );
}
