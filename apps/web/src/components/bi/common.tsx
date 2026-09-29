import type { ReactNode } from "react";
import {
  ArrowUpRight,
  ArrowDownRight,
  Info,
  RefreshCw,
  CircleAlert,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { compact, integer, percent, money } from "@/lib/utils";
import type { Metrics } from "@/api/types";
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = "",
}: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`panel ${className}`}>
      <div className="panel-heading">
        <div>
          <h2>{title}</h2>
          {subtitle && <p>{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}
export function Change({
  current,
  previous,
  rate = false,
}: {
  current: unknown;
  previous: unknown;
  rate?: boolean;
}) {
  if (
    current == null ||
    previous == null ||
    (typeof current === "string" && current.trim() === "") ||
    (typeof previous === "string" && previous.trim() === "")
  )
    return <span className="muted">历史数据不足</span>;
  const now = Number(current),
    before = Number(previous),
    delta = now - before;
  if (![now, before, delta].every(Number.isFinite))
    return <span className="muted">历史数据不足</span>;
  if (delta === 0) return <span className="change-neutral">持平</span>;
  const direction = delta > 0 ? "change-positive" : "change-negative";
  if (rate)
    return (
      <span className={direction}>
        {delta > 0 ? "+" : ""}
        {money(delta * 100, 1)} 个百分点
      </span>
    );
  if (before <= 0)
    return (
      <span className={direction}>
        {before < 0 && now > 0
          ? "由亏转盈"
          : before < 0
            ? `变化 ${delta > 0 ? "+" : "-"}¥${compact(Math.abs(delta))}`
            : "无可比基数"}
      </span>
    );
  return (
    <span className={direction}>
      {delta > 0 ? <ArrowUpRight size={13} /> : <ArrowDownRight size={13} />}{" "}
      {delta > 0 ? "+" : "-"}
      {money(Math.abs(delta / before) * 100, 1)}%
    </span>
  );
}
export function Kpis({
  summary,
  previous,
}: {
  summary: Metrics;
  previous: Metrics;
}) {
  const incomplete = Number(summary.coverage) < 1;
  const cards = [
    {
      key: "profit",
      label: incomplete ? "已核算经营贡献利润" : "经营贡献利润",
      value: summary.profit,
      caption: `核算覆盖率 ${percent(summary.coverage)}`,
      primary: true,
    },
    {
      key: "revenue",
      label:
        summary.sales_complete === false ? "已换算净销售收入" : "净销售收入",
      value: summary.revenue,
      caption:
        summary.sales_complete === false
          ? "有订单缺少汇率，当前人民币总额不完整"
          : "扣除已完成商品退款",
      primary: true,
    },
    {
      key: "orders",
      label: "支付订单数",
      value: summary.orders,
      caption: "按支付订单去重",
      count: true,
    },
    {
      key: "aov",
      label: "支付客单价",
      value: summary.aov,
      caption: "支付收入 / 支付订单数",
    },
    {
      key: "profit_margin",
      label: "经营贡献利润率",
      value: summary.profit_margin,
      caption: "已核算净收入为分母",
      rate: true,
    },
    {
      key: "refund_rate",
      label: "退款金额率",
      value: summary.refund_rate,
      caption: "已完成退款 / 支付收入",
      rate: true,
    },
  ];
  return (
    <div className="kpi-grid">
      {cards.map((card) => (
        <div
          className={`kpi kpi-${card.key} ${card.primary ? "kpi-primary" : ""} ${card.key === "profit" && Number(card.value) < 0 ? "kpi-loss" : ""}`}
          key={card.key}
        >
          <div className="kpi-label">
            {card.label}
            <span title={card.caption}>
              <Info size={12} />
            </span>
          </div>
          <div
            className="kpi-number"
            data-testid={`kpi-${card.key}`}
            title={String(card.value ?? "—")}
          >
            {!card.rate && !card.count && <span className="currency">¥</span>}
            {card.count
              ? integer(card.value)
              : card.rate
                ? percent(card.value)
                : compact(card.value)}
          </div>
          <div className="kpi-bottom">
            <Change
              current={card.value}
              previous={previous[card.key as keyof Metrics]}
              rate={card.rate}
            />
            <span>较上期</span>
          </div>
          {card.key === "profit" && <span className="kpi-line" />}
        </div>
      ))}
    </div>
  );
}
export function QueryState({
  loading,
  error,
  retry,
}: {
  loading: boolean;
  error: Error | null;
  retry: () => void;
}) {
  if (error)
    return (
      <div className="query-error">
        <CircleAlert size={30} />
        <h2>暂时无法加载数据</h2>
        <p>{error.message}</p>
        <Button onClick={retry}>
          <RefreshCw size={15} />
          重新连接
        </Button>
      </div>
    );
  if (loading)
    return (
      <div className="loading-grid" aria-label="正在加载数据">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton" />
        ))}
        <div className="skeleton large" />
        <div className="skeleton large" />
      </div>
    );
  return null;
}
export function Status({ value }: { value: unknown }) {
  const text = String(value ?? "待核算");
  const ok = [
    "complete",
    "known",
    "accounted",
    "matched",
    "base",
    "基础成本",
    "已核算",
    "active",
    "ready",
  ].includes(text);
  const names: Record<string, string> = {
    complete: "已核算",
    known: "已核算",
    accounted: "已核算",
    matched: "已关联",
    missing_cost: "成本缺失",
    missing_mapping: "待关联",
    missing_fx: "缺少汇率",
    pending: "待核算",
    base: "基础成本",
    channel: "渠道覆盖",
    store: "店铺覆盖",
    unmapped: "待关联",
    active: "有效",
    ready: "已核算",
  };
  return (
    <span
      className={`badge ${ok ? "badge-green" : text === "store" ? "badge-blue" : text === "channel" ? "badge-violet" : "badge-amber"}`}
    >
      {names[text] || text}
    </span>
  );
}
