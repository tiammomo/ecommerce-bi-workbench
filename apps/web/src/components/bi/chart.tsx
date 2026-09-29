import { useEffect, useRef } from "react";
import * as echarts from "echarts/core";
import {
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  CustomChart,
} from "echarts/charts";
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DatasetComponent,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import { colors, chartColors } from "@/lib/utils";
echarts.use([
  LineChart,
  BarChart,
  PieChart,
  ScatterChart,
  CustomChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  MarkLineComponent,
  DatasetComponent,
  SVGRenderer,
]);
export const chartBase = {
  color: colors,
  textStyle: {
    fontFamily:
      'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif',
    fontSize: 13,
    color: chartColors.axis,
  },
  animationDuration: 220,
  tooltip: {
    trigger: "axis",
    backgroundColor: chartColors.surface,
    borderColor: chartColors.tooltipBorder,
    borderWidth: 1,
    textStyle: { color: chartColors.tooltipText, fontSize: 14 },
    extraCssText:
      "border-radius:10px;box-shadow:0 8px 28px rgba(16,24,40,.10);padding:12px 16px;",
  },
  grid: { left: 12, right: 20, bottom: 16, top: 36, containLabel: true },
  legend: {
    show: false,
    textStyle: { color: chartColors.axis, fontSize: 13 },
    itemWidth: 12,
    itemHeight: 12,
  },
  xAxis: {
    type: "category",
    axisTick: { show: false },
    axisLine: {
      show: true,
      onZero: true,
      lineStyle: { color: chartColors.zero, width: 1 },
    },
    axisLabel: { color: chartColors.axis, fontSize: 13, margin: 14 },
    nameTextStyle: { color: chartColors.axis, fontSize: 13 },
  },
  yAxis: {
    type: "value",
    axisLine: {
      show: true,
      onZero: true,
      lineStyle: { color: chartColors.zero, width: 1 },
    },
    axisTick: { show: false },
    splitLine: { lineStyle: { color: chartColors.grid, type: "dashed" } },
    axisLabel: { color: chartColors.axis, fontSize: 13 },
    nameTextStyle: { color: chartColors.axis, fontSize: 13 },
  },
};
export function Chart({
  option,
  height = 320,
  onClick,
  description,
}: {
  option: any;
  height?: number;
  onClick?: (event: any) => void;
  description: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const axisWithTextStyle = (base: any, axis: any): any => {
    if (axis === null) return null;
    if (Array.isArray(axis))
      return axis.map((item) => axisWithTextStyle(base, item));
    return {
      ...base,
      ...axis,
      axisLabel: { ...base.axisLabel, ...axis?.axisLabel },
      nameTextStyle: { ...base.nameTextStyle, ...axis?.nameTextStyle },
    };
  };
  useEffect(() => {
    if (!ref.current) return;
    const instance = echarts.init(ref.current, undefined, { renderer: "svg" });
    chart.current = instance;
    const resize = new ResizeObserver(() => instance.resize());
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      instance.dispose();
      chart.current = null;
    };
  }, []);
  useEffect(() => {
    const instance = chart.current;
    if (!instance) return;
    instance.setOption(
      {
        ...chartBase,
        ...option,
        xAxis: axisWithTextStyle(chartBase.xAxis, option.xAxis),
        yAxis: axisWithTextStyle(chartBase.yAxis, option.yAxis),
        tooltip: {
          ...chartBase.tooltip,
          ...option.tooltip,
          textStyle: {
            ...chartBase.tooltip.textStyle,
            ...option.tooltip?.textStyle,
          },
        },
        animation: !window.matchMedia("(prefers-reduced-motion: reduce)")
          .matches,
      },
      true,
    );
    instance.off("click");
    if (onClick) instance.on("click", onClick);
  }, [option, onClick]);
  return (
    <div
      ref={ref}
      className="chart"
      style={{ height }}
      role="img"
      aria-label={description}
    />
  );
}
