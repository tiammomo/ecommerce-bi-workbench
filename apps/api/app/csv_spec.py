"""Versioned, human-readable CSV contracts shared by generator and importer."""

from __future__ import annotations

import csv
import io
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP, localcontext

TEMPLATE_VERSION = "1"
MAX_FILE_BYTES = 20 * 1024 * 1024
MAX_BATCH_ROWS = 100_000
MAX_MINOR = 100_000_000_000_000


@dataclass(frozen=True)
class Field:
    name: str
    kind: str = "text"
    required: bool = True
    description: str = ""


def field(name, kind="text", required=True, description=""):
    return Field(name, kind, required, description)


SPECS: dict[str, tuple[Field, ...]] = {
    "channels": (field("id"), field("name"), field("color")),
    "stores": (
        field("id"),
        field("channel_id"),
        field("name"),
        field("market"),
        field("mode"),
        field("currency"),
        field("timezone"),
    ),
    "products": (field("id"), field("name"), field("category"), field("series")),
    "skus": (field("id"), field("product_id"), field("spec"), field("unit")),
    "mappings": (
        field("id"),
        field("store_id"),
        field("platform_product_id"),
        field("platform_sku"),
        field("sku_id", required=False),
        field("unit"),
        field("factor", "quantity", description="平台单位到标准单位倍数，最多4位小数"),
        field("status"),
    ),
    "fx_rates": (
        field("id"),
        field("currency"),
        field("date", "date"),
        field("rate", "rate", description="1单位原币兑人民币，最多8位小数"),
        field("source"),
    ),
    "costs": (
        field("id"),
        field("sku_id"),
        field("scope"),
        field("scope_id"),
        field("unit_cost", "cost", description="人民币元/标准单位，最多4位小数"),
        field("valid_from", "datetime"),
        field("valid_to", "datetime", False),
        field("note"),
    ),
    "orders": (
        field("id"),
        field("platform_order_id"),
        field("channel_id"),
        field("store_id"),
        field("paid_at", "datetime", False),
        field("status"),
        field("currency"),
        field("fx_rate", "rate", False),
    ),
    "order_lines": (
        field("id"),
        field("order_id"),
        field("platform_sku"),
        field("sku_id", required=False),
        field("quantity", "quantity"),
        field("factor", "quantity"),
        field("revenue_original", "money", description="优惠后应收商品金额，原币元，最多2位小数"),
    ),
    "refunds": (
        field("id"),
        field("line_id"),
        field("completed_at", "datetime", False),
        field("amount_original", "money"),
        field("kind"),
        field("reason"),
        field("quantity", "quantity"),
        field("recoverable_quantity", "quantity"),
        field("status"),
    ),
    "expenses": (
        field("id"),
        field("store_id"),
        field("date", "date"),
        field("kind"),
        field("amount_original", "signed_money"),
        field("currency"),
        field("fx_rate", "rate"),
        field("order_id", required=False),
        field("line_id", required=False),
        field("source"),
    ),
    "targets": (
        field("id"),
        field("store_id"),
        field("month", "month"),
        field("amount", "money"),
    ),
}

LABELS = {
    "channels": "销售渠道",
    "stores": "店铺",
    "products": "标准商品",
    "skus": "标准 SKU",
    "mappings": "平台 SKU 映射",
    "fx_rates": "演示汇率",
    "costs": "成本版本",
    "orders": "订单",
    "order_lines": "订单行",
    "refunds": "退款事件",
    "expenses": "费用记录",
    "targets": "月度目标",
}

UNIQUE_KEYS = {
    "channels": ["id"],
    "stores": ["id"],
    "products": ["id"],
    "skus": ["id"],
    "mappings": ["store_id", "platform_sku"],
    "fx_rates": ["currency", "date"],
    "costs": ["id"],
    "orders": ["channel_id", "store_id", "platform_order_id"],
    "order_lines": ["id"],
    "refunds": ["id"],
    "expenses": ["id"],
    "targets": ["store_id", "month"],
}


def decimal_value(value: str, places: int, *, allow_negative=False) -> Decimal:
    """Reject invalid precision instead of silently rounding imported source data."""
    try:
        result = Decimal(value)
    except InvalidOperation as exc:
        raise ValueError("请输入不带千分位和货币符号的十进制数") from exc
    if not result.is_finite() or (result < 0 and not allow_negative):
        raise ValueError("金额/数量必须是有限非负数")
    if result.as_tuple().exponent < -places:
        raise ValueError(f"最多允许 {places} 位小数")
    if abs(result) > Decimal("1000000000000"):
        raise ValueError("数值超过允许范围")
    return result


def scaled(value: str | Decimal, scale: int) -> int:
    with localcontext() as context:
        context.prec = 38
        number = Decimal(value)
        if not number.is_finite():
            raise ValueError("数值必须有限")
        result = int((number * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
        if abs(result) > MAX_MINOR:
            raise ValueError("金额超过允许范围")
        return result


def dump_csv(template: str, rows: list[dict], *, bom=True) -> str:
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=[entry.name for entry in SPECS[template]], lineterminator="\n")
    writer.writeheader()
    writer.writerows({key: "" if value is None else value for key, value in row.items()} for row in rows)
    return ("\ufeff" if bom else "") + stream.getvalue()


def safe_display_csv(headers: list[str], rows: list[list]) -> str:
    """Display exports neutralize spreadsheet formulas; canonical exports preserve IDs."""
    stream = io.StringIO(newline="")
    writer = csv.writer(stream, lineterminator="\r\n")
    writer.writerow(headers)
    for row in rows:
        writer.writerow(
            "'" + value
            if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@", "\t", "\r"))
            else value
            for value in row
        )
    return "\ufeff" + stream.getvalue()
