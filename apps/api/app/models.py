"""Persistent business records. Monetary values are integer minor units (CNY fen)."""

from sqlalchemy import CheckConstraint, ForeignKey, Index, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Channel(Base):
    __tablename__ = "channels"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]
    color: Mapped[str]


class Store(Base):
    __tablename__ = "stores"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"), index=True)
    name: Mapped[str]
    market: Mapped[str] = mapped_column(default="中国")
    mode: Mapped[str] = mapped_column(default="商家自营")
    currency: Mapped[str] = mapped_column(default="CNY")
    timezone: Mapped[str] = mapped_column(default="Asia/Shanghai")
    status: Mapped[str] = mapped_column(default="active")


class Product(Base):
    __tablename__ = "products"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]
    category: Mapped[str]
    series: Mapped[str] = mapped_column(default="日常精选")
    image: Mapped[str] = mapped_column(default="box")


class StandardSku(Base):
    __tablename__ = "skus"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    product_id: Mapped[str] = mapped_column(ForeignKey("products.id"), index=True)
    spec: Mapped[str]
    unit: Mapped[str] = mapped_column(default="件")


class ListingMapping(Base):
    __tablename__ = "mappings"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    platform_product_id: Mapped[str]
    platform_sku: Mapped[str]
    sku_id: Mapped[str | None] = mapped_column(ForeignKey("skus.id"), nullable=True, index=True)
    sales_unit: Mapped[str] = mapped_column(default="件")
    factor_scaled: Mapped[int] = mapped_column(Integer, default=10000)
    status: Mapped[str] = mapped_column(default="mapped")
    __table_args__ = (UniqueConstraint("store_id", "platform_sku"), CheckConstraint("factor_scaled > 0"))


class FxRate(Base):
    __tablename__ = "fx_rates"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    currency: Mapped[str]
    business_date: Mapped[str]
    rate_scaled: Mapped[int] = mapped_column(Integer)
    source: Mapped[str] = mapped_column(default="演示汇率")
    __table_args__ = (UniqueConstraint("currency", "business_date"), CheckConstraint("rate_scaled > 0"))


class CostVersion(Base):
    __tablename__ = "cost_versions"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    sku_id: Mapped[str] = mapped_column(ForeignKey("skus.id"), index=True)
    level: Mapped[str]  # base | channel | store
    scope_id: Mapped[str] = mapped_column(default="base")
    unit_cost_scaled: Mapped[int] = mapped_column(Integer)
    effective_from: Mapped[str]
    effective_to: Mapped[str | None] = mapped_column(nullable=True)
    source: Mapped[str] = mapped_column(default="人工维护")
    note: Mapped[str] = mapped_column(default="")
    created_at: Mapped[str]
    __table_args__ = (
        UniqueConstraint("sku_id", "level", "scope_id", "effective_from"),
        CheckConstraint("unit_cost_scaled >= 0 AND unit_cost_scaled <= 100000000000000"),
        CheckConstraint("typeof(unit_cost_scaled) = 'integer'"),
        CheckConstraint("level IN ('base', 'channel', 'store')"),
        CheckConstraint("effective_to IS NULL OR effective_to > effective_from"),
        Index("ix_cost_scope_date", "sku_id", "level", "scope_id", "effective_from", "effective_to"),
    )


class Order(Base):
    __tablename__ = "orders"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    platform_order_no: Mapped[str]
    channel_id: Mapped[str] = mapped_column(ForeignKey("channels.id"))
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"))
    paid_at: Mapped[str]
    business_date: Mapped[str]
    status: Mapped[str] = mapped_column(default="paid")
    currency: Mapped[str] = mapped_column(default="CNY")
    fx_rate_scaled: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fx_date: Mapped[str]
    __table_args__ = (
        UniqueConstraint("channel_id", "store_id", "platform_order_no"),
        Index("ix_order_store_date", "store_id", "business_date"),
        Index("ix_order_paid", "paid_at"),
    )


class OrderLine(Base):
    __tablename__ = "order_lines"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_id: Mapped[str] = mapped_column(ForeignKey("orders.id"), index=True)
    platform_sku: Mapped[str]
    sku_id: Mapped[str | None] = mapped_column(ForeignKey("skus.id"), nullable=True, index=True)
    quantity_scaled: Mapped[int] = mapped_column(Integer, default=10000)
    factor_scaled: Mapped[int] = mapped_column(Integer, default=10000)
    standard_quantity_scaled: Mapped[int] = mapped_column(Integer, default=10000)
    original_amount: Mapped[str] = mapped_column(default="0.00")
    revenue_minor: Mapped[int] = mapped_column(Integer)
    cost_minor: Mapped[int | None] = mapped_column(Integer, nullable=True)
    unit_cost_scaled: Mapped[int | None] = mapped_column(Integer, nullable=True)
    cost_version_id: Mapped[str | None] = mapped_column(ForeignKey("cost_versions.id"), nullable=True)
    cost_source: Mapped[str | None] = mapped_column(nullable=True)
    platform_fee_minor: Mapped[int] = mapped_column(Integer, default=0)
    packaging_fee_minor: Mapped[int] = mapped_column(Integer, default=0)
    logistics_fee_minor: Mapped[int] = mapped_column(Integer, default=0)
    advertising_fee_minor: Mapped[int] = mapped_column(Integer, default=0)
    accounting_status: Mapped[str] = mapped_column(default="complete")
    accounted_at: Mapped[str | None] = mapped_column(nullable=True)
    __table_args__ = (
        CheckConstraint("revenue_minor >= 0 AND revenue_minor <= 100000000000000"),
        CheckConstraint("typeof(revenue_minor) = 'integer'"),
        CheckConstraint("cost_minor IS NULL OR cost_minor >= 0"),
        CheckConstraint("quantity_scaled > 0 AND factor_scaled > 0 AND standard_quantity_scaled > 0"),
    )


