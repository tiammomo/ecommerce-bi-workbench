"""Exact arithmetic shared by import, historical accounting and simulations."""

from collections import defaultdict
from datetime import datetime, timezone
from decimal import Decimal, DefaultContext, InvalidOperation, ROUND_HALF_UP, getcontext
from zoneinfo import ZoneInfo

from sqlalchemy import select

from .models import CostVersion, ExpenseEntry, FxRate, ListingMapping, Order, OrderLine, RefundEvent

DefaultContext.prec = 38
DefaultContext.rounding = ROUND_HALF_UP
getcontext().prec = 38
getcontext().rounding = ROUND_HALF_UP
MAX_MONEY = 100_000_000_000_000
DEMO_AS_OF = "2026-09-28T15:59:59.000000Z"


class BusinessError(Exception):
    def __init__(self, message, code="validation_error", status=422, details=None):
        super().__init__(message)
        self.message, self.code, self.status, self.details = message, code, status, details


def decimal_value(value, places=None):
    try:
        result = Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        raise BusinessError("请输入合法的十进制数值") from None
    if not result.is_finite() or abs(result) > Decimal("1000000000000"):
        raise BusinessError("数值必须有限且不超过允许范围")
    if places is not None and result != result.quantize(Decimal(1).scaleb(-places)):
        raise BusinessError(f"最多允许 {places} 位小数")
    return result


def scaled(value, scale=100, places=None):
    result = int((decimal_value(value, places) * scale).quantize(Decimal("1"), rounding=ROUND_HALF_UP))
    if abs(result) > MAX_MONEY:
        raise BusinessError("金额超出允许范围")
    return result


def money(value):
    return None if value is None else f"{Decimal(value) / 100:.2f}"


def ratio(a, b):
    return None if b <= 0 else f"{Decimal(a) / Decimal(b):.8f}"


def unit_money(value):
    return None if value is None else f"{Decimal(value) / 10000:.4f}"


def now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def canonical_time(value):
    try:
        if len(value) == 10:
            dt = datetime.fromisoformat(value).replace(tzinfo=ZoneInfo("Asia/Shanghai"))
        else:
            dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if dt.tzinfo is None:
                raise ValueError("timezone required")
        return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, TypeError):
        raise BusinessError("时间必须包含时区，或使用 YYYY-MM-DD 业务日期") from None


def business_date(value):
    return (
        datetime.fromisoformat(canonical_time(value).replace("Z", "+00:00"))
        .astimezone(ZoneInfo("Asia/Shanghai"))
        .date()
        .isoformat()
    )


def line_cost(unit_cost_scaled, standard_quantity_scaled):
    return int(
        (Decimal(unit_cost_scaled) * Decimal(standard_quantity_scaled) / 1_000_000).quantize(
            Decimal("1"), rounding=ROUND_HALF_UP
        )
    )


def allocate_minor(total, weights):
    """Largest remainder allocation with stable lexical tie breaking. Exact sum."""
    if not weights or sum(weights.values()) <= 0:
        return {}
    sign = -1 if total < 0 else 1
    total = abs(total)
    denominator = sum(weights.values())
    raw = {key: Decimal(total) * amount / denominator for key, amount in weights.items()}
    result = {key: int(value) for key, value in raw.items()}
    remainder = total - sum(result.values())
    for key in sorted(raw, key=lambda k: (-(raw[k] - result[k]), str(k)))[:remainder]:
        result[key] += 1
    return {key: value * sign for key, value in result.items()}


def cost_index(session):
    result = defaultdict(list)
    for version in session.scalars(select(CostVersion)):
        result[(version.sku_id, version.level, version.scope_id)].append(version)
    return result


def resolve_cost(session, sku_id, channel_id, store_id, paid_at, index=None):
    index = index if index is not None else cost_index(session)
    for level, scope_id in [("store", store_id), ("channel", channel_id), ("base", "base")]:
        versions = index.get((sku_id, level, scope_id), [])
        for version in sorted(versions, key=lambda v: v.effective_from, reverse=True):
            if version.effective_from <= paid_at and (
                version.effective_to is None or paid_at < version.effective_to
            ):
                return version
    return None


def apply_snapshots(session, line_ids=None, only_missing=False):
    """Replace snapshots (never append costs). Caller controls exact historical scope."""
    stmt = select(OrderLine, Order).join(Order, Order.id == OrderLine.order_id)
    if line_ids is not None:
        stmt = stmt.where(OrderLine.id.in_(line_ids))
    if only_missing:
        stmt = stmt.where(OrderLine.accounting_status != "complete")
    versions = cost_index(session)
    mapping = {(m.store_id, m.platform_sku): m for m in session.scalars(select(ListingMapping))}
    changed = 0
    for line, order in session.execute(stmt):
        m = mapping.get((order.store_id, line.platform_sku))
        if m is not None:
            line.sku_id, line.factor_scaled = m.sku_id, m.factor_scaled
        line.standard_quantity_scaled = int(
            (Decimal(line.quantity_scaled) * line.factor_scaled / 10000).quantize(
                Decimal("1"), rounding=ROUND_HALF_UP
            )
        )
        version = (
            resolve_cost(session, line.sku_id, order.channel_id, order.store_id, order.paid_at, versions)
            if line.sku_id
            else None
        )
        line.accounting_status = (
            "missing_mapping"
            if not line.sku_id
            else "missing_fx"
            if order.fx_rate_scaled is None
            else "missing_cost"
            if not version
            else "complete"
        )
        if version:
            line.unit_cost_scaled = version.unit_cost_scaled
            line.cost_minor = line_cost(version.unit_cost_scaled, line.standard_quantity_scaled)
            line.cost_version_id = version.id
            line.cost_source = version.level
        else:
            line.unit_cost_scaled = line.cost_minor = line.cost_version_id = line.cost_source = None
        line.accounted_at = now()
        changed += 1
    session.flush()
    update_refund_reversals(session, line_ids)
    return changed


