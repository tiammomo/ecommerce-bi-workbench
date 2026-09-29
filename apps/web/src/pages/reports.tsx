import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Download,
  Upload,
  FileSpreadsheet,
  Save,
  Plus,
  Trash2,
  Pencil,
  Check,
  FolderOpen,
  ArrowRight,
  FileCheck,
  Bookmark,
} from "lucide-react";
import { useApi, post, request, API, idempotencyKey } from "@/api/client";
import { useWorkspace } from "@/app/context";
import { Panel, QueryState, Status } from "@/components/bi/common";
import { DataTable } from "@/components/bi/table";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { money, integer, shortDate, download } from "@/lib/utils";
import { metricColumns } from "@/pages/analytics";
const reportTypes = [
  ["daily", "销售日报", "按业务日汇总"],
  ["channels", "渠道经营报表", "跨渠道经营对比"],
  ["stores", "店铺经营报表", "定位店铺表现"],
  ["products", "商品利润表", "统一标准 SKU"],
  ["orders", "订单行明细", "核算与成本快照"],
  ["refunds", "退款明细", "退款与成本转回"],
  ["costs", "成本变更记录", "成本版本与记录"],
];
export function Reports() {
  const { query, params, setFilters } = useWorkspace();
  const client = useQueryClient();
  const [tab, setTab] = useState("reports");
  const type = params.get("report_type") || "daily";
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const importKey = useRef(idempotencyKey());
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const page = Math.max(1, Number(params.get("page") || "1") || 1);
  const setPage = (value: number) => setFilters({ page: String(value) });
  const search = params.get("search") || "";
  const setSearch = (value: string) => setFilters({ search: value, page: "" });
  const sort = {
    id:
      params.get("sort_by") ||
      (type === "costs" || type === "orders" || type === "refunds"
        ? "date"
        : "revenue"),
    desc: params.get("sort_dir") !== "asc",
  };
  const setSort = (value: { id: string; desc: boolean }) =>
    setFilters({
      sort_by: value.id,
      sort_dir: value.desc ? "desc" : "asc",
      page: "",
    });
  const [columns, setColumns] = useState<Record<string, boolean>>({});
  const groups: Record<string, string> = {
    daily: "day",
    channels: "channel",
    stores: "store",
    products: "sku",
  };
  const endpoint =
    type === "orders"
      ? "/orders"
      : type === "refunds"
        ? "/refunds"
        : type === "costs"
          ? "/costs/changes"
          : "/analytics";
  const report = useApi(
    `${endpoint}?${query}&group_by=${groups[type] || "sku"}&page=${page}&page_size=50&search=${encodeURIComponent(search)}&sort_by=${sort.id}&sort_dir=${sort.desc ? "desc" : "asc"}`,
    tab === "reports",
  );
  const views = useApi("/reports/views");
  const templates = useApi("/imports/templates", tab === "imports");
  const batches = useApi("/imports/batches", tab === "imports");
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
  const save = async () => {
    if (!name.trim()) return;
    const payload = {
      name,
      report_type: type,
      filters: Object.fromEntries(params),
      columns: reportColumns
        .filter((c: any) => columns[c.accessorKey || c.id] !== false)
        .map((c: any) => c.accessorKey || c.id),
      sort,
    };
    const data = await run(() =>
      editing
        ? request(`/reports/views/${editing.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          })
        : post("/reports/views", payload),
    );
    if (data) {
      setSaveOpen(false);
      client.invalidateQueries({ queryKey: ["/reports/views"] });
      toast.success("报表视图已保存到工作区");
    }
  };
  const importPreview = async () => {
    const form = new FormData();
    files.forEach((file) => form.append("files", file));
    const data = await run(() =>
      request("/imports/preview", { method: "POST", body: form }),
    );
    if (data) {
      setPreview(data);
      importKey.current = idempotencyKey();
      setResult(null);
    }
  };
  const importCommit = async () => {
    const data = await run(() =>
      post("/imports/commit", {
        preview_id: preview.preview_id,
        idempotency_key: importKey.current,
      }),
    );
    if (data) {
      setResult(data);
      setPreview(null);
      client.invalidateQueries();
      toast.success("CSV 数据导入完成");
    }
  };
  const label = reportTypes.find((r) => r[0] === type)?.[1];
  const data = report.data?.rows || report.data?.items || [];
  const reportColumns =
    type === "orders"
      ? [
          {
            accessorKey: "order_id",
            header: "订单编号",
            cell: ({ row }: any) => (
              <div className="stack-cell">
                <strong>{row.original.order_id}</strong>
                <small>{row.original.store_name}</small>
              </div>
            ),
          },
          {
            accessorKey: "name",
            header: "商品 / SKU",
            cell: ({ row }: any) => (
              <div className="stack-cell">
                <span>{row.original.name}</span>
                <small>{row.original.sku_id || "待关联"}</small>
              </div>
            ),
          },
          {
            accessorKey: "date",
            header: "支付日期",
            cell: ({ getValue }: any) => shortDate(getValue()),
          },
          {
            accessorKey: "sales",
            header: "支付收入",
            meta: { numeric: true },
            cell: ({ getValue }: any) => money(getValue()),
          },
          {
            accessorKey: "cost",
            header: "商品成本",
            meta: { numeric: true },
            cell: ({ getValue }: any) => money(getValue()),
          },
          {
            accessorKey: "profit",
            header: "贡献利润",
            meta: { numeric: true },
            cell: ({ getValue }: any) => money(getValue()),
          },
          {
            accessorKey: "cost_source",
            header: "成本来源",
            cell: ({ getValue }: any) => <Status value={getValue()} />,
          },
          {
            accessorKey: "status",
            header: "核算状态",
            cell: ({ getValue }: any) => <Status value={getValue()} />,
          },
        ]
      : type === "refunds"
        ? [
            { accessorKey: "order_id", header: "订单编号" },
            { accessorKey: "name", header: "商品" },
            {
              accessorKey: "date",
              header: "退款日期",
              cell: ({ getValue }: any) => shortDate(getValue()),
            },
            { accessorKey: "reason", header: "退款原因" },
            {
              accessorKey: "amount",
              header: "退款金额",
              meta: { numeric: true },
              cell: ({ getValue }: any) => money(getValue()),
            },
            {
              accessorKey: "cost_reversal",
              header: "成本转回",
              meta: { numeric: true },
              cell: ({ getValue }: any) => money(getValue()),
            },
          ]
        : type === "costs"
          ? [
              { accessorKey: "id", header: "操作记录" },
              { accessorKey: "operation_type", header: "操作类型" },
              { accessorKey: "entity_id", header: "影响对象" },
              {
                accessorKey: "before",
                header: "变更前",
                cell: ({ getValue }: any) => (
                  <span
                    className="truncate-cell"
                    title={JSON.stringify(getValue())}
                  >
                    {JSON.stringify(getValue()) || "—"}
                  </span>
                ),
              },
              {
                accessorKey: "after",
                header: "变更后",
                cell: ({ getValue }: any) => (
                  <span
                    className="truncate-cell"
                    title={JSON.stringify(getValue())}
                  >
                    {JSON.stringify(getValue()) || "—"}
                  </span>
                ),
              },
              { accessorKey: "note", header: "变更说明" },
              {
                accessorKey: "created_at",
                header: "记录日期",
                cell: ({ getValue }: any) => shortDate(getValue()),
              },
            ]
          : metricColumns;
  return (
    <div
      className="page-stack"
      data-load-state={
        tab === "reports" && report.isLoading ? "loading" : "ready"
      }
    >
      <div className="page-subbar">
        <div className="tabs">
          <button
            className={tab === "reports" ? "active" : ""}
            onClick={() => setTab("reports")}
          >
            <FileSpreadsheet size={15} />
            经营报表
          </button>
          <button
            className={tab === "imports" ? "active" : ""}
            onClick={() => setTab("imports")}
          >
            <Upload size={15} />
            数据导入
          </button>
        </div>
        <div className="inline-controls">
          {tab === "reports" && (
            <>
              <Button
                onClick={() => {
                  setEditing(null);
                  setName(`${label} · 自定义视图`);
                  setSaveOpen(true);
                }}
              >
                <Bookmark size={15} />
                保存当前视图
              </Button>
              <Button
                variant="default"
                onClick={() =>
                  download(
                    `${API}/reports/export?${query}&report_type=${type === "costs" ? "cost_changes" : type}&sort_by=${sort.id}&sort_dir=${sort.desc ? "desc" : "asc"}&search=${encodeURIComponent(search)}`,
                  )
                }
              >
                <Download size={15} />
                导出全部 CSV
              </Button>
            </>
          )}
        </div>
      </div>
      {tab === "reports" ? (
        <>
          <div className="report-grid">
            {reportTypes.map(([value, title, description], i) => (
              <button
                className={`report-tile ${type === value ? "active" : ""}`}
                key={value}
                onClick={() => {
                  setFilters({
                    report_type: value,
                    page: "",
                    search: "",
                    sort_by: "",
                    sort_dir: "",
                  });
                  setColumns({});
                }}
              >
                <span className="report-icon">
                  <FileSpreadsheet size={19} />
                </span>
                <strong>{title}</strong>
                <small>{description}</small>
                {type === value && <Check size={14} className="report-check" />}
              </button>
            ))}
          </div>
          {views.data?.items?.length > 0 && (
            <Panel
              title="已保存的视图"
              subtitle="保存在工作区数据库，刷新和重启后仍可恢复"
            >
              <div className="saved-views">
                {views.data.items.map((v: any) => (
                  <div className="saved-view" key={v.id}>
                    <button
                      onClick={() => {
                        setFilters({
                          ...Object.fromEntries(
                            [...params.keys()].map((k) => [k, ""]),
                          ),
                          ...v.filters,
                          report_type: v.report_type,
                          sort_by: v.sort?.id || v.sort?.field || "revenue",
                          sort_dir:
                            v.sort?.desc === false ||
                            v.sort?.direction === "asc"
                              ? "asc"
                              : "desc",
                          page: "",
                        });
                        setColumns(
                          Array.isArray(v.columns) && v.columns.length
                            ? Object.fromEntries(
                                [
                                  "name",
                                  "revenue",
                                  "orders",
                                  "gross_profit",
                                  "profit",
                                  "profit_margin",
                                  "refund_rate",
                                  "coverage",
                                  "order_id",
                                  "date",
                                  "sales",
                                  "cost",
                                  "cost_source",
                                  "status",
                                  "reason",
                                  "amount",
                                  "cost_reversal",
                                  "id",
                                  "operation_type",
                                  "entity_id",
                                  "before",
                                  "after",
                                  "note",
                                  "created_at",
                                ].map((key) => [key, v.columns.includes(key)]),
                              )
                            : {},
                        );
                        toast.success(`已恢复视图：${v.name}`);
                      }}
                    >
                      <Bookmark size={16} />
                      <span>{v.name}</span>
                    </button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`重命名 ${v.name}`}
                      onClick={() => {
                        setEditing(v);
                        setName(v.name);
                        setSaveOpen(true);
                      }}
                    >
                      <Pencil size={13} />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label={`删除 ${v.name}`}
                      onClick={async () => {
                        try {
                          await request(`/reports/views/${v.id}`, {
                            method: "DELETE",
                          });
                          client.invalidateQueries({
                            queryKey: ["/reports/views"],
                          });
                          toast.success("视图已删除");
                        } catch (e) {
                          toast.error((e as Error).message);
                        }
                      }}
                    >
                      <Trash2 size={13} />
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
          )}
          <Panel
            title={label || "经营报表"}
            subtitle={
              type === "costs"
                ? "记录按实际操作时间排序，销售分析期间不限制审计记录；商品、范围与搜索条件用于筛选变更"
                : "金额为人民币 / 元；导出包含当前筛选条件下的全部行，展示 CSV 不作为导入模板"
            }
          >
            {report.isLoading || report.error ? (
              <QueryState
                loading={report.isLoading}
                error={report.error}
                retry={() => report.refetch()}
              />
            ) : (
              <DataTable
                data={data}
                searchValue={search}
                sortingValue={sort}
                columns={reportColumns}
                pageSize={50}
                server={{
                  total: report.data?.total ?? data.length,
                  page,
                  onPageChange: setPage,
                  onSearchChange: setSearch,
                  onSortChange: setSort,
                }}
                columnVisibility={columns}
                onColumnVisibilityChange={setColumns}
              />
            )}
          </Panel>
        </>
      ) : (
        <>
          <div className="import-intro">
            <div>
              <span className="eyebrow">DATA IMPORT</span>
              <h2>从标准 CSV，开始可信的数据分析</h2>
              <p>
                下载模板，上传并校验数据，在确认前看清每一项新增、重复和冲突。
              </p>
            </div>
            <span className="import-illustration">
              <FileSpreadsheet size={45} />
              <span>
                <Check size={15} />
              </span>
            </span>
          </div>
          <div className="import-steps">
            <span className="active">
              <i>1</i>下载标准模板
            </span>
            <ArrowRight size={14} />
            <span className={files.length ? "active" : ""}>
              <i>2</i>上传与校验
            </span>
            <ArrowRight size={14} />
            <span className={preview ? "active" : ""}>
              <i>3</i>预览并确认
            </span>
            <ArrowRight size={14} />
            <span className={result ? "active" : ""}>
              <i>4</i>查看批次结果
            </span>
          </div>
          <div className="two-columns import-columns">
            <Panel
              title="标准数据模板"
              subtitle="v1 · UTF-8 CSV · 金额以元为单位"
            >
              <div className="template-list">
                {templates.data?.items.map((t: any) => (
                  <div key={t.name}>
                    <span className="file-icon">
                      <FileSpreadsheet size={19} />
                    </span>
                    <div>
                      <strong>{t.label}</strong>
                      <small>
                        {t.name}.csv · {t.fields?.length || 0} 个字段
                      </small>
                    </div>
                    <Button
                      size="icon"
                      aria-label={`下载 ${t.label} 模板`}
                      onClick={() =>
                        download(`${API}/imports/templates/${t.name}`)
                      }
                    >
                      <Download size={15} />
                    </Button>
                  </div>
                ))}
              </div>
            </Panel>
            <Panel
              title="上传数据文件"
              subtitle="可一次选择多个关联文件，按依赖顺序校验"
            >
              <label className="upload-zone">
                <Upload size={26} />
                <strong>点击选择 CSV 文件</strong>
                <span>UTF-8 / UTF-8 BOM，文件名保留模板名称</span>
                <input
                  type="file"
                  accept=".csv,text/csv"
                  multiple
                  aria-label="上传 CSV 文件"
                  onChange={(e) => {
                    setFiles(Array.from(e.target.files || []));
                    setPreview(null);
                    setResult(null);
                    setError("");
                  }}
                />
              </label>
              {files.map((f) => (
                <div className="file-selected" key={f.name}>
                  <FileSpreadsheet size={16} />
                  <span>{f.name}</span>
                  <small>{(f.size / 1024).toFixed(1)} KB</small>
                </div>
              ))}
              <div className="info-box">
                完全相同的记录将跳过；相同业务键、不同内容会阻止整批提交。原始记录不会被静默覆盖。
              </div>
              <Button
                variant="default"
                disabled={!files.length || busy}
                onClick={importPreview}
              >
                <FileCheck size={15} />
                {busy ? "正在校验…" : "预览与校验"}
              </Button>
            </Panel>
          </div>
          {error && <div className="error-banner">{error}</div>}
          {preview && (
            <Panel
              title="导入校验结果"
              subtitle={`预览版本 ${preview.revision} · 未正式写入数据库`}
              action={
                <Button
                  variant="default"
                  disabled={
                    busy ||
                    preview.errors?.length > 0 ||
                    preview.conflict_count > 0
                  }
                  onClick={importCommit}
                >
                  {busy ? "正在导入…" : "确认导入"}
                </Button>
              }
            >
              <div className="import-counts">
                {[
                  ["总行数", preview.total_rows],
                  ["新增", preview.new_count],
                  ["完全重复", preview.duplicate_count],
                  ["冲突", preview.conflict_count],
                  ["错误", preview.errors?.length || 0],
                ].map(([l, v]) => (
                  <div key={l}>
                    <span>{l}</span>
                    <strong>{v}</strong>
                  </div>
                ))}
              </div>
              {preview.warnings?.map((w: any, i: number) => (
                <p className="warning-box" key={i}>
                  {typeof w === "string" ? w : w.message}
                </p>
              ))}
              {preview.errors?.length > 0 && (
                <>
                  <div className="error-banner">
                    存在阻断问题，整批数据不会写入。
                    <Button
                      size="sm"
                      onClick={() =>
                        download(`${API}/imports/errors/${preview.preview_id}`)
                      }
                    >
                      下载错误行 CSV
                    </Button>
                  </div>
                  <DataTable
                    data={preview.errors}
                    columns={[
                      { accessorKey: "file", header: "文件" },
                      { accessorKey: "row", header: "行号" },
                      { accessorKey: "field", header: "字段" },
                      { accessorKey: "message", header: "原因" },
                    ]}
                  />
                </>
              )}
            </Panel>
          )}
          {result && (
            <div className="success-box">
              <Check size={20} />
              <div>
                <strong>导入完成，工作区数据已更新</strong>
                <p>
                  新增 {result.new_count ?? result.summary?.new_count ?? 0} 行 ·
                  跳过重复{" "}
                  {result.duplicate_count ??
                    result.summary?.duplicate_count ??
                    0}{" "}
                  行 · 数据修订 {result.revision}
                </p>
              </div>
            </div>
          )}
          <Panel title="导入批次" subtitle="保留文件摘要、模板与操作记录">
            <DataTable
              data={batches.data?.items || []}
              columns={[
                { accessorKey: "id", header: "批次编号" },
                {
                  accessorKey: "created_at",
                  header: "操作时间",
                  cell: ({ getValue }) =>
                    String(getValue() || "")
                      .replace("T", " ")
                      .slice(0, 19),
                },
                {
                  accessorKey: "status",
                  header: "状态",
                  cell: ({ getValue }) => <Status value={getValue()} />,
                },
                {
                  accessorKey: "new_count",
                  header: "新增行数",
                  meta: { numeric: true },
                },
                {
                  accessorKey: "duplicate_count",
                  header: "重复行数",
                  meta: { numeric: true },
                },
              ]}
            />
          </Panel>
        </>
      )}
      <Sheet
        open={saveOpen}
        onOpenChange={setSaveOpen}
        title={editing ? "重命名报表视图" : "保存报表视图"}
        description="当前报表类型、筛选条件、列设置和排序将保存到工作区数据库"
      >
        <div className="form-stack">
          <label className="field">
            视图名称
            <input
              aria-label="视图名称"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
            />
          </label>
          <div className="info-box">
            报表：{label}
            <br />
            筛选：{params.toString() || "最近 30 天 · 全渠道"}
          </div>
          {error && <p className="form-error">{error}</p>}
          <Button
            variant="default"
            disabled={busy || !name.trim()}
            onClick={save}
          >
            {busy ? "保存中…" : "保存视图"}
          </Button>
        </div>
      </Sheet>
    </div>
  );
}
