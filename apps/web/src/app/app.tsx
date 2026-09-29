import { useState } from "react";
import {
  NavLink,
  Routes,
  Route,
  Navigate,
  useLocation,
  useNavigate,
  useSearchParams,
} from "react-router-dom";
import {
  LayoutDashboard,
  ChartNoAxesCombined,
  Store,
  Package,
  Wallet,
  Undo2,
  FileSpreadsheet,
  Layers,
  PanelLeftClose,
  PanelLeftOpen,
  ChevronRight,
  ChevronDown,
  Download,
  BookOpen,
  Database,
  ArrowUpRight,
  RefreshCw,
  Check,
  Command,
  Globe,
} from "lucide-react";
import { useIsFetching } from "@tanstack/react-query";
import { Toaster } from "sonner";
import { useApi, API } from "@/api/client";
import type { Meta } from "@/api/types";
import { WorkspaceContext, defaultStart, defaultEnd } from "@/app/context";
import { Button } from "@/components/ui/button";
import { Filters } from "@/components/bi/filters";
import { QueryState } from "@/components/bi/common";
import {
  Overview,
  Channels,
  Stores,
  Products,
  Profit,
} from "@/pages/analytics";
import { Refunds } from "@/pages/refunds";
import { Reports } from "@/pages/reports";
import { Costs } from "@/pages/costs";
import { DetailDrawer, TargetsDrawer, HelpDrawer } from "@/features/details";
import { download, shortDate } from "@/lib/utils";
const navigation = [
  {
    path: "/overview",
    label: "经营总览",
    en: "BUSINESS OVERVIEW",
    icon: LayoutDashboard,
    description: "掌握利润与销售变化，识别经营风险，追踪渠道表现与目标进度。",
  },
  {
    path: "/channels",
    label: "渠道对比",
    en: "CHANNEL PERFORMANCE",
    icon: ChartNoAxesCombined,
    description: "打通渠道边界，在一致的口径下衡量销售与盈利表现。",
  },
  {
    path: "/stores",
    label: "店铺分析",
    en: "STORE ANALYTICS",
    icon: Store,
    description: "从整体到单店，找到增长来源与值得关注的经营变化。",
  },
  {
    path: "/products",
    label: "商品分析",
    en: "PRODUCT INTELLIGENCE",
    icon: Package,
    description: "同款商品统一看，发现真正值得投入的商品与规格。",
  },
  {
    path: "/profit",
    label: "利润与费用",
    en: "PROFIT & EXPENSES",
    icon: Wallet,
    description: "沿着收入到利润的路径，看清每一项成本和费用的影响。",
  },
  {
    path: "/refunds",
    label: "退款与售后",
    en: "REFUNDS & AFTERSALES",
    icon: Undo2,
    description: "追溯退款原因与成本转回，让售后分析回到经营结果。",
  },
  {
    path: "/reports",
    label: "报表中心",
    en: "REPORTS & DATA",
    icon: FileSpreadsheet,
    description: "汇聚经营数据，保存常用分析视角，可靠地导入与导出。",
  },
  {
    path: "/costs",
    label: "商品成本管理",
    en: "COST MANAGEMENT",
    icon: Layers,
    description: "精确维护每个渠道的商品成本，让历史有据可查、未来有数可算。",
  },
];
export function App() {
  const location = useLocation();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const meta = useApi<Meta>("/meta");
  const [collapsed, setCollapsed] = useState(
    () => localStorage.getItem("nav-collapsed") === "1",
  );
  const [help, setHelp] = useState<"metrics" | "demo" | null>(null);
  const [targets, setTargets] = useState(false);
  const [detail, setDetail] = useState<any>(null);
  const current =
    navigation.find((n) => n.path === location.pathname) || navigation[0];
  const fetching = useIsFetching();
  const update = (changes: Record<string, string>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (
        Object.keys(changes).some((k) =>
          [
            "start",
            "end",
            "channel_ids",
            "store_ids",
            "sku_ids",
            "category",
            "status",
            "reason",
            "kind",
            "date_basis",
          ].includes(k),
        )
      )
        next.delete("page");
      for (const [k, v] of Object.entries(changes)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      return next;
    });
  };
  const queryParams = new URLSearchParams(params);
  queryParams.delete("detail");
  queryParams.delete("detail_kind");
  queryParams.delete("detail_store");
  queryParams.delete("detail_platform");
  queryParams.delete("detail_expense");
  queryParams.delete("detail_sku");
  if (!queryParams.has("start")) queryParams.set("start", defaultStart);
  if (!queryParams.has("end")) queryParams.set("end", defaultEnd);
  if (location.pathname === "/costs")
    queryParams.set(
      "effective_date",
      params.get("cost_effective_date") || defaultEnd,
    );
  for (const key of ["channel_ids", "store_ids", "sku_ids"]) {
    if (queryParams.has(key))
      queryParams.set(
        key,
        [...new Set(queryParams.get(key)!.split(",").filter(Boolean))]
          .sort()
          .join(","),
      );
  }
  if (location.pathname === "/products")
    queryParams.set("group_by", params.get("product_group") || "sku");
  if (location.pathname === "/profit")
    queryParams.set("group_by", params.get("profit_group") || "channel");
  queryParams.sort();
  const go = (path: string, filters: Record<string, string> = {}) => {
    const next = new URLSearchParams(params);
    next.delete("detail");
    next.delete("detail_kind");
    next.delete("detail_store");
    next.delete("detail_platform");
    next.delete("detail_expense");
    next.delete("detail_sku");
    for (const [k, v] of Object.entries(filters)) {
      if (v != null && String(v))
        next.set(k, Array.isArray(v) ? v.join(",") : String(v));
      else next.delete(k);
    }
    navigate(`${path}?${next}`);
  };
  const openDetail = (row: any, kind = "sku") => {
    setDetail(row);
    update({
      detail: row.id || row.sku_id || "current",
      detail_kind: kind,
      detail_store: row.store_id || "",
      detail_sku: row.sku_id || "",
      detail_platform: row.platform_sku || "",
      detail_expense:
        kind === "expense"
          ? (
              {
                平台费用: "platform",
                包装费用: "packaging",
                物流费用: "logistics",
                广告推广费用: "advertising",
                广告费用: "advertising",
                商家承担物流: "logistics",
              } as Record<string, string>
            )[row.name] ||
            row.expense_type ||
            ""
          : "",
    });
  };
  const detailRow = params.get("detail")
    ? (String(detail?.id || detail?.sku_id || "current") ===
      params.get("detail")
        ? detail
        : null) || {
        expense_type: params.get("detail_expense"),
        store_id: params.get("detail_store"),
        platform_sku: params.get("detail_platform"),
        id: params.get("detail"),
        sku_id: params.get("detail_sku") || params.get("detail"),
        name:
          meta.data?.skus.find(
            (s) => s.id === (params.get("detail_sku") || params.get("detail")),
          )?.name ||
          meta.data?.stores.find((s) => s.id === params.get("detail"))?.name ||
          meta.data?.products.find((p) => p.id === params.get("detail"))
            ?.name ||
          meta.data?.channels.find((c) => c.id === params.get("detail"))
            ?.name ||
          params.get("detail"),
      }
    : null;
  return (
    <div className={`app-shell ${collapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <a className="brand" href="/overview" aria-label="栖数工作台首页">
          <div className="brand-symbol">
            <span />
            <span />
            <span />
          </div>
          <div className="brand-text">
            <strong>
              栖数<span> QISHU</span>
            </strong>
            <small>多渠道经营工作台</small>
          </div>
        </a>
        <div className="workspace-switch">
          <span className="workspace-avatar">Q</span>
          <div>
            <strong>我的经营空间</strong>
            <small>本地工作区</small>
          </div>
          <ChevronDown size={13} />
        </div>
        <div className="nav-group-label">
          工作空间 <span>WORKSPACE</span>
        </div>
        <nav>
          {navigation.map((item, i) => (
            <NavLink
              key={item.path}
              to={`${item.path}?${params.toString()}`}
              className={({ isActive }) =>
                `nav-link ${isActive ? "active" : ""} ${i === 6 ? "nav-separated" : ""}`
              }
              title={item.label}
            >
              <item.icon size={18} />
              <span>{item.label}</span>
              {item.path === "/overview" && <i className="nav-indicator" />}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="workspace-health">
            <div>
              <span className="status-dot" />
              <strong>工作区数据已就绪</strong>
            </div>
            <p>统一口径，让决策有据可依</p>
            <span>
              SQLite + CSV <i>本地连接</i>
            </span>
          </div>
          <button
            className="nav-link"
            onClick={() => setHelp("metrics")}
            title="指标口径"
          >
            <BookOpen size={17} />
            <span>指标口径</span>
            <ArrowUpRight size={13} />
          </button>
          <button
            className="nav-link"
            onClick={() => setHelp("demo")}
            title="演示数据"
          >
            <Database size={17} />
            <span>演示数据</span>
            <span className="mini-badge">DEMO</span>
          </button>
          <div className="sidebar-profile">
            <span className="profile-avatar">演</span>
            <div>
              <strong>演示操作人</strong>
              <small>本地单人工作区</small>
            </div>
            <button
              className="icon-button collapse-button"
              onClick={() => {
                setCollapsed(!collapsed);
                localStorage.setItem("nav-collapsed", collapsed ? "0" : "1");
              }}
              aria-label={collapsed ? "展开导航" : "收起导航"}
            >
              {collapsed ? (
                <PanelLeftOpen size={16} />
              ) : (
                <PanelLeftClose size={16} />
              )}
            </button>
          </div>
        </div>
      </aside>
      <main className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="icon-button mobile-menu"
              onClick={() => setCollapsed(!collapsed)}
              aria-label="切换导航"
            >
              <PanelLeftOpen size={17} />
            </button>
            <span>工作空间</span>
            <ChevronRight size={13} />
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-pill">
              <span />
              模拟数据
            </span>
            <span className="data-asof">
              数据截至 {shortDate(meta.data?.as_of || "2026-09-28")}
            </span>
            <div className="topbar-divider" />
            <span className="currency-label">CNY · 人民币</span>
            <span className="header-avatar">演</span>
          </div>
        </header>
        <div
          className="page-container"
          data-testid="page-content"
          data-load-state={
            meta.error
              ? "error"
              : !meta.data || fetching > 0
                ? "loading"
                : "ready"
          }
        >
          <div className="page-heading">
            <div>
              <div className="eyebrow">
                {current.en}
                <span />
              </div>
              <h1 data-testid="page-title">
                {current.label}
                {current.path === "/overview" && (
                  <span className="heading-dot" />
                )}
              </h1>
              <p>{current.description}</p>
            </div>
            <div className="page-heading-actions">
              {fetching > 0 ? (
                <span className="sync-indicator">
                  <RefreshCw size={12} className="spin" />
                  数据更新中
                </span>
              ) : (
                <span className="sync-indicator">
                  <Check size={12} />
                  数据已同步
                </span>
              )}
              <Button
                onClick={() =>
                  download(
                    `${API}/reports/export?${queryParams}&report_type=${({ "/overview": "channels", "/channels": "channels", "/stores": "stores", "/products": "products", "/profit": params.get("profit_group") === "sku" ? "products" : params.get("profit_group") === "store" ? "stores" : "channels", "/refunds": "refunds", "/reports": params.get("report_type") === "costs" ? "cost_changes" : params.get("report_type") || "daily", "/costs": "costs" } as Record<string, string>)[current.path]}`,
                  )
                }
              >
                <Download size={15} />
                导出报表
              </Button>
            </div>
          </div>
          {!meta.data ? (
            <QueryState
              loading={meta.isLoading}
              error={meta.error}
              retry={() => meta.refetch()}
            />
          ) : (
            <WorkspaceContext.Provider
              value={{
                meta: meta.data,
                params,
                setFilter: (k, v) => update({ [k]: v }),
                setFilters: update,
                query: queryParams.toString(),
                go,
                openDetail,
                openTargets: () => setTargets(true),
              }}
            >
              <Filters />
              <Routes>
                <Route path="/" element={<Navigate to="/overview" replace />} />
                <Route path="/overview" element={<Overview />} />
                <Route path="/channels" element={<Channels />} />
                <Route path="/stores" element={<Stores />} />
                <Route path="/products" element={<Products />} />
                <Route path="/profit" element={<Profit />} />
                <Route path="/refunds" element={<Refunds />} />
                <Route path="/reports" element={<Reports />} />
                <Route path="/costs" element={<Costs />} />
                <Route path="*" element={<Navigate to="/overview" replace />} />
              </Routes>
              {detailRow && (
                <DetailDrawer
                  row={detailRow}
                  kind={params.get("detail_kind") || "sku"}
                  onClose={() => {
                    update({
                      detail: "",
                      detail_kind: "",
                      detail_store: "",
                      detail_platform: "",
                      detail_expense: "",
                      detail_sku: "",
                    });
                    setDetail(null);
                  }}
                />
              )}
              <TargetsDrawer open={targets} onClose={() => setTargets(false)} />
              <HelpDrawer mode={help} onClose={() => setHelp(null)} />
            </WorkspaceContext.Provider>
          )}
          <footer className="page-footer">
            <span>栖数 QISHU · 每一份数据，都更有意义</span>
            <span>演示经营口径 · Asia/Shanghai</span>
          </footer>
        </div>
      </main>
      <Toaster position="top-center" richColors closeButton />
    </div>
  );
}
