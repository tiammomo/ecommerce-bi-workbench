import { describe, expect, it } from "vitest";
import { waterfallRanges } from "./waterfall";

describe("profit waterfall geometry", () => {
  it("places a deduction crossing zero between the actual start and end", () => {
    const points = waterfallRanges([
      { name: "商品毛利", amount: "20.00", kind: "total" },
      { name: "物流费", amount: "-30.00", kind: "delta" },
      { name: "经营贡献利润", amount: "-10.00", kind: "total" },
    ]);
    expect(points.map((point) => point.value)).toEqual([
      [0, 0, 20],
      [1, 20, -10],
      [2, 0, -10],
    ]);
  });

  it("resets subtotal baselines rather than adding them a second time", () => {
    const points = waterfallRanges([
      { name: "商品收入", amount: "200.00", kind: "total" },
      { name: "退款", amount: "-20.00", kind: "delta" },
      { name: "净销售收入", amount: "180.00", kind: "total" },
      { name: "商品成本", amount: "-115.00", kind: "delta" },
      { name: "商品毛利", amount: "65.00", kind: "total" },
    ]);
    expect(points[3].value).toEqual([3, 180, 65]);
    expect(points[4].value).toEqual([4, 0, 65]);
  });
  it("colors changes by numeric direction, with neutral zero and purple totals", () => {
    const points = waterfallRanges([
      { name: "商品毛利", amount: "10.00", kind: "total" },
      { name: "退款成本转回", amount: "20.00", kind: "delta" },
      { name: "广告费用扣减", amount: "-40.00", kind: "delta" },
      { name: "未发生调整", amount: "0.00", kind: "delta" },
      { name: "负贡献利润合计", amount: "-10.00", kind: "total" },
    ]);
    expect(points.map((point) => point.itemStyle.color)).toEqual([
      "#8b5cf6",
      "#b7465b",
      "#23765d",
      "#8791a2",
      "#8b5cf6",
    ]);
    expect(points[2].value).toEqual([2, 30, -10]);
    expect(points[3].value).toEqual([3, -10, -10]);
  });
});
