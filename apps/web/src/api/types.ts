import type { components } from "../../../../packages/api-types";
export type Metrics = components["schemas"]["Metrics"] & {
  gross_margin?: string;
  refund_orders?: number;
};
export type MetricRow = Metrics & {
  id: string;
  name: string;
  channel_id?: string;
  store_id?: string;
  sku_id?: string;
  spec?: string;
  date?: string;
};
export type Meta = {
  channels: { id: string; name: string; color: string }[];
  stores: {
    id: string;
    name: string;
    channel_id: string;
    site: string;
    currency: string;
  }[];
  products: { id: string; name: string; category: string }[];
  skus: {
    id: string;
    product_id: string;
    name: string;
    spec: string;
    category: string;
  }[];
  as_of: string;
  revision: number;
  timezone: string;
  dataset_version: string;
};
export type Analytics = Omit<
  components["schemas"]["AnalyticsResponse"],
  | "trend"
  | "rows"
  | "anomalies"
  | "breakdown"
  | "refund_reasons"
  | "targets"
  | "meta"
> & {
  summary: Metrics;
  previous: Metrics;
  trend: (Metrics & { date: string })[];
  rows: MetricRow[];
  total: number;
  anomalies: {
    title: string;
    description: string;
    severity: string;
    target: string;
    filters: Record<string, string>;
  }[];
  breakdown: { name: string; amount: string }[];
  refund_reasons: { name: string; value: string }[];
  targets: {
    store_id: string;
    name: string;
    month: string;
    target: string;
    actual: string;
    rate: string;
  }[];
  meta: { revision: number; as_of: string; filters: Record<string, unknown> };
};
