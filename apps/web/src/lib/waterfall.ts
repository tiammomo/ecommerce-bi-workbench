import { trendColors, chartColors } from "./utils";

export type WaterfallEntry = {
  name: string;
  amount: string;
  kind: string;
};

export type WaterfallRange = {
  name: string;
  amount: string;
  kind: string;
  value: [number, number, number];
  itemStyle: { color: string };
};

/** Coordinate ranges preserve negative values and deltas crossing the zero axis. */
export function waterfallRanges(entries: WaterfallEntry[]): WaterfallRange[] {
  let running = 0;
  return entries.map((entry, index) => {
    const amount = Number(entry.amount);
    const start = entry.kind === "total" ? 0 : running;
    const end = entry.kind === "total" ? amount : start + amount;
    running = end;
    return {
      ...entry,
      value: [index, start, end],
      itemStyle: {
        color:
          entry.kind === "total"
            ? chartColors.profit
            : amount > 0
              ? trendColors.rise
              : amount < 0
                ? trendColors.fall
                : trendColors.neutral,
      },
    };
  });
}

/** ECharts CustomChart needs to be registered by the shared chart component. */
export function waterfallSeries(entries: WaterfallEntry[]) {
  const data = waterfallRanges(entries);
  return {
    name: "利润形成",
    type: "custom" as const,
    dimensions: ["index", "from", "to"],
    encode: { x: 0, y: [1, 2] },
    data,
    renderItem(params: any, api: any) {
      const index = Number(api.value(0));
      const from = api.coord([index, api.value(1)]);
      const to = api.coord([index, api.value(2)]);
      const band = Math.min(40, Math.abs(api.size([1, 0])[0]) * 0.62);
      const grid = params.coordSys;
      const top = Math.max(grid.y, Math.min(from[1], to[1]));
      const bottom = Math.min(grid.y + grid.height, Math.max(from[1], to[1]));
      if (bottom < top) return null;
      return {
        type: "rect",
        shape: {
          x: from[0] - band / 2,
          y: top,
          width: band,
          height: Math.max(1, bottom - top),
          r: 3,
        },
        style: { fill: data[index]?.itemStyle.color || chartColors.profit },
        emphasis: { style: { opacity: 0.8 } },
      };
    },
  };
}
