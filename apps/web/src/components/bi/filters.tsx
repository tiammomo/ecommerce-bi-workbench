import { useState } from "react";
import {
  CalendarDays,
  ChevronDown,
  ListFilter,
  RotateCcw,
  X,
  Check,
} from "lucide-react";
import { Popover } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { useWorkspace, defaultStart, defaultEnd } from "@/app/context";
import { channelColors } from "@/lib/utils";
function MultiSelect({
  title,
  id,
  items,
  value,
  onChange,
}: {
  title: string;
  id: string;
  items: { id: string; name: string; color?: string }[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = value.split(",").filter(Boolean);
  return (
    <Popover
      trigger={
        <Button data-testid={id}>
          <span className="filter-prefix">{title}</span>
          {selected.length
            ? selected.length === 1
              ? items.find((i) => i.id === selected[0])?.name || selected[0]
              : `已选 ${selected.length} 项`
            : `全部${title}`}
          <ChevronDown size={13} />
        </Button>
      }
    >
      <div className="popover-title">
        选择{title}
        <button onClick={() => onChange("")}>全选 / 重置</button>
      </div>
      {items.map((item) => (
        <label className="check-option" key={item.id}>
          <input
            type="checkbox"
            checked={selected.includes(item.id)}
            onChange={() =>
              onChange(
                selected.includes(item.id)
                  ? selected.filter((s) => s !== item.id).join(",")
                  : [...selected, item.id].join(","),
              )
            }
          />
          {item.color && (
            <i style={{ background: item.color }} className="dot" />
          )}
          {item.name}
        </label>
      ))}
    </Popover>
  );
}
export function Filters() {
  const { meta, params, setFilter, setFilters } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const start = params.get("start") || defaultStart,
    end = params.get("end") || defaultEnd;
  const channels = (params.get("channel_ids") || "").split(",").filter(Boolean);
  const stores = meta.stores.filter(
    (s) => !channels.length || channels.includes(s.channel_id),
  );
  const selected = params.get("status");
  const dateOptions = [
    ["最近 7 天", "2026-09-22", "2026-09-28"],
    ["最近 30 天", defaultStart, defaultEnd],
    ["本月", "2026-09-01", "2026-09-28"],
    ["上月", "2026-08-01", "2026-08-31"],
  ];
  const statusNames: Record<string, string> = {
    negative: "贡献利润 < 0",
    low_margin: "贡献利润率 < 10%",
    missing_cost: "成本缺失 / 待核算",
    high_refund: "高退款",
  };
  return (
    <div className="filter-area">
      <div className="filter-bar">
        <div className="filter-main">
          <Popover
            trigger={
              <Button className="date-filter">
                <CalendarDays size={15} />
                {start.slice(5).replace("-", ".")} —{" "}
                {end.slice(5).replace("-", ".")}
                <span className="filter-year">{start.slice(0, 4)}</span>
                <ChevronDown size={13} />
              </Button>
            }
          >
            <div className="popover-title">分析期间</div>
            <div className="date-presets">
              {dateOptions.map(([label, s, e]) => (
                <Button
                  key={label}
                  size="sm"
                  variant={start === s && end === e ? "secondary" : "ghost"}
                  onClick={() => setFilters({ start: s, end: e })}
                >
                  {label}
                </Button>
              ))}
            </div>
            <label className="field">
              开始日期
              <input
                data-testid="date-start"
                aria-label="开始日期"
                type="date"
                value={start}
                max={end}
                onChange={(e) => setFilter("start", e.target.value)}
              />
            </label>
            <label className="field">
              结束日期
              <input
                data-testid="date-end"
                aria-label="结束日期"
                type="date"
                value={end}
                min={start}
                max={defaultEnd}
                onChange={(e) => setFilter("end", e.target.value)}
              />
            </label>
            <p className="muted small">对比之前相邻的等长期间 · 上海时间</p>
          </Popover>
          <span className="filter-divider" />
          <MultiSelect
            title="渠道"
            id="channel-filter"
            items={meta.channels.map((channel) => ({
              ...channel,
              color: channelColors[channel.id],
            }))}
            value={params.get("channel_ids") || ""}
            onChange={(value) => {
              const selectedStores = (params.get("store_ids") || "")
                .split(",")
                .filter(
                  (id) =>
                    !value ||
                    meta.stores.some(
                      (s) =>
                        s.id === id && value.split(",").includes(s.channel_id),
                    ),
                );
              setFilters({
                channel_ids: value,
                store_ids: selectedStores.join(","),
              });
            }}
          />
          <MultiSelect
            title="店铺"
            id="store-filter"
            items={stores}
            value={params.get("store_ids") || ""}
            onChange={(v) => setFilter("store_ids", v)}
          />
          <Button
            variant={expanded ? "secondary" : "ghost"}
            onClick={() => setExpanded(!expanded)}
          >
            <ListFilter size={14} />
            更多筛选
          </Button>
        </div>
        <div className="filter-right">
          <span
            className="comparison"
            title="红色表示上涨，绿色表示下降；颜色仅表示数值方向，不代表经营好坏"
          >
            对比上期
            <span className="trend-rise">↑ 涨</span>
            <span className="trend-fall">↓ 跌</span>
          </span>
          <Button
            variant="ghost"
            size="icon"
            aria-label="重置筛选"
            title="重置筛选"
            onClick={() =>
              setFilters({
                start: "",
                end: "",
                channel_ids: "",
                store_ids: "",
                sku_ids: "",
                category: "",
                status: "",
                search: "",
                reason: "",
                kind: "",
                date_basis: "",
                page: "",
                sort_by: "",
                sort_dir: "",
              })
            }
          >
            <RotateCcw size={14} />
          </Button>
        </div>
      </div>
      {expanded && (
        <div className="extra-filters">
          <label>
            商品分类
            <select
              aria-label="商品分类"
              value={params.get("category") || ""}
              onChange={(e) => setFilter("category", e.target.value)}
            >
              <option value="">全部分类</option>
              {[...new Set(meta.products.map((p) => p.category))].map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </label>
          <label>
            标准 SKU
            <select
              aria-label="标准 SKU"
              value={params.get("sku_ids") || ""}
              onChange={(e) => setFilter("sku_ids", e.target.value)}
            >
              <option value="">全部商品与规格</option>
              {meta.skus.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} · {s.spec} ({s.id})
                </option>
              ))}
            </select>
          </label>
          <label>
            异常状态
            <select
              aria-label="异常状态"
              value={selected || ""}
              onChange={(e) => setFilter("status", e.target.value)}
            >
              <option value="">全部状态</option>
              {Object.entries(statusNames).map(([value, label]) => (
                <option value={value} key={value}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      {(selected ||
        params.get("sku_ids") ||
        params.get("category") ||
        channels.length ||
        params.get("store_ids")) && (
        <div className="active-filters">
          <span>
            <Check size={12} />
            当前条件
          </span>
          {["channel_ids", "store_ids", "sku_ids", "category", "status"]
            .filter((k) => params.get(k))
            .map((key) => (
              <button key={key} onClick={() => setFilter(key, "")}>
                {key === "status"
                  ? statusNames[params.get(key)!] || params.get(key)
                  : key === "channel_ids"
                    ? `渠道：${channels.map((c) => meta.channels.find((i) => i.id === c)?.name || c).join("、")}`
                    : key === "store_ids"
                      ? `店铺：${params
                          .get(key)
                          ?.split(",")
                          .map(
                            (c) =>
                              meta.stores.find((i) => i.id === c)?.name || c,
                          )
                          .join("、")}`
                      : key === "sku_ids"
                        ? `SKU：${params.get(key)}`
                        : params.get(key)}
                <X size={12} />
              </button>
            ))}
        </div>
      )}
    </div>
  );
}