class RefundEvent(Base):
    __tablename__ = "refunds"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    order_line_id: Mapped[str] = mapped_column(ForeignKey("order_lines.id"), index=True)
    completed_at: Mapped[str]
    business_date: Mapped[str] = mapped_column(index=True)
    amount_minor: Mapped[int] = mapped_column(Integer)
    original_amount: Mapped[str] = mapped_column(default="0.00")
    refund_type: Mapped[str] = mapped_column(default="refund_only")
    reason: Mapped[str] = mapped_column(default="个人原因")
    quantity_scaled: Mapped[int] = mapped_column(Integer, default=0)
    recoverable_quantity_scaled: Mapped[int] = mapped_column(Integer, default=0)
    cost_reversal_minor: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(default="completed")
    __table_args__ = (
        CheckConstraint("amount_minor >= 0 AND cost_reversal_minor >= 0"),
        CheckConstraint("typeof(amount_minor) = 'integer'"),
    )


class ExpenseEntry(Base):
    __tablename__ = "expenses"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"), index=True)
    business_date: Mapped[str] = mapped_column(index=True)
    expense_type: Mapped[str]
    amount_minor: Mapped[int] = mapped_column(Integer)
    order_id: Mapped[str | None] = mapped_column(ForeignKey("orders.id"), nullable=True)
    order_line_id: Mapped[str | None] = mapped_column(ForeignKey("order_lines.id"), nullable=True)
    original_amount: Mapped[str] = mapped_column(default="0.00")
    currency: Mapped[str] = mapped_column(default="CNY")
    fx_rate_scaled: Mapped[int | None] = mapped_column(Integer, nullable=True)
    fx_date: Mapped[str] = mapped_column(default="")
    source: Mapped[str] = mapped_column(default="演示费用记录")
    allocated: Mapped[bool] = mapped_column(default=True)
    allocation_method: Mapped[str] = mapped_column(default="按支付商品收入比例估算分摊")
    __table_args__ = (CheckConstraint("typeof(amount_minor) = 'integer'"),)


class SalesTarget(Base):
    __tablename__ = "targets"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    store_id: Mapped[str] = mapped_column(ForeignKey("stores.id"))
    month: Mapped[str]
    amount_minor: Mapped[int] = mapped_column(Integer)
    __table_args__ = (UniqueConstraint("store_id", "month"), CheckConstraint("amount_minor >= 0"))


class SavedReportView(Base):
    __tablename__ = "saved_reports"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str]
    report_type: Mapped[str]
    filters_json: Mapped[str] = mapped_column(Text, default="{}")
    columns_json: Mapped[str] = mapped_column(Text, default="[]")
    sort_json: Mapped[str] = mapped_column(Text, default="{}")
    created_at: Mapped[str]


class ChangeLog(Base):
    __tablename__ = "change_logs"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    operation_type: Mapped[str]
    entity_id: Mapped[str]
    before_json: Mapped[str] = mapped_column(Text, default="{}")
    after_json: Mapped[str] = mapped_column(Text, default="{}")
    note: Mapped[str] = mapped_column(default="")
    created_at: Mapped[str]
    operation_id: Mapped[str | None] = mapped_column(nullable=True)


class OperationPreview(Base):
    __tablename__ = "previews"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    operation_type: Mapped[str]
    request_json: Mapped[str] = mapped_column(Text)
    summary_json: Mapped[str] = mapped_column(Text)
    revision: Mapped[int] = mapped_column(Integer)
    expires_at: Mapped[str]
    created_at: Mapped[str]


class OperationRecord(Base):
    __tablename__ = "operations"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    idempotency_key: Mapped[str] = mapped_column(unique=True)
    request_digest: Mapped[str]
    operation_type: Mapped[str]
    result_json: Mapped[str] = mapped_column(Text)
    actor: Mapped[str] = mapped_column(default="演示操作人")
    created_at: Mapped[str]


class WorkspaceState(Base):
    __tablename__ = "workspace_state"
    id: Mapped[str] = mapped_column(String, primary_key=True, default="demo")
    dataset_version: Mapped[str] = mapped_column(default="")
    revision: Mapped[int] = mapped_column(Integer, default=0)
    demo_as_of: Mapped[str] = mapped_column(default="2026-09-28T23:59:59+08:00")


class ImportBatch(Base):
    __tablename__ = "import_batches"
    id: Mapped[str] = mapped_column(String, primary_key=True)
    template_type: Mapped[str]
    template_version: Mapped[str] = mapped_column(default="1")
    file_digest: Mapped[str]
    preview_json: Mapped[str] = mapped_column(Text)
    payload_json: Mapped[str] = mapped_column(Text)
    revision: Mapped[int]
    status: Mapped[str] = mapped_column(default="previewed")
    created_at: Mapped[str]
    operation_id: Mapped[str | None] = mapped_column(nullable=True)


Sku = StandardSku
Mapping = ListingMapping
Refund = RefundEvent
Expense = ExpenseEntry
Target = SalesTarget
Preview = OperationPreview
Operation = OperationRecord

# SQLite affinity alone does not guarantee integer storage. Apply explicit CHECKs
# to every persisted monetary/quantity multiplier, including nullable snapshots.
for _table in Base.metadata.tables.values():
    for _column in _table.columns:
        if isinstance(_column.type, Integer) and _column.name.endswith(("_minor", "_scaled")):
            _table.append_constraint(
                CheckConstraint(
                    f"{_column.name} IS NULL OR (typeof({_column.name}) = 'integer' AND {_column.name} BETWEEN -100000000000000 AND 100000000000000)",
                    name=f"ck_{_table.name}_{_column.name}_integer",
                )
            )
