from typing import Any
from pydantic import BaseModel, ConfigDict, Field


class FlexibleModel(BaseModel):
    model_config = ConfigDict(extra="allow")


class Metrics(FlexibleModel):
    sales: str
    revenue: str
    refunds: str
    cost: str
    gross_profit: str
    profit: str
    profit_margin: str | None
    orders: int
    units: float
    aov: str | None
    refund_rate: str | None
    coverage: str
    unknown_revenue: str
    known_revenue: str
    platform_fee: str
    packaging_fee: str
    logistics_fee: str
    advertising_fee: str
    unallocated_fees: str


class AnalyticsResponse(FlexibleModel):
    summary: Metrics
    previous: Metrics
    trend: list[dict[str, Any]]
    rows: list[dict[str, Any]]
    total: int
    page: int
    page_size: int
    anomalies: list[dict[str, Any]]
    breakdown: list[dict[str, Any]]
    refund_reasons: list[dict[str, Any]]
    targets: list[dict[str, Any]]
    meta: dict[str, Any]


class CostPreviewRequest(BaseModel):
    sku_ids: list[str] = Field(min_length=1, max_length=500)
    scope: str = "base"
    scope_id: str = "base"
    unit_cost: str | None = None
    adjustment_type: str = "absolute"
    adjustment_value: str = "0"
    effective_from: str
    note: str = Field(min_length=1, max_length=1000)
    allow_zero: bool = False


class RecalculationRequest(FlexibleModel):
    sku_ids: list[str] = []
    channel_ids: list[str] = []
    store_ids: list[str] = []
    start: str = "2026-08-30"
    end: str = "2026-09-28"
    only_missing: bool = True


class SimulationRequest(RecalculationRequest):
    unit_cost: str
    only_missing: bool = False


class CommitRequest(BaseModel):
    preview_id: str
    idempotency_key: str = Field(min_length=1, max_length=200)
    revision: int | None = None


class MappingRequest(BaseModel):
    mapping_id: str
    sku_id: str
    unit_factor: str = "1"


class ReportViewRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    report_type: str
    filters: dict[str, Any] = {}
    columns: list[str] = []
    sort: dict[str, Any] = {}


class TargetRequest(BaseModel):
    target: str
    idempotency_key: str = Field(min_length=1)
