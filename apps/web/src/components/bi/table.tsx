import { useState, useMemo, useEffect, useRef } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type VisibilityState,
  type OnChangeFn,
} from "@tanstack/react-table";
import {
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  SlidersHorizontal,
  Search,
  PackageSearch,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover } from "@/components/ui/popover";
type Server = {
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onSearchChange?: (search: string) => void;
  onSortChange?: (sort: { id: string; desc: boolean }) => void;
};
export function DataTable({
  data,
  columns,
  searchPlaceholder = "搜索名称或编码…",
  searchKeys,
  searchValue,
  sortingValue,
  onRowClick,
  pageSize = 8,
  selectable = false,
  onSelectionChange,
  server,
  columnVisibility,
  onColumnVisibilityChange,
}: {
  data: any[];
  columns: ColumnDef<any, any>[];
  searchPlaceholder?: string;
  searchKeys?: string[];
  searchValue?: string;
  sortingValue?: { id: string; desc: boolean };
  onRowClick?: (row: any) => void;
  pageSize?: number;
  selectable?: boolean;
  onSelectionChange?: (rows: any[]) => void;
  server?: Server;
  columnVisibility?: VisibilityState;
  onColumnVisibilityChange?: (state: VisibilityState) => void;
}) {
  const [search, setSearch] = useState(searchValue || "");
  useEffect(() => {
    if (searchValue !== undefined) setSearch(searchValue);
  }, [searchValue]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    },
    [],
  );
  const [sorting, setSorting] = useState<SortingState>([]);
  const [visibility, setVisibility] = useState<VisibilityState>({});
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const selectionScope = selectable
    ? data
        .map((item, index) => String(item.id || item.sku_id || index))
        .join("|")
    : "";
  useEffect(() => {
    if (selectable) {
      setSelected({});
      onSelectionChange?.([]);
    }
  }, [selectionScope, selectable]);
  const filtered = useMemo(
    () =>
      server
        ? data
        : data.filter(
            (row) =>
              !search ||
              (searchKeys
                ? searchKeys.map((k) => row[k]).join(" ")
                : JSON.stringify(row)
              )
                .toLowerCase()
                .includes(search.toLowerCase()),
          ),
    [data, search, searchKeys, server],
  );
  const columnDefs = useMemo(
    () =>
      columns.map((c) => ({
        ...c,
        ...((c.meta as any)?.numeric
          ? {
              sortingFn: (a: any, b: any, id: string) =>
                Number(a.getValue(id) ?? -Infinity) -
                Number(b.getValue(id) ?? -Infinity),
            }
          : {}),
      })),
    [columns],
  );
  const table = useReactTable({
    data: filtered,
    columns: columnDefs,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    manualPagination: !!server,
    manualSorting: !!server,
    autoResetPageIndex: false,
    state: {
      sorting: sortingValue ? [sortingValue] : sorting,
      columnVisibility: columnVisibility || visibility,
    },
    onSortingChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater(sortingValue ? [sortingValue] : sorting)
          : updater;
      setSorting(next);
      server?.onSortChange?.(next[0] || { id: "revenue", desc: true });
    },
    onColumnVisibilityChange: (updater) => {
      const next =
        typeof updater === "function"
          ? updater(columnVisibility || visibility)
          : updater;
      setVisibility(next);
      onColumnVisibilityChange?.(next);
    },
    initialState: { pagination: { pageSize } },
  });
  useEffect(() => {
    if (
      !server &&
      table.getState().pagination.pageIndex > 0 &&
      table.getState().pagination.pageIndex * pageSize >= filtered.length
    )
      table.setPageIndex(0);
    if (
      server &&
      server.page > 1 &&
      (server.page - 1) * pageSize >= server.total
    )
      server.onPageChange(1);
  }, [filtered.length, pageSize, server, table]);
  const select = (id: string) => {
    const next = { ...selected, [id]: !selected[id] };
    setSelected(next);
    onSelectionChange?.(
      data.filter(
        (item, index) => next[String(item.id || item.sku_id || index)],
      ),
    );
  };
  const total = server?.total ?? filtered.length;
  const page = server?.page ?? table.getState().pagination.pageIndex + 1;
  const canPrevious = server ? page > 1 : table.getCanPreviousPage();
  const canNext = server ? page * pageSize < total : table.getCanNextPage();
  return (
    <div className="data-table">
      <div className="table-toolbar">
        <label className="search-input">
          <Search size={15} />
          <input
            aria-label={searchPlaceholder}
            placeholder={searchPlaceholder}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              if (server) {
                if (searchTimer.current) clearTimeout(searchTimer.current);
                const value = e.target.value;
                searchTimer.current = setTimeout(
                  () => server.onSearchChange?.(value),
                  250,
                );
              } else table.setPageIndex(0);
            }}
          />
        </label>
        <div className="table-toolbar-right">
          <span className="muted">共 {total.toLocaleString()} 条</span>
          <Popover
            trigger={
              <Button size="sm">
                <SlidersHorizontal size={14} />
                列设置
              </Button>
            }
          >
            <div className="popover-title">显示列</div>
            {table.getAllLeafColumns().map((column) => (
              <label className="check-option" key={column.id}>
                <input
                  type="checkbox"
                  checked={column.getIsVisible()}
                  onChange={column.getToggleVisibilityHandler()}
                />
                {typeof column.columnDef.header === "string"
                  ? column.columnDef.header
                  : column.id}
              </label>
            ))}
          </Popover>
        </div>
      </div>
      <div className="table-scroll">
        <table className={selectable ? "has-selection" : ""}>
          <thead>
            {table.getHeaderGroups().map((group) => (
              <tr key={group.id}>
                {selectable && <th className="selection-cell" />}
                {group.headers.map((header) => (
                  <th
                    key={header.id}
                    className={
                      (header.column.columnDef.meta as any)?.numeric
                        ? "numeric"
                        : ""
                    }
                  >
                    <button onClick={header.column.getToggleSortingHandler()}>
                      {flexRender(
                        header.column.columnDef.header,
                        header.getContext(),
                      )}
                      {header.column.getCanSort() && <ArrowUpDown size={11} />}
                    </button>
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row, index) => (
              <tr
                key={row.id}
                onClick={() => onRowClick?.(row.original)}
                tabIndex={onRowClick ? 0 : undefined}
                onKeyDown={(e) => {
                  if (onRowClick && (e.key === "Enter" || e.key === " ")) {
                    e.preventDefault();
                    onRowClick(row.original);
                  }
                }}
                className={onRowClick ? "clickable-row" : ""}
              >
                {selectable && (
                  <td className="selection-cell">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${row.original.sku_id || row.id}`}
                      checked={
                        !!selected[
                          String(
                            row.original.id || row.original.sku_id || index,
                          )
                        ]
                      }
                      onClick={(e) => e.stopPropagation()}
                      onChange={() =>
                        select(
                          String(
                            row.original.id || row.original.sku_id || index,
                          ),
                        )
                      }
                    />
                  </td>
                )}
                {row.getVisibleCells().map((cell) => (
                  <td
                    key={cell.id}
                    className={
                      (cell.column.columnDef.meta as any)?.numeric
                        ? "numeric"
                        : ""
                    }
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {!filtered.length && (
          <div className="empty-state">
            <PackageSearch size={32} />
            <strong>暂时没有符合条件的数据</strong>
            <span>调整筛选条件，或清空搜索后再试。</span>
            <Button
              size="sm"
              onClick={() => {
                setSearch("");
                server?.onSearchChange?.("");
              }}
            >
              清空搜索
            </Button>
          </div>
        )}
      </div>
      <div className="table-footer">
        <span>
          第 {total ? (page - 1) * pageSize + 1 : 0}–
          {Math.min(page * pageSize, total)} 条，共 {total} 条
        </span>
        <div className="pagination">
          <Button
            size="icon"
            disabled={!canPrevious}
            onClick={() =>
              server ? server.onPageChange(page - 1) : table.previousPage()
            }
            aria-label="上一页"
          >
            <ChevronLeft size={15} />
          </Button>
          <span>{page}</span>
          <Button
            size="icon"
            disabled={!canNext}
            onClick={() =>
              server ? server.onPageChange(page + 1) : table.nextPage()
            }
            aria-label="下一页"
          >
            <ChevronRight size={15} />
          </Button>
        </div>
      </div>
    </div>
  );
}
