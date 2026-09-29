// @vitest-environment jsdom
import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DataTable } from "./table";
afterEach(cleanup);
describe("report table interaction", () => {
  it("sorts decimal-string amounts numerically, preserves input, and recovers empty search", () => {
    render(
      <DataTable
        data={[
          { id: "a", name: "较高", amount: "100.20" },
          { id: "b", name: "较低", amount: "100.11" },
        ]}
        columns={[
          { accessorKey: "name", header: "名称" },
          { accessorKey: "amount", header: "金额", meta: { numeric: true } },
        ]}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "金额" }));
    const rows = screen.getAllByRole("row");
    expect(within(rows[1]).getByText("较低")).toBeTruthy();
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "没有匹配" } });
    expect((input as HTMLInputElement).value).toBe("没有匹配");
    expect(screen.getByText("暂时没有符合条件的数据")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "清空搜索" }));
    expect(screen.getByText("较低")).toBeTruthy();
  });
  it("opens evidence from the keyboard and handles a stable empty initial dataset", () => {
    const open = vi.fn();
    const view = render(
      <DataTable
        data={[]}
        columns={[{ accessorKey: "name", header: "名称" }]}
        onRowClick={open}
      />,
    );
    expect(screen.getByText("暂时没有符合条件的数据")).toBeTruthy();
    view.rerender(
      <DataTable
        data={[{ id: "a", name: "订单证据" }]}
        columns={[{ accessorKey: "name", header: "名称" }]}
        onRowClick={open}
      />,
    );
    fireEvent.keyDown(screen.getByText("订单证据").closest("tr")!, {
      key: "Enter",
    });
    expect(open).toHaveBeenCalledWith({ id: "a", name: "订单证据" });
  });
});