def update_refund_reversals(session, line_ids=None):
    stmt = select(OrderLine)
    if line_ids is not None:
        stmt = stmt.where(OrderLine.id.in_(line_ids))
    lines = {line.id: line for line in session.scalars(stmt)}
    normalize_refund_amounts(session, list(lines))
    reversed_so_far = defaultdict(int)
    recovered_so_far = defaultdict(int)
    refunds = session.scalars(
        select(RefundEvent)
        .where(RefundEvent.order_line_id.in_(lines))
        .order_by(RefundEvent.completed_at, RefundEvent.id)
    )
    for refund in refunds:
        line = lines[refund.order_line_id]
        if refund.status != "completed" or line.cost_minor is None or line.unit_cost_scaled is None:
            refund.cost_reversal_minor = 0
            continue
        recovered_so_far[line.id] += refund.recoverable_quantity_scaled
        cumulative_cost = min(line.cost_minor, line_cost(line.unit_cost_scaled, recovered_so_far[line.id]))
        refund.cost_reversal_minor = max(0, cumulative_cost - reversed_so_far[line.id])
        reversed_so_far[line.id] += refund.cost_reversal_minor


def allocate_expenses(session):
    """Rebuild complete source allocations, independent from any UI filter."""
    lines = list(session.scalars(select(OrderLine)))
    orders = {o.id: o for o in session.scalars(select(Order))}
    by_order, by_day = defaultdict(list), defaultdict(list)
    by_id = {line.id: line for line in lines}
    columns = {
        "platform": "platform_fee_minor",
        "packaging": "packaging_fee_minor",
        "logistics": "logistics_fee_minor",
        "advertising": "advertising_fee_minor",
    }
    for line in lines:
        for column in columns.values():
            setattr(line, column, 0)
        order = orders[line.order_id]
        if order.status in ("unpaid", "closed"):
            continue
        by_order[line.order_id].append(line)
        by_day[(order.store_id, order.business_date)].append(line)
    for expense in session.scalars(
        select(ExpenseEntry).where(ExpenseEntry.business_date <= "2026-09-28").order_by(ExpenseEntry.id)
    ):
        if expense.expense_type not in columns:
            raise BusinessError(f"未知费用科目 {expense.expense_type}")
        candidates = (
            [by_id[expense.order_line_id]]
            if expense.order_line_id
            else by_order[expense.order_id]
            if expense.order_id
            else by_day[(expense.store_id, expense.business_date)]
        )
        candidates = [
            line
            for line in candidates
            if orders[line.order_id].status not in ("unpaid", "closed")
            and orders[line.order_id].paid_at <= DEMO_AS_OF
        ]
        allocations = allocate_minor(
            expense.amount_minor, {line.id: line.revenue_minor for line in candidates}
        )
        expense.allocated = bool(allocations)
        for line_id, amount in allocations.items():
            line = by_id[line_id]
            column = columns[expense.expense_type]
            setattr(line, column, getattr(line, column) + amount)
    session.flush()


def repair_missing_fx(session, line_ids):
    """Explicit recovery only: fix original-currency revenue/refunds from dated FX."""
    changed = False
    rates = {(r.currency, r.business_date): r for r in session.scalars(select(FxRate))}
    candidates = list(session.execute(select(OrderLine, Order).join(Order).where(OrderLine.id.in_(line_ids))))
    missing_orders = {order.id for line, order in candidates if order.fx_rate_scaled is None}
    for line, order in candidates:
        if order.id not in missing_orders and line.accounting_status != "missing_fx":
            continue
        rate = rates.get((order.currency, order.fx_date))
        if rate is None:
            continue
        order.fx_rate_scaled = rate.rate_scaled
        line.revenue_minor = scaled(
            decimal_value(line.original_amount) * Decimal(rate.rate_scaled) / 100000000
        )
        for refund in session.scalars(select(RefundEvent).where(RefundEvent.order_line_id == line.id)):
            refund.amount_minor = scaled(
                decimal_value(refund.original_amount) * Decimal(rate.rate_scaled) / 100000000
            )
        changed = True
    session.flush()
    return changed


def normalize_refund_amounts(session, line_ids=None):
    """Convert cumulative completed refunds, assigning rounding remainder stably."""
    stmt = select(OrderLine, Order).join(Order)
    if line_ids is not None:
        stmt = stmt.where(OrderLine.id.in_(line_ids))
    sources = {line.id: (line, order) for line, order in session.execute(stmt)}
    cumulative_original = defaultdict(Decimal)
    cumulative_minor = defaultdict(int)
    refunds = session.scalars(
        select(RefundEvent)
        .where(RefundEvent.order_line_id.in_(sources), RefundEvent.status == "completed")
        .order_by(RefundEvent.completed_at, RefundEvent.id)
    )
    for refund in refunds:
        line, order = sources[refund.order_line_id]
        if not order.fx_rate_scaled:
            continue
        original = decimal_value(refund.original_amount)
        # CNY-only records without separate original-currency evidence retain
        # their explicit amount; CSV imports always supply original amounts.
        if original == 0 and refund.amount_minor != 0:
            continue
        cumulative_original[line.id] += original
        converted = min(
            line.revenue_minor,
            scaled(cumulative_original[line.id] * Decimal(order.fx_rate_scaled) / 100000000),
        )
        refund.amount_minor = max(0, converted - cumulative_minor[line.id])
        cumulative_minor[line.id] += refund.amount_minor
    session.flush()
