import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
/** Decimal-string formatting: API currency is never converted to a binary float. */
function decimal(
  value: unknown,
): { negative: boolean; whole: string; fraction: string } | null {
  if (value == null || value === "") return null;
  let source = String(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    if (source.includes("e")) source = value.toFixed(12);
  }
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(source);
  return match
    ? {
        negative: match[1] === "-",
        whole: match[2].replace(/^0+(?=\d)/, ""),
        fraction: match[3] || "",
      }
    : null;
}
function shifted(value: unknown, places: number): string | null {
  const parsed = decimal(value);
  if (!parsed) return null;
  const all = parsed.whole + parsed.fraction;
  const point = parsed.whole.length + places;
  const result =
    point <= 0
      ? `0.${"0".repeat(-point)}${all}`
      : point >= all.length
        ? all + "0".repeat(point - all.length)
        : `${all.slice(0, point)}.${all.slice(point)}`;
  return `${parsed.negative ? "-" : ""}${result}`;
}
export const money = (value: unknown, digits = 2): string => {
  const p = decimal(value);
  if (!p) return "—";
  const padded = p.fraction.padEnd(digits + 1, "0");
  let minor =
    BigInt(p.whole) * 10n ** BigInt(digits) +
    BigInt(padded.slice(0, digits) || "0");
  if (Number(padded[digits]) >= 5) minor += 1n;
  const text = minor.toString().padStart(digits + 1, "0");
  const whole = (digits ? text.slice(0, -digits) : text).replace(
    /\B(?=(\d{3})+(?!\d))/g,
    ",",
  );
  return `${p.negative && minor !== 0n ? "-" : ""}${whole}${digits ? `.${text.slice(-digits)}` : ""}`;
};
export const compact = (value: unknown) => {
  const p = decimal(value);
  if (!p) return "—";
  return BigInt(p.whole) >= 10000n
    ? `${money(shifted(value, -4))}万`
    : money(value);
};
export const integer = (value: unknown) => money(value, 0);
export const percent = (value: unknown) =>
  value == null ? "—" : `${money(shifted(value, 2), 1)}%`;
export const shortDate = (value: unknown) => {
  if (!value) return "—";
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const date = new Date(text);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
};
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export const trendColors = {
  rise: "#b7465b",
  fall: "#23765d",
  neutral: "#8791a2",
};
/** Neutral series colors stay separate from numeric rise/fall semantics. */
export const chartColors = {
  income: "#3659e3",
  profit: "#8b5cf6",
  channelSlate: "#5a8fc7",
  axis: "#667085",
  grid: "#eaedf3",
  zero: "#c8d0de",
  tooltipText: "#344054",
  tooltipBorder: "#dde2eb",
  surface: "#ffffff",
  event: "#a85a42",
  incomeAreaFrom: "rgba(54,89,227,.14)",
  incomeAreaTo: "rgba(54,89,227,.01)",
};
export const colors = [
  chartColors.income,
  chartColors.profit,
  chartColors.channelSlate,
  "#6f89ee",
  "#b59ad8",
  "#94a3b8",
];
export const channelColors: Record<string, string> = {
  pdd: chartColors.profit,
  temu: chartColors.income,
  "1688": chartColors.channelSlate,
  alibaba: chartColors.channelSlate,
};
export const download = (url: string) => {
  const a = document.createElement("a");
  a.href = url;
  a.download = "";
  a.click();
};
