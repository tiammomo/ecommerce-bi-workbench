// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Metrics } from "@/api/types";
import { Change, Kpis } from "./common";

afterEach(cleanup);

describe("changes follow numeric direction for every metric", () => {
  it("renders revenue rises and falls with matching signs and arrows", () => {
    const view = render(<Change current="120" previous="100" />);
    expect(view.container.firstElementChild?.className).toBe("change-positive");
    expect(view.container.textContent).toContain("+20.0%");
    expect(
      view.container.querySelector(".lucide-arrow-up-right"),
    ).not.toBeNull();
    expect(view.container.querySelector(".lucide-arrow-down-right")).toBeNull();

    view.rerender(<Change current="80" previous="100" />);
    expect(view.container.firstElementChild?.className).toBe("change-negative");
    expect(view.container.textContent).toContain("-20.0%");
    expect(
      view.container.querySelector(".lucide-arrow-down-right"),
    ).not.toBeNull();
    expect(view.container.querySelector(".lucide-arrow-up-right")).toBeNull();
  });

  it("keeps refund-rate rises and falls in their actual direction in the KPI grid", () => {
    const base = {
      revenue: "100",
      profit: "20",
      orders: 5,
      aov: "20",
      profit_margin: "0.2",
      refund_rate: "0.05",
      coverage: "1",
    } as Metrics;
    const view = render(
      <Kpis summary={{ ...base, refund_rate: "0.07" }} previous={base} />,
    );
    const refundChange = () =>
      view.container.querySelector(".kpi-refund_rate .kpi-bottom > span");
    expect(refundChange()?.className).toBe("change-positive");
    expect(refundChange()?.textContent).toBe("+2.0 个百分点");

    view.rerender(
      <Kpis summary={{ ...base, refund_rate: "0.03" }} previous={base} />,
    );
    expect(refundChange()?.className).toBe("change-negative");
    expect(refundChange()?.textContent).toBe("-2.0 个百分点");
  });

  it("renders unchanged amounts and rates as neutral without an upward sign", () => {
    const view = render(<Change current="100" previous="100" />);
    for (const props of [
      { current: "100", previous: "100" },
      { current: "0.05", previous: "0.05", rate: true },
      { current: "0", previous: "0" },
      { current: "-100", previous: "-100" },
    ]) {
      view.rerender(<Change {...props} />);
      expect(view.container.firstElementChild?.className).toBe(
        "change-neutral",
      );
      expect(view.container.textContent).toBe("持平");
      expect(view.container.querySelector("svg")).toBeNull();
    }
  });

  it("keeps missing and non-finite comparisons unknown instead of suggesting a rise or fall", () => {
    const view = render(<Change current={null} previous="100" />);
    for (const unknown of [
      null,
      undefined,
      "",
      " ",
      "NaN",
      NaN,
      Infinity,
      -Infinity,
    ]) {
      for (const props of [
        { current: unknown, previous: "100" },
        { current: "100", previous: unknown, rate: true },
      ]) {
        view.rerender(<Change {...props} />);
        expect(view.container.firstElementChild?.className).toBe("muted");
        expect(view.container.textContent).toBe("历史数据不足");
        expect(view.container.querySelector("svg")).toBeNull();
      }
    }
  });

  it("colors negative-base improvements and declines by their absolute change", () => {
    const view = render(<Change current="-50" previous="-100" />);
    expect(view.container.firstElementChild?.className).toBe("change-positive");
    expect(view.container.textContent).toBe("变化 +¥50.00");

    view.rerender(<Change current="-150" previous="-100" />);
    expect(view.container.firstElementChild?.className).toBe("change-negative");
    expect(view.container.textContent).toBe("变化 -¥50.00");

    view.rerender(<Change current="25" previous="-100" />);
    expect(view.container.firstElementChild?.className).toBe("change-positive");
    expect(view.container.textContent).toBe("由亏转盈");
  });

  it("retains the no-comparable-base label without inventing a percentage", () => {
    const view = render(<Change current="100" previous="0" />);
    expect(view.container.firstElementChild?.className).toBe("change-positive");
    expect(view.container.textContent).toBe("无可比基数");

    view.rerender(<Change current="-100" previous="0" />);
    expect(view.container.firstElementChild?.className).toBe("change-negative");
    expect(view.container.textContent).toBe("无可比基数");
  });
});
