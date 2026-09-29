import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  Plus,
  History,
  FlaskConical,
  RefreshCw,
  ArrowRight,
  Info,
  Layers,
  Package,
  Check,
  ArrowUpRight,
  Link,
} from "lucide-react";
import { useApi, post, idempotencyKey } from "@/api/client";
import { useWorkspace, defaultStart, defaultEnd } from "@/app/context";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Panel, QueryState, Status } from "@/components/bi/common";
import { DataTable } from "@/components/bi/table";
import { money, percent, shortDate, integer } from "@/lib/utils";
const costSchema = z
  .object({
    sku_id: z.string().min(1, "请选择标准 SKU"),
    scope: z.enum(["base", "channel", "store"]),
    scope_id: z.string(),
    unit_cost: z
      .string()
      .min(1, "请输入单位成本")
      .refine(
        (v) => /^-?\d+(\.\d{1,4})?$/.test(v),
        "请输入合法十进制金额，最多 4 位小数",
      ),
    effective_from: z.string().min(1, "请选择生效日期"),
    note: z.string().min(3, "请填写至少 3 个字的变更说明"),
    allow_zero: z.boolean(),
  })
  .refine((v) => v.scope === "base" || v.scope_id.length > 0, {
    path: ["scope_id"],
    message: "请选择作用渠道或店铺",
  });
type CostForm = z.infer<typeof costSchema>;
function directionClass(value: unknown) {
  if (
    value == null ||
    (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(Number(value))
  )
    return "muted";
  return Number(value) > 0
    ? "positive"
    : Number(value) < 0
      ? "negative"
      : "neutral";
}
function PreviewSummary({ preview }: { preview: any }) {
  const s = preview.summary || preview;
  return (
    <div className="preview-summary">
      <div className="preview-title">
        <Check size={16} />
        预览已生成 · 等待确认
      </div>
      <div className="preview-grid">
        <div>
          <span>受影响订单</span>
          <strong>{integer(s.affected_orders ?? 0)}</strong>
        </div>
        <div>
          <span>贡献利润变化</span>
          <strong className={directionClass(s.profit_delta)}>
            {Number(s.profit_delta) > 0 ? "+" : ""}¥{money(s.profit_delta)}
          </strong>
        </div>
      </div>
      {preview.changes?.some((c: any) => c.unit_cost != null) && (
        <div className="preview-changes">
          {preview.changes.slice(0, 8).map((c: any, i: number) => (
            <div key={i}>
              <span>{c.sku_id || c.name}</span>
              <strong>
                {c.previous_cost != null
                  ? `¥${money(c.previous_cost, 4)} → `
                  : ""}
                ¥{money(c.unit_cost ?? c.new_cost, 4)}
              </strong>
              <small>
                {c.effective_from ? `生效 ${shortDate(c.effective_from)}` : ""}
                {c.close_previous?.length
                  ? ` · 结束 ${c.close_previous.length} 个旧版本`
                  : ""}
              </small>
            </div>
          ))}
        </div>
      )}
      {s.old_coverage != null && (
        <div className="preview-grid">
          <div>
            <span>范围内核算覆盖率</span>
            <strong>
              {percent(s.old_coverage)} → {percent(s.new_coverage)}
            </strong>
          </div>
          <div>
            <span>仍待核算订单行</span>
            <strong>{integer(s.new_missing_lines)}</strong>
          </div>
        </div>
      )}
      {s.note && <p>{s.note}</p>}
      {s.allocation_scopes?.length > 0 && (
        <p>
          涉及缺失汇率修复，将同时更新完整店铺 / 日费用分摊来源，共{" "}
          {s.allocation_scopes.length} 个范围。
        </p>
      )}
      <p>
        以当前数据修订号 {preview.revision ?? "—"} 为准。数据变化后需重新预览。
      </p>
    </div>
  );
}
export function Costs() {
  const { query, meta, params, setFilter } = useWorkspace();
  const client = useQueryClient();
  const [tab, setTab] = useState("table");
  const effective = params.get("cost_effective_date") || defaultEnd;
  const setEffective = (value: string) =>
    setFilter("cost_effective_date", value);
  const [mode, setMode] = useState<string | null>(null);
  const [row, setRow] = useState<any>(null);
  const [selected, setSelected] = useState<any[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [simValue, setSimValue] = useState("20");
  const [simSku, setSimSku] = useState("");
  const [onlyMissing, setOnlyMissing] = useState(true);
  const [adjustment, setAdjustment] = useState<
    "absolute" | "amount" | "percent"
  >("absolute");
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ id: "sku_id", desc: false });
  const commitRequest = useRef<{
    preview_id: string;
    idempotency_key: string;
  } | null>(null);
  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [query, effective, search]);
  const costQuery = new URLSearchParams(query);
  costQuery.set("effective_date", effective);
  costQuery.set("page_size", "10");
  costQuery.set("page", String(page));
  costQuery.set("search", search || params.get("search") || "");
  costQuery.set("sort_by", sort.id);
  costQuery.set("sort_dir", sort.desc ? "desc" : "asc");
  const q = useApi(`/costs?${costQuery}`);
  const operations = useApi("/operations", tab === "history");
  const compareStores = meta.stores.filter(
    (store) =>
      (!params.get("channel_ids") ||
        params.get("channel_ids")!.split(",").includes(store.channel_id)) &&
      (!params.get("store_ids") ||
        params.get("store_ids")!.split(",").includes(store.id)),
  );

  const history = useApi(
    `/costs/${encodeURIComponent(row?.sku_id || simSku || "")}/history`,
    !!(row?.sku_id || simSku) && mode === "history",
  );
  const form = useForm<CostForm>({
    resolver: zodResolver(costSchema),
    defaultValues: {
      sku_id: "",
      scope: "base",
      scope_id: "",
      unit_cost: "",
      effective_from: "2026-09-29",
      note: "",
      allow_zero: false,
    },
  });
  const scope = form.watch("scope");
  const open = (type: string, item?: any) => {
    setMode(type);
    setRow(item || null);
    setPreview(null);
    setError("");
    const sku =
      item?.sku_id ||
      selected[0]?.sku_id ||
      params.get("sku_ids")?.split(",")[0] ||
      "";
    setSimSku(sku || (type === "recalculate" ? "" : meta.skus[0]?.id || ""));
    setAdjustment("absolute");
    setSimValue(item?.unit_cost || "20");
    form.reset({
      sku_id: sku || meta.skus[0]?.id || "",
      scope: "base",
      scope_id: "",
      unit_cost: item?.unit_cost || "",
      effective_from: "2026-09-29",
      note: "",
      allow_zero: false,
    });
  };
  const run = async (fn: () => Promise<any>) => {
    setBusy(true);
    setError("");
    try {
      return await fn();
    } catch (e) {
      setError((e as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const doPreview = form.handleSubmit(async (values) => {
    if (mode !== "batch" || adjustment === "absolute") {
      if (Number(values.unit_cost) < 0) {
        form.setError("unit_cost", { message: "单位成本不能为负" });
        return;
      }
      if (Number(values.unit_cost) === 0 && !values.allow_zero) {
        form.setError("allow_zero", { message: "零成本需要确认业务原因" });
        return;
      }
    }
    const result = await run(() =>
      post("/costs/preview", {
        sku_ids:
          mode === "batch" ? selected.map((r) => r.sku_id) : [values.sku_id],
        scope: values.scope,
        scope_id: values.scope === "base" ? "" : values.scope_id,
        unit_cost: values.unit_cost,
        adjustment_type: mode === "batch" ? adjustment : "absolute",
        adjustment_value: values.unit_cost,
        effective_from: values.effective_from,
        note: values.note,
        allow_zero: values.allow_zero,
      }),
    );
    if (result) setPreview(result);
  });
  const commit = async () => {
    if (commitRequest.current?.preview_id !== preview.preview_id) {
      commitRequest.current = {
        preview_id: preview.preview_id,
        idempotency_key: idempotencyKey(),
      };
    }
    const result = await run(() =>
      post("/operations/commit", {
        ...commitRequest.current,
        revision: preview.revision,
      }),
    );
    if (result) {
      toast.success("操作已保存，数据已重新加载");
      setMode(null);
      client.invalidateQueries();
    }
  };
  const simulate = async () => {
    const result = await run(() =>
      post("/costs/simulate", {
        sku_ids: [simSku],
        unit_cost: simValue,
        category: params.get("category") || "",
        search: params.get("search") || "",
        status: params.get("status") || "",
        start: params.get("start") || defaultStart,
        end: params.get("end") || defaultEnd,
        channel_ids: (params.get("channel_ids") || "")
          .split(",")
          .filter(Boolean),
        store_ids: (params.get("store_ids") || "").split(",").filter(Boolean),
      }),
    );
    if (result) setPreview(result);
  };
  const recalc = async () => {
    const result = await run(() =>
      post("/recalculations/preview", {
        sku_ids: selected.length
          ? selected.map((r) => r.sku_id)
          : simSku
            ? [simSku]
            : [],
        category: params.get("category") || "",
        search: params.get("search") || "",
        status: params.get("status") || "",
        start: params.get("start") || defaultStart,
        end: params.get("end") || defaultEnd,
        channel_ids: (params.get("channel_ids") || "")
          .split(",")
          .filter(Boolean),
        store_ids: (params.get("store_ids") || "").split(",").filter(Boolean),
        only_missing: onlyMissing,
      }),
    );
    if (result) setPreview(result);
  };
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
      <div className="cost-summary">
        <div className="cost-summary-lead">
          <span className="cost-summary-symbol">
            <Layers size={25} />
          </span>
          <div>
            <span>让每一份利润，都有成本依据</span>
            <p>统一基础成本 · 渠道覆盖 · 店铺覆盖</p>
          </div>
        </div>
        <div>
          <span>基础成本覆盖率</span>
          <strong>
            {percent(d.summary.base_coverage ?? d.summary.coverage)}
          </strong>
        </div>
        <div>
          <span>销售核算覆盖率</span>
          <strong>{percent(d.summary.sales_coverage)}</strong>
        </div>
        <div>
          <span>待补成本 SKU</span>
          <strong className="warning">{d.summary.missing_count}</strong>
        </div>
        <div>
          <span>近期涨价 SKU</span>
          <strong>{d.summary.rising_count}</strong>
        </div>
        <div>
          <span>负贡献 SKU</span>
          <strong className="warning">{d.summary.negative_count}</strong>
        </div>
      </div>
      <div className="page-subbar">
        <div className="tabs">
          {[
            ["table", "商品成本表"],
            ["compare", "渠道 / 店铺成本对照"],
            ["history", "历史变更"],
          ].map(([v, l]) => (
            <button
              key={v}
              className={tab === v ? "active" : ""}
              onClick={() => setTab(v)}
            >
              {l}
            </button>
          ))}
        </div>
        <div className="inline-controls">
          <Button onClick={() => open("simulate")}>
            <FlaskConical size={14} />
            成本试算
          </Button>
          <Button onClick={() => open("recalculate")}>
            <RefreshCw size={14} />
            历史重算
          </Button>
          <Button variant="default" onClick={() => open("edit")}>
            <Plus size={15} />
            新增成本
          </Button>
        </div>
      </div>
      <Panel
        title={
          tab === "compare"
            ? "成本继承与覆盖关系"
            : tab === "history"
              ? "成本版本与变更记录"
              : "商品成本明细"
        }
        subtitle="分析期间使用顶部筛选；下方日期仅用于查看当日生效的单位成本"
        action={
          <label className="inline-controls small">
            <span>查看该日生效成本</span>
            <input
              type="date"
              aria-label="查看该日生效成本"
              value={effective}
              onChange={(e) => setEffective(e.target.value)}
            />
          </label>
        }
      >
        <div className="cost-rule-bar">
          <Info size={14} />
          <span>
            取值优先级：<b>店铺 SKU</b>
            <ArrowRight size={12} />
            <b>渠道 SKU</b>
            <ArrowRight size={12} />
            <b>基础 SKU</b>。三层为覆盖关系，普通变更保留历史订单快照。
          </span>
          {selected.length > 0 && (
            <Button size="sm" onClick={() => open("batch")}>
              批量调整 {selected.length} 项
            </Button>
          )}
        </div>
        {tab === "history" && (
          <div className="info-box">
            下表可查询每个 SKU
            的历史版本。页面底部列出工作区最近操作，审计时间按实际发生时间记录。
          </div>
        )}
        <div data-testid="cost-table">
          <DataTable
            selectable
            key={tab}
            data={d.items}
            onSelectionChange={setSelected}
            pageSize={10}
            server={{
              total: d.total,
              page,
              onPageChange: (value) => {
                setPage(value);
                setSelected([]);
              },
              onSearchChange: setSearch,
              onSortChange: (value) => {
                setSort(value);
                setPage(1);
              },
            }}
            columns={[
              {
                accessorKey: "name",
                header: "标准商品 / SKU",
                cell: ({ row }) => (
                  <div className="name-cell">
                    <span className="product-thumb">
                      <Package size={19} />
                    </span>
                    <span>
                      <strong>{row.original.name}</strong>
                      <small>
                        {row.original.sku_id} · {row.original.spec}
                      </small>
                    </span>
                  </div>
                ),
              },
              {
                accessorKey: "base_cost",
                header: "基础单位成本",
                meta: { numeric: true },
                cell: ({ getValue }) =>
                  getValue() == null ? (
                    <span className="warning">待维护</span>
                  ) : (
                    `¥${money(getValue(), 4)}`
                  ),
              },
              ...(tab === "compare"
                ? compareStores.map((store) => ({
                    id: store.id,
                    header: store.name,
                    enableSorting: false,
                    cell: ({ row }: any) => {
                      const cost = row.original.inheritance?.find(
                        (item: any) => item.store_id === store.id,
                      );
                      return (
                        <div className="stack-cell">
                          <strong>
                            {cost?.unit_cost == null
                              ? "—"
                              : `¥${money(cost.unit_cost, 4)}`}
                          </strong>
                          <Status value={cost?.source || "missing_cost"} />
                        </div>
                      );
                    },
                  }))
                : []),
              {
                accessorKey: "unit_cost",
                header: "有效单位成本",
                meta: { numeric: true },
                cell: ({ getValue }) => (
                  <strong>
                    {getValue() == null ? "—" : `¥${money(getValue(), 4)}`}
                  </strong>
                ),
              },
              {
                accessorKey: "source",
                header: "成本来源",
                cell: ({ getValue }) => <Status value={getValue()} />,
              },
              {
                accessorKey: "effective_from",
                header: "生效日期",
                cell: ({ row }) => (
                  <div className="stack-cell">
                    <span>{shortDate(row.original.effective_from)}</span>
                    <small>
                      至{" "}
                      {row.original.effective_to
                        ? shortDate(row.original.effective_to)
                        : "长期有效"}
                    </small>
                  </div>
                ),
              },
              {
                accessorKey: "change_rate",
                header: "成本变化",
                meta: { numeric: true },
                cell: ({ getValue }) =>
                  getValue() == null ? (
                    "—"
                  ) : (
                    <span className={directionClass(getValue())}>
                      {Number(getValue()) > 0 ? "+" : ""}
                      {percent(getValue())}
                    </span>
                  ),
              },
              {
                accessorKey: "profit_margin",
                header: "贡献利润率",
                meta: { numeric: true },
                cell: ({ getValue }) => (
                  <span className={Number(getValue()) < 0 ? "negative" : ""}>
                    {percent(getValue())}
                  </span>
                ),
              },
              {
                id: "actions",
                header: "操作",
                enableSorting: false,
                cell: ({ row }) => (
                  <div className="row-actions">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        open("edit", row.original);
                      }}
                    >
                      维护
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        open("history", row.original);
                      }}
                    >
                      历史
                    </button>
                  </div>
                ),
              },
            ]}
            onRowClick={(r) =>
              open(tab === "history" ? "history" : "detail", r)
            }
          />
        </div>
        <div className="panel-footnote">
          单位成本：人民币 / 标准单位，精度 4 位小数。上涨超过 10%
          提醒；贡献利润率低于 10% 视为低利润（演示默认阈值）。
        </div>
      </Panel>
      {tab === "history" && (
        <Panel
          title="工作区最近核算操作"
          subtitle="最近 100 次工作区操作中的成本与历史核算记录，不受顶部销售期间筛选影响"
        >
          <QueryState
            loading={operations.isLoading}
            error={operations.error}
            retry={() => operations.refetch()}
          />
          <DataTable
            data={(operations.data?.items || []).filter((item: any) =>
              ["cost", "recalculation", "mapping"].includes(
                item.operation_type,
              ),
            )}
            columns={[
              { accessorKey: "id", header: "操作编号" },
              {
                accessorKey: "operation_type",
                header: "类型",
                cell: ({ getValue }) =>
                  ({
                    cost: "成本维护",
                    recalculation: "历史重算",
                    mapping: "商品映射",
                  })[String(getValue())] || getValue(),
              },
              { accessorKey: "actor", header: "操作人" },
              {
                id: "affected",
                header: "受影响订单",
                cell: ({ row }) =>
                  integer(row.original.result.summary?.affected_orders),
              },
              {
                id: "delta",
                header: "利润变化",
                meta: { numeric: true },
                cell: ({ row }) => (
                  <span
                    className={directionClass(
                      row.original.result.summary?.profit_delta,
                    )}
                  >
                    {Number(row.original.result.summary?.profit_delta) > 0
                      ? "+"
                      : ""}
                    {money(row.original.result.summary?.profit_delta)}
                  </span>
                ),
              },
              {
                accessorKey: "created_at",
                header: "操作日期",
                cell: ({ getValue }) => shortDate(getValue()),
              },
            ]}
          />
        </Panel>
      )}
      <div className="cost-info-grid">
        <div>
          <span className="info-icon">
            <History size={18} />
          </span>
          <strong>成本随时间生效</strong>
          <p>新增版本只影响适用生效区间内的新核算，不会静默改写历史利润。</p>
        </div>
        <div>
          <span className="info-icon">
            <FlaskConical size={18} />
          </span>
          <strong>先试算，再决策</strong>
          <p>在不修改经营数据的前提下，观察单位成本对贡献利润的影响。</p>
        </div>
        <div>
          <span className="info-icon">
            <RefreshCw size={18} />
          </span>
          <strong>历史补全有据可查</strong>
          <p>缺失补全与历史纠错经过预览、确认和幂等提交，保留操作记录。</p>
        </div>
      </div>
      <Sheet
        open={!!mode}
        onOpenChange={(o) => !o && setMode(null)}
        title={
          mode === "edit"
            ? "新增成本版本"
            : mode === "batch"
              ? "批量调整成本"
              : mode === "simulate"
                ? "成本试算"
                : mode === "recalculate"
                  ? "补全 / 重算历史"
                  : mode === "history"
                    ? "成本历史版本"
                    : "成本继承详情"
        }
        description={
          row
            ? `${row.name} · ${row.sku_id} · ${row.spec}`
            : "单位成本以人民币 / 标准单位维护，历史订单保留核算快照"
        }
      >
        {(mode === "edit" || mode === "batch") && (
          <form
            onSubmit={doPreview}
            className="form-stack"
            onChange={() => setPreview(null)}
          >
            {mode === "batch" ? (
              <div className="info-box">
                已选 {selected.length} 个标准 SKU。按统一规则调整所选范围。
                <label className="field">
                  调整方式
                  <select
                    value={adjustment}
                    onChange={(e) =>
                      setAdjustment(e.target.value as typeof adjustment)
                    }
                  >
                    <option value="absolute">设置为固定单位成本</option>
                    <option value="amount">按固定金额增减</option>
                    <option value="percent">按百分比调整</option>
                  </select>
                </label>
              </div>
            ) : (
              <label className="field">
                标准 SKU
                <select {...form.register("sku_id")} aria-label="成本标准 SKU">
                  {meta.skus.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name} · {s.spec} ({s.id})
                    </option>
                  ))}
                </select>
              </label>
            )}
            <div className="form-two">
              <label className="field">
                作用层级
                <select {...form.register("scope")} aria-label="成本作用层级">
                  <option value="base">基础成本</option>
                  <option value="channel">渠道覆盖</option>
                  <option value="store">店铺覆盖</option>
                </select>
              </label>
              <label className="field">
                {scope === "store" ? "覆盖店铺" : "覆盖渠道"}
                <select
                  disabled={scope === "base"}
                  {...form.register("scope_id")}
                  aria-label="覆盖范围"
                >
                  <option value="">
                    {scope === "base" ? "全部渠道与店铺" : "请选择"}
                  </option>
                  {(scope === "store" ? meta.stores : meta.channels).map(
                    (s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ),
                  )}
                </select>
              </label>
            </div>
            <div className="form-two">
              <label className="field">
                {mode === "batch" && adjustment !== "absolute"
                  ? "调整值"
                  : "单位成本（元）"}
                <input
                  aria-label="单位成本"
                  inputMode="decimal"
                  placeholder="例如 18.5000"
                  {...form.register("unit_cost")}
                />
              </label>
              <label className="field">
                生效日期
                <input
                  aria-label="成本生效日期"
                  type="date"
                  {...form.register("effective_from")}
                />
              </label>
            </div>
            <label className="field">
              变更说明
              <textarea
                aria-label="变更说明"
                placeholder="说明采购价格、供应商或成本口径的变更原因"
                rows={3}
                {...form.register("note")}
              />
            </label>
            <label className="check-option">
              <input type="checkbox" {...form.register("allow_zero")} />
              若成本为 0，已确认并在说明中填写业务原因
            </label>
            <div className="info-box">
              <Info size={16} />
              <span>
                新版本生效时，将结束同范围的上一版本。已形成的订单成本快照不变；需要纠错请单独使用历史重算。
              </span>
            </div>
            {Object.entries(form.formState.errors).map(([k, e]) => (
              <p className="form-error" key={k}>
                {e.message}
              </p>
            ))}
            <Button type="submit" variant="default" disabled={busy}>
              {busy ? "正在计算…" : "预览变更"}
            </Button>
          </form>
        )}
        {mode === "simulate" && (
          <div className="form-stack">
            <div className="info-box">
              <FlaskConical size={17} />
              <span>
                试算不会写入成本版本或订单。统计范围沿用当前分析期间和店铺条件。
              </span>
            </div>
            <label className="field">
              标准 SKU
              <select
                aria-label="试算标准 SKU"
                value={simSku}
                onChange={(e) => {
                  setSimSku(e.target.value);
                  setPreview(null);
                }}
              >
                {meta.skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.spec}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              试算单位成本（元）
              <input
                aria-label="试算单位成本"
                inputMode="decimal"
                value={simValue}
                onChange={(e) => {
                  setSimValue(e.target.value);
                  setPreview(null);
                }}
              />
            </label>
            <Button variant="default" disabled={busy} onClick={simulate}>
              {busy ? "正在试算…" : "计算试算结果"}
            </Button>
            {preview && (
              <div className="simulation-result">
                <span className="badge badge-violet">
                  仅试算 · 未写入经营数据
                </span>
                <div>
                  <span>当前经营贡献利润</span>
                  <strong>¥{money(preview.old_profit)}</strong>
                </div>
                <div>
                  <span>试算经营贡献利润</span>
                  <strong>¥{money(preview.new_profit)}</strong>
                </div>
                <div className="simulation-delta">
                  <span>预计变化</span>
                  <strong className={directionClass(preview.profit_delta)}>
                    {Number(preview.profit_delta) > 0 ? "+" : ""}¥
                    {money(preview.profit_delta)}
                  </strong>
                </div>
                <div>
                  <span>贡献利润率</span>
                  <strong>
                    {percent(preview.old_margin)} →{" "}
                    {percent(preview.new_margin)}
                  </strong>
                </div>
                <p>
                  涉及 {integer(preview.affected_orders)}{" "}
                  笔订单；成本覆盖按同一领域核算规则处理。
                </p>
              </div>
            )}
          </div>
        )}
        {mode === "recalculate" && (
          <div className="form-stack">
            <div className="warning-box">
              历史重算将按订单支付时有效的成本规则重新生成核算结果。补全缺失成本前，请先添加覆盖历史日期的有效成本版本。
            </div>
            <label className="field">
              商品范围
              <select
                aria-label="重算标准 SKU"
                value={simSku}
                onChange={(e) => {
                  setSimSku(e.target.value);
                  setPreview(null);
                }}
              >
                <option value="">当前筛选范围内全部 SKU</option>
                {meta.skus.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} · {s.spec}
                  </option>
                ))}
              </select>
            </label>
            <div className="detail-pairs">
              <div>
                <span>分析期间</span>
                <strong>
                  {params.get("start") || defaultStart} 至{" "}
                  {params.get("end") || defaultEnd}
                </strong>
              </div>
            </div>
            <label className="check-option">
              <input
                type="checkbox"
                checked={onlyMissing}
                onChange={(e) => {
                  setOnlyMissing(e.target.checked);
                  setPreview(null);
                }}
              />
              仅补全当前未核算订单
            </label>
            <Button variant="default" disabled={busy} onClick={recalc}>
              {busy ? "正在计算…" : "预览重算"}
            </Button>
          </div>
        )}
        {mode === "history" && (
          <div className="timeline">
            {history.isLoading && <p>正在加载版本…</p>}
            {history.error && (
              <p className="form-error">{history.error.message}</p>
            )}
            {history.data?.items.map((v: any) => (
              <div className="timeline-item" key={v.id}>
                <i />
                <div>
                  <div className="timeline-title">
                    <strong>¥{money(v.unit_cost, 4)}</strong>
                    <Status value={v.scope} />
                  </div>
                  <p>
                    {shortDate(v.effective_from)} →{" "}
                    {v.effective_to ? shortDate(v.effective_to) : "长期有效"}
                  </p>
                  <p>{v.note || "演示初始成本"}</p>
                  <small>
                    {v.scope_id || "所有店铺"} · 版本 {v.id}
                  </small>
                </div>
              </div>
            ))}
          </div>
        )}
        {mode === "detail" && row && (
          <div className="form-stack">
            <div className="detail-product">
              <span className="product-thumb large">
                <Package size={30} />
              </span>
              <div>
                <h3>{row.name}</h3>
                <p>
                  {row.spec} · {row.sku_id}
                </p>
              </div>
            </div>
            <div className="inheritance">
              <div>
                <span>01 基础成本</span>
                <strong>¥{money(row.base_cost, 4)}</strong>
              </div>
              <ArrowRight size={17} />
              <div>
                <span>02 最优先有效来源</span>
                <Status value={row.source} />
              </div>
              <ArrowRight size={17} />
              <div>
                <span>最终单位成本</span>
                <strong>¥{money(row.unit_cost, 4)}</strong>
              </div>
            </div>
            <h3>各店铺实际继承成本</h3>
            <DataTable
              pageSize={9}
              data={(row.inheritance || []).filter((item: any) =>
                compareStores.some((store) => store.id === item.store_id),
              )}
              columns={[
                { accessorKey: "store_name", header: "店铺" },
                {
                  accessorKey: "unit_cost",
                  header: "有效单位成本",
                  meta: { numeric: true },
                  cell: ({ getValue }) =>
                    getValue() == null ? "—" : `¥${money(getValue(), 4)}`,
                },
                {
                  accessorKey: "source",
                  header: "来源",
                  cell: ({ getValue }) => <Status value={getValue()} />,
                },
              ]}
            />
            <div className="detail-pairs">
              <div>
                <span>生效区间</span>
                <strong>
                  [{shortDate(row.effective_from)},{" "}
                  {row.effective_to ? shortDate(row.effective_to) : "∞"})
                </strong>
              </div>
              <div>
                <span>当前贡献利润率</span>
                <strong>{percent(row.profit_margin)}</strong>
              </div>
              <div>
                <span>核算覆盖率</span>
                <strong>{percent(row.coverage)}</strong>
              </div>
            </div>
            <div className="inline-controls">
              <Button onClick={() => open("history", row)}>
                <History size={15} />
                查看历史
              </Button>
              <Button onClick={() => open("simulate", row)}>
                <FlaskConical size={15} />
                成本试算
              </Button>
              <Button variant="default" onClick={() => open("edit", row)}>
                新增成本版本
              </Button>
            </div>
          </div>
        )}
        {error && <p className="form-error error-banner">{error}</p>}
        {preview && ["edit", "batch", "recalculate"].includes(mode || "") && (
          <div className="form-stack">
            <PreviewSummary preview={preview} />
            <Button variant="default" disabled={busy} onClick={commit}>
              {busy
                ? "正在保存…"
                : mode === "recalculate"
                  ? "确认重算"
                  : "确认保存"}
            </Button>
          </div>
        )}
      </Sheet>
    </div>
  );
}
