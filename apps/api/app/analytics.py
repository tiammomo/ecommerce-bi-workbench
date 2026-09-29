from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal, ROUND_HALF_UP

from sqlalchemy import case, distinct, func, or_, select

from .domain import DEMO_AS_OF, BusinessError, business_date, cost_index, money, ratio, unit_money
from .models import (
    Channel,
    ExpenseEntry,
    Order,
    OrderLine,
    Product,
    RefundEvent,
    SalesTarget,
    StandardSku,
    Store,
    WorkspaceState,
)

FEE_FIELDS = ["platform_fee", "packaging_fee", "logistics_fee", "advertising_fee"]


def parse_filters(params):
    result = dict(params)
    result["start"] = result.get("start") or "2026-08-30"
    result["end"] = result.get("end") or "2026-09-28"
    try:
        if date.fromisoformat(result["start"]) > date.fromisoformat(result["end"]):
            raise ValueError()
        if (date.fromisoformat(result["end"]) - date.fromisoformat(result["start"])).days > 3660:
            raise ValueError()
    except ValueError:
        raise BusinessError("请选择合法日期范围，开始日不能晚于结束日") from None
    for key in ["channel_ids", "store_ids", "sku_ids"]:
        value = result.get(key, [])
        result[key] = [v for v in value.split(",") if v] if isinstance(value, str) else value
    try:
        result["page"] = max(1, int(result.get("page", 1)))
        result["page_size"] = min(200, max(1, int(result.get("page_size", 50))))
    except (ValueError, TypeError):
        raise BusinessError("分页参数必须为正整数") from None
    return result


def line_query(filters, ignore_dates=False):
    refunds = (
        select(
            RefundEvent.order_line_id.label("line_id"),
            func.sum(RefundEvent.amount_minor).label("refund_minor"),
            func.sum(RefundEvent.cost_reversal_minor).label("reversal_minor"),
            func.count(RefundEvent.id).label("refund_count"),
        )
        .where(RefundEvent.status == "completed", RefundEvent.completed_at <= DEMO_AS_OF)
        .group_by(RefundEvent.order_line_id)
        .subquery()
    )
    q = (
        select(
            OrderLine.id.label("id"),
            Order.id.label("order_id"),
            Order.business_date.label("date"),
            Order.paid_at,
            Order.channel_id,
            Channel.name.label("channel_name"),
            Order.store_id,
            Store.name.label("store_name"),
            OrderLine.sku_id,
            StandardSku.product_id,
            StandardSku.spec,
            Product.name.label("name"),
            Product.category,
            OrderLine.platform_sku,
            OrderLine.quantity_scaled,
            OrderLine.standard_quantity_scaled,
            OrderLine.revenue_minor,
            OrderLine.cost_minor,
            OrderLine.unit_cost_scaled,
            OrderLine.cost_version_id,
            OrderLine.cost_source,
            OrderLine.accounting_status,
            Order.currency,
            OrderLine.original_amount,
            Order.fx_rate_scaled,
            Order.fx_date,
            OrderLine.platform_fee_minor,
            OrderLine.packaging_fee_minor,
            OrderLine.logistics_fee_minor,
            OrderLine.advertising_fee_minor,
            func.coalesce(refunds.c.refund_minor, 0).label("refund_minor"),
            func.coalesce(refunds.c.reversal_minor, 0).label("reversal_minor"),
            func.coalesce(refunds.c.refund_count, 0).label("refund_count"),
        )
        .select_from(OrderLine)
        .join(Order)
        .join(Store, Order.store_id == Store.id)
        .join(Channel, Order.channel_id == Channel.id)
        .outerjoin(StandardSku, OrderLine.sku_id == StandardSku.id)
        .outerjoin(Product)
        .outerjoin(refunds, refunds.c.line_id == OrderLine.id)
    )
    q = q.where(Order.status.not_in(["unpaid", "closed"]), Order.paid_at <= DEMO_AS_OF)
    if filters.get("_line_ids") is not None:
        q = q.where(OrderLine.id.in_(filters["_line_ids"]))
    if not ignore_dates:
        q = q.where(Order.business_date >= filters["start"], Order.business_date <= filters["end"])
    for key, col in [
        ("channel_ids", Order.channel_id),
        ("store_ids", Order.store_id),
        ("sku_ids", OrderLine.sku_id),
    ]:
        if filters.get(key):
            if key == "sku_ids" and "unmapped" in filters[key]:
                q = q.where(or_(col.in_(filters[key]), col.is_(None)))
            else:
                q = q.where(col.in_(filters[key]))
    if filters.get("platform_sku"):
        q = q.where(OrderLine.platform_sku == filters["platform_sku"])
    if filters.get("line_id"):
        q = q.where(OrderLine.id == filters["line_id"])
    if filters.get("order_id"):
        q = q.where(Order.id == filters["order_id"])
    if filters.get("category"):
        q = q.where(Product.category == filters["category"])
    if filters.get("search"):
        term = "%" + filters["search"] + "%"
        q = q.where(
            or_(
                Product.name.ilike(term),
                OrderLine.sku_id.ilike(term),
                OrderLine.platform_sku.ilike(term),
                Store.name.ilike(term),
                Order.id.ilike(term),
            )
        )
    return q


def grouped(session, filters, group=None):
    line = line_query(filters).subquery()
    known = line.c.accounting_status == "complete"
    cols = [
        func.coalesce(func.sum(line.c.revenue_minor), 0).label("sales"),
        func.coalesce(func.sum(line.c.refund_minor), 0).label("refunds"),
        func.coalesce(func.sum(case((known, line.c.revenue_minor - line.c.refund_minor), else_=0)), 0).label(
            "known_revenue"
        ),
        func.coalesce(func.sum(case((known, line.c.revenue_minor), else_=0)), 0).label("known_sales"),
        func.coalesce(func.sum(case((known, line.c.refund_minor), else_=0)), 0).label("known_refunds"),
        func.coalesce(func.sum(case((known, line.c.cost_minor - line.c.reversal_minor), else_=0)), 0).label(
            "cost"
        ),
        func.count(distinct(line.c.order_id)).label("orders"),
        func.count().label("lines"),
        func.count(distinct(case((line.c.refund_count > 0, line.c.order_id)))).label("refund_orders"),
        func.coalesce(func.sum(case((known, 1), else_=0)), 0).label("known_lines"),
        func.coalesce(func.sum(line.c.standard_quantity_scaled), 0).label("units_scaled"),
        func.coalesce(func.sum(line.c.quantity_scaled), 0).label("platform_units_scaled"),
        func.coalesce(func.sum(case((known, line.c.cost_minor), else_=0)), 0).label("original_known_cost"),
        func.coalesce(func.sum(case((known, line.c.standard_quantity_scaled), else_=0)), 0).label(
            "known_units_scaled"
        ),
        func.count(distinct(line.c.store_id)).label("store_count"),
        func.count(distinct(line.c.channel_id)).label("channel_count"),
        func.coalesce(func.sum(case((line.c.accounting_status == "missing_fx", 1), else_=0)), 0).label(
            "missing_fx_lines"
        ),
    ]
    for fee in FEE_FIELDS:
        cols.append(func.coalesce(func.sum(case((known, line.c[fee + "_minor"]), else_=0)), 0).label(fee))
    group_cols = []
    if group == "channel":
        group_cols = [line.c.channel_id.label("id"), line.c.channel_name.label("name"), line.c.channel_id]
    elif group == "store":
        group_cols = [
            line.c.store_id.label("id"),
            line.c.store_name.label("name"),
            line.c.channel_id,
            line.c.store_id,
        ]
    elif group == "product":
        group_cols = [
            func.coalesce(line.c.product_id, "unmapped").label("id"),
            func.coalesce(line.c.name, "待关联商品").label("name"),
        ]
    elif group in ("sku", "listing"):
        group_cols = [
            func.coalesce(line.c.sku_id, "unmapped").label("id"),
            func.coalesce(line.c.name, "待关联商品").label("name"),
            line.c.spec,
            line.c.sku_id,
        ]
        if group == "listing":
            group_cols[0] = (line.c.store_id + ":" + line.c.platform_sku).label("id")
            group_cols += [line.c.store_id, line.c.channel_id, line.c.platform_sku]
    elif group in ("day", "week"):
        bucket = func.date(line.c.date, "weekday 0", "-6 days") if group == "week" else line.c.date
        group_cols = [bucket.label("id"), bucket.label("name"), bucket.label("date")]
    q = select(*group_cols, *cols).select_from(line)
    if group_cols:
        q = q.group_by(*group_cols)
    raw = [dict(row) for row in session.execute(q).mappings()]
    # Expenses without distributable sales remain independent deductions in the owning store/day.
    unallocated = (
        select(ExpenseEntry, Store.channel_id)
        .join(Store)
        .where(
            ~ExpenseEntry.allocated,
            ExpenseEntry.business_date >= filters["start"],
            ExpenseEntry.business_date <= filters["end"],
            ExpenseEntry.business_date <= "2026-09-28",
        )
    )
    if filters.get("channel_ids"):
        unallocated = unallocated.where(Store.channel_id.in_(filters["channel_ids"]))
    if filters.get("store_ids"):
        unallocated = unallocated.where(ExpenseEntry.store_id.in_(filters["store_ids"]))
    if filters.get("_expense_ids") is not None:
        unallocated = unallocated.where(ExpenseEntry.id.in_(filters["_expense_ids"]))
    expenses = list(session.execute(unallocated))
    product_filtered = bool(filters.get("sku_ids") or filters.get("category") or filters.get("search"))

    def empty(identifier, name):
        return {
            **{
                k: 0
                for k in [
                    "sales",
                    "refunds",
                    "known_revenue",
                    "known_sales",
                    "known_refunds",
                    "cost",
                    "orders",
                    "lines",
                    "refund_orders",
                    "known_lines",
                    "units_scaled",
                    "platform_units_scaled",
                    "original_known_cost",
                    "known_units_scaled",
                    "store_count",
                    "channel_count",
                    "missing_fx_lines",
                    *FEE_FIELDS,
                ]
            },
            "id": identifier,
            "name": name,
        }

    row_map = {r.get("id"): r for r in raw}
    for expense, channel_id in expenses:
        if product_filtered:
            continue
        identifier = (
            channel_id
            if group == "channel"
            else expense.store_id
            if group == "store"
            else (
                date.fromisoformat(expense.business_date)
                - timedelta(days=date.fromisoformat(expense.business_date).weekday())
            ).isoformat()
            if group == "week"
            else expense.business_date
            if group == "day"
            else "unallocated"
            if group
            else None
        )
        row = row_map.get(identifier)
        if row is None:
            name = (
                session.get(Channel, channel_id).name
                if group == "channel"
                else session.get(Store, expense.store_id).name
                if group == "store"
                else identifier
                if group in ("day", "week")
                else "未分摊费用"
            )
            row = empty(identifier, name)
            if group == "store":
                row.update(store_id=expense.store_id, channel_id=channel_id)
            if group == "channel":
                row.update(channel_id=channel_id)
            if group in ("day", "week"):
                row["date"] = identifier
            row_map[identifier] = row
            raw.append(row)
        row[expense.expense_type + "_fee"] = row.get(expense.expense_type + "_fee", 0) + expense.amount_minor
        row["unallocated_fees"] = row.get("unallocated_fees", 0) + expense.amount_minor
    for row in raw:
        row["excluded_unallocated_fees"] = sum(e.amount_minor for e, _ in expenses) if product_filtered else 0
    return [metrics(row) for row in raw]


def metrics(row):
    raw = dict(row)
    sales, refunds = raw["sales"], raw["refunds"]
    raw["revenue"] = sales - refunds
    raw["unknown_revenue"] = raw["revenue"] - raw["known_revenue"]
    raw["gross_profit"] = raw["known_revenue"] - raw["cost"]
    raw["profit"] = raw["gross_profit"] - sum(raw[fee] for fee in FEE_FIELDS)
    raw["profit_margin"] = ratio(raw["profit"], raw["known_revenue"])
    raw["gross_margin"] = ratio(raw["gross_profit"], raw["known_revenue"])
    raw["refund_rate"] = ratio(refunds, sales)
    raw["refund_order_rate"] = ratio(raw["refund_orders"], raw["orders"])
    raw["coverage"] = ratio(raw["known_lines"], raw["lines"]) or "1.00000000"
    raw["aov"] = (
        money(int((Decimal(sales) / raw["orders"]).quantize(Decimal("1"), rounding=ROUND_HALF_UP)))
        if raw["orders"]
        else None
    )
    raw["avg_price"] = (
        f"{Decimal(sales) * 100 / raw['units_scaled']:.4f}" if raw["units_scaled"] > 0 else None
    )
    raw["weighted_unit_cost"] = (
        f"{Decimal(raw.pop('original_known_cost', 0)) * 100 / raw['known_units_scaled']:.4f}"
        if raw.get("known_units_scaled", 0) > 0
        else None
    )
    raw.pop("known_units_scaled", None)
    raw["sales_complete"] = not raw.get("missing_fx_lines", 0)
    raw["units"] = float(Decimal(raw.pop("units_scaled")) / 10000)
    raw["platform_units"] = float(Decimal(raw.pop("platform_units_scaled")) / 10000)
    raw.setdefault("unallocated_fees", 0)
    raw["advertising_rate"] = ratio(raw["advertising_fee"], raw["known_revenue"])
    raw["logistics_rate"] = ratio(raw["logistics_fee"], raw["known_revenue"])
    for key in [
        "sales",
        "revenue",
        "refunds",
        "cost",
        "gross_profit",
        "profit",
        "unknown_revenue",
        "known_revenue",
        "known_sales",
        "known_refunds",
        "unallocated_fees",
        "excluded_unallocated_fees",
        *FEE_FIELDS,
    ]:
        raw[key] = money(raw.get(key, 0))
    raw["accounting_label"] = "已核算经营贡献利润" if raw["known_lines"] < raw["lines"] else "经营贡献利润"
    return raw


def apply_status(rows, status):
    if status == "negative":
        return [r for r in rows if Decimal(r["profit"]) < 0]
    if status == "low_margin":
        return [
            r for r in rows if r["profit_margin"] is not None and Decimal(r["profit_margin"]) < Decimal(".1")
        ]
    if status == "missing_cost":
        return [r for r in rows if Decimal(r["coverage"]) < 1]
    if status == "high_refund":
        return [r for r in rows if r["refund_rate"] is not None and Decimal(r["refund_rate"]) > Decimal(".1")]
    return rows


def sort_rows(rows, filters):
    key = filters.get("sort_by", "revenue")

    def value(row):
        v = row.get(key)
        if v is None:
            return (0, Decimal("-Infinity"))
        try:
            return (1, Decimal(str(v)))
        except Exception:
            return (2, str(v))

    return sorted(
        sorted(rows, key=lambda row: str(row.get("id", ""))),
        key=value,
        reverse=filters.get("sort_dir", "desc") != "asc",
    )


def targets(session, filters, month=None):
    month = month or "2026-09"
    start = month + "-01"
    next_month = (date.fromisoformat(start).replace(day=28) + timedelta(days=4)).replace(day=1)
    full = parse_filters(
        {
            "channel_ids": filters.get("channel_ids", []),
            "store_ids": filters.get("store_ids", []),
            "start": start,
            "end": (next_month - timedelta(days=1)).isoformat(),
        }
    )
    actual = {r["id"]: r for r in grouped(session, full, "store")}
    stmt = select(SalesTarget, Store).join(Store).where(SalesTarget.month == month)
    if filters.get("channel_ids"):
        stmt = stmt.where(Store.channel_id.in_(filters["channel_ids"]))
    if filters.get("store_ids"):
        stmt = stmt.where(Store.id.in_(filters["store_ids"]))
    return [
        {
            "store_id": s.id,
            "name": s.name,
            "month": t.month,
            "actual_start": start,
            "actual_end": min(full["end"], "2026-09-28"),
            "scope_label": "整店月度目标（仅跟随渠道与店铺）",
            "target": money(t.amount_minor),
            "actual": actual.get(s.id, {}).get("revenue", "0.00"),
            "rate": ratio(Decimal(actual.get(s.id, {}).get("revenue", "0.00")) * 100, t.amount_minor),
        }
        for t, s in session.execute(stmt)
    ]


def expand_status(session, filters):
    if filters.get("status") and not filters.get("_status_expanded"):
        matched = apply_status(grouped(session, filters, "sku"), filters["status"])
        sku_ids = [r["id"] for r in matched if r["id"] != "unallocated"]
        return dict(filters, sku_ids=sku_ids or ["__no_matching_sku__"], _status_expanded=True)
    return filters


def trend_rows(session, filters):
    grain = filters.get("trend_grain", "day")
    if grain not in ("day", "week"):
        raise BusinessError("趋势粒度必须为 day 或 week")
    rows = grouped(session, filters, grain)
    for row in rows:
        bucket_start = row["date"]
        bucket_end = (
            date.fromisoformat(bucket_start) + timedelta(days=6 if grain == "week" else 0)
        ).isoformat()
        row["date"] = max(bucket_start, filters["start"])
        row["end_date"] = min(bucket_end, filters["end"], "2026-09-28")
        row["grain"] = grain
    return sorted(rows, key=lambda row: row["date"])


def comparison_fields(current, previous):
    prior_revenue = Decimal(previous.get("revenue", "0.00"))
    prior_profit = Decimal(previous.get("profit", "0.00"))
    profit = Decimal(current["profit"])
    return {
        "revenue_growth": ratio(Decimal(current["revenue"]) - prior_revenue, prior_revenue),
        "profit_growth": ratio(profit - prior_profit, prior_profit),
        "profit_change": f"{profit - prior_profit:.2f}",
        "profit_change_label": "由亏转盈"
        if prior_profit < 0 <= profit
        else "由盈转亏"
        if prior_profit >= 0 > profit
        else "无可比基数"
        if prior_profit <= 0
        else None,
        "previous_revenue": f"{prior_revenue:.2f}",
        "previous_profit": f"{prior_profit:.2f}",
    }


def analytics(session, filters):
    group = filters.get("group_by", "channel")
    if group not in ("channel", "store", "sku", "product", "listing", "day"):
        raise BusinessError("不支持的分组维度")
    filters = expand_status(session, filters)
    summary = grouped(session, filters)[0]
    days = (date.fromisoformat(filters["end"]) - date.fromisoformat(filters["start"])).days + 1
    previous_filters = dict(
        filters,
        end=(date.fromisoformat(filters["start"]) - timedelta(days=1)).isoformat(),
        start=(date.fromisoformat(filters["start"]) - timedelta(days=days)).isoformat(),
    )
    previous = grouped(session, previous_filters)[0]
    rows = sort_rows(grouped(session, filters, group), filters)
    trend = trend_rows(session, filters)
    warnings = []
    if summary.get("missing_fx_lines", 0):
        warnings.append(
            {
                "title": f"{summary['missing_fx_lines']} 条订单行缺失汇率",
                "description": "其原币金额已保留；人民币收入汇总尚不完整，请先补全汇率并显式重算。",
                "severity": "warning",
                "target": "/reports",
                "filters": {},
            }
        )
    if Decimal(summary["coverage"]) < 1:
        warnings.append(
            {
                "title": f"{summary['lines'] - summary['known_lines']} 条订单行待核算",
                "description": f"未核算净销售收入 ¥{summary['unknown_revenue']}，请补全成本或商品映射。",
                "severity": "warning",
                "target": "/costs",
                "filters": {"status": "missing_cost"},
            }
        )
    sku_rows = grouped(session, filters, "sku") if group not in ("sku", "product") else rows
    negatives = [r for r in sku_rows if Decimal(r["profit"]) < 0 and r["id"] != "unallocated"]
    if negatives:
        worst = min(negatives, key=lambda r: Decimal(r["profit"]))
        warnings.append(
            {
                "title": f"{len(negatives)} 款商品出现负贡献利润",
                "description": f"{worst['name']} 贡献利润 ¥{worst['profit']}，建议检查成本与费用。",
                "severity": "danger",
                "target": "/products",
                "filters": {"status": "negative"},
            }
        )
    refund_rows = [r for r in sku_rows if r.get("refund_rate") and Decimal(r["refund_rate"]) > Decimal(".12")]
    if refund_rows:
        warnings.append(
            {
                "title": f"{len(refund_rows)} 款商品退款金额率偏高",
                "description": "查看退款原因与可回收商品成本，定位利润影响。",
                "severity": "warning",
                "target": "/refunds",
                "filters": {"status": "high_refund"},
            }
        )
    if Decimal(summary["unallocated_fees"]) != 0:
        warnings.append(
            {
                "title": "存在未分摊经营费用",
                "description": f"¥{summary['unallocated_fees']} 已计入整体贡献利润，未强制分摊至商品。",
                "severity": "info",
                "target": "/profit",
                "filters": {},
            }
        )
    current_stores = grouped(session, filters, "store")
    prior_stores = {row["id"]: row for row in grouped(session, previous_filters, "store")}
    for row in current_stores:
        row.update(comparison_fields(row, prior_stores.get(row["id"], {})))
        prior = prior_stores.get(row["id"])
        if (
            prior
            and Decimal(row["revenue"]) > Decimal(prior["revenue"]) > 0
            and Decimal(row["profit"]) < Decimal(prior["profit"])
        ):
            warnings.insert(
                0,
                {
                    "title": row["name"] + "增收但贡献利润下降",
                    "description": f"净销售收入 ¥{prior['revenue']} → ¥{row['revenue']}；贡献利润 ¥{prior['profit']} → ¥{row['profit']}，查看费用变化。",
                    "severity": "danger",
                    "target": "/stores",
                    "filters": {"store_ids": row["id"], "channel_ids": row.get("channel_id", "")},
                },
            )
    relevant_skus = {row["id"] for row in sku_rows}
    cost_rises = []
    for (sku_id, level, scope_id), versions in cost_index(session).items():
        if sku_id not in relevant_skus:
            continue
        if level == "channel" and filters.get("channel_ids") and scope_id not in filters["channel_ids"]:
            continue
        if level == "store" and filters.get("store_ids") and scope_id not in filters["store_ids"]:
            continue
        ordered = sorted(versions, key=lambda value: value.effective_from)
        for previous_version, version in zip(ordered, ordered[1:]):
            if (
                filters["start"] <= business_date(version.effective_from) <= filters["end"]
                and previous_version.unit_cost_scaled > 0
                and Decimal(version.unit_cost_scaled) / previous_version.unit_cost_scaled > Decimal("1.1")
            ):
                cost_rises.append((sku_id, version, previous_version))
    if cost_rises:
        sku_id, version, prior_version = cost_rises[0]
        warnings.append(
            {
                "title": f"{len(cost_rises)} 项单位成本上涨超过 10%",
                "description": f"{sku_id} 单位成本 ¥{unit_money(prior_version.unit_cost_scaled)} → ¥{unit_money(version.unit_cost_scaled)}，查看历史版本与适用范围。",
                "severity": "warning",
                "target": "/costs",
                "filters": {"sku_ids": sku_id},
            }
        )
    if group == "store":
        for row in rows:
            row.update(comparison_fields(row, prior_stores.get(row["id"], {})))
    channel_rows = grouped(session, filters, "channel")
    channel_trends = [
        {
            "id": row["id"],
            "name": row["name"],
            "trend": trend_rows(session, dict(filters, channel_ids=[row["id"]])),
        }
        for row in channel_rows
    ]
    growth = ratio(Decimal(summary["revenue"]) - Decimal(previous["revenue"]), Decimal(previous["revenue"]))
    growth_text = (
        ("较上期增长 " if Decimal(growth) >= 0 else "较上期下降 ") + f"{abs(Decimal(growth)) * 100:.1f}%"
        if growth is not None
        else "上期无可比基数"
    )
    summary["narrative"] = (
        f"净销售收入 ¥{Decimal(summary['revenue']):,.2f}，{growth_text}；{summary['accounting_label']} ¥{Decimal(summary['profit']):,.2f}，核算覆盖率 {Decimal(summary['coverage']) * 100:.1f}%。"
        + (" 关注：" + warnings[0]["title"] + "。" if warnings else "")
    )
    state = session.get(WorkspaceState, "demo")
    offset = (filters["page"] - 1) * filters["page_size"]
    labels = {
        "platform_fee": "平台费用",
        "packaging_fee": "包装费用",
        "logistics_fee": "物流费用",
        "advertising_fee": "广告推广费用",
    }
    bridge = [
        {
            "name": "已核算支付收入变化",
            "amount": str(Decimal(summary["known_sales"]) - Decimal(previous["known_sales"])),
        },
        {
            "name": "已核算退款变化",
            "amount": str(Decimal(previous["known_refunds"]) - Decimal(summary["known_refunds"])),
        },
        {"name": "商品成本变化", "amount": str(Decimal(previous["cost"]) - Decimal(summary["cost"]))},
    ]
    bridge.extend(
        {"name": labels[k] + "变化", "amount": str(Decimal(previous[k]) - Decimal(summary[k]))}
        for k in FEE_FIELDS
    )
    waterfall = [
        {"name": "已核算支付收入", "amount": summary["known_sales"], "kind": "total"},
        {"name": "商品退款", "amount": str(-Decimal(summary["known_refunds"])), "kind": "delta"},
        {"name": "已核算净销售收入", "amount": summary["known_revenue"], "kind": "total"},
        {"name": "有效商品成本", "amount": str(-Decimal(summary["cost"])), "kind": "delta"},
        {"name": "商品毛利", "amount": summary["gross_profit"], "kind": "total"},
    ]
    waterfall.extend(
        {"name": labels[k], "amount": str(-Decimal(summary[k])), "kind": "delta"} for k in FEE_FIELDS
    )
    waterfall.append({"name": summary["accounting_label"], "amount": summary["profit"], "kind": "total"})
    return {
        "waterfall": waterfall,
        "profit_bridge": bridge,
        "summary": summary,
        "previous": previous,
        "trend": trend,
        "trend_grain": filters.get("trend_grain", "day"),
        "channel_trends": channel_trends,
        "store_rankings": sort_rows(current_stores, {"sort_by": "revenue", "sort_dir": "desc"}),
        "rows": rows[offset : offset + filters["page_size"]],
        "total": len(rows),
        "page": filters["page"],
        "page_size": filters["page_size"],
        "anomalies": warnings,
        "breakdown": [{"name": labels[k], "amount": summary[k]} for k in FEE_FIELDS],
        "bridge": bridge,
        "refund_reasons": refund_list(session, dict(filters, page_size=5))["reasons"],
        "targets": targets(session, filters),
        "meta": {
            "revision": state.revision if state else 0,
            "as_of": "2026-09-28",
            "filters": filters,
            "comparison_available": previous_filters["start"] >= "2026-04-02",
        },
    }


def order_list(session, filters, all_rows=False):
    filters = expand_status(session, filters)
    line = line_query(filters).subquery()
    q = select(line)
    if filters.get("status") == "missing_cost":
        q = q.where(line.c.accounting_status != "complete")
    total = session.scalar(select(func.count()).select_from(q.subquery()))
    key_map = {
        "sales": line.c.revenue_minor,
        "revenue": line.c.revenue_minor - line.c.refund_minor,
        "date": line.c.date,
        "cost": line.c.cost_minor,
        "profit": line.c.revenue_minor
        - line.c.refund_minor
        - line.c.cost_minor
        + line.c.reversal_minor
        - line.c.platform_fee_minor
        - line.c.packaging_fee_minor
        - line.c.logistics_fee_minor
        - line.c.advertising_fee_minor,
    }
    key = key_map.get(filters.get("sort_by"), line.c.date)
    q = q.order_by(key.asc() if filters.get("sort_dir") == "asc" else key.desc(), line.c.id)
    if not all_rows:
        q = q.offset((filters["page"] - 1) * filters["page_size"]).limit(filters["page_size"])
    items = []
    for row in session.execute(q).mappings():
        r = dict(row)
        effective_cost = r["cost_minor"] - r["reversal_minor"] if r["cost_minor"] is not None else None
        gross = (
            r["revenue_minor"] - r["refund_minor"] - effective_cost
            if effective_cost is not None and r["accounting_status"] == "complete"
            else None
        )
        profit = gross - sum(r[k + "_minor"] for k in FEE_FIELDS) if gross is not None else None
        items.append(
            {
                **{
                    k: r[k]
                    for k in [
                        "id",
                        "order_id",
                        "date",
                        "channel_id",
                        "channel_name",
                        "store_id",
                        "store_name",
                        "sku_id",
                        "spec",
                        "currency",
                        "original_amount",
                        "cost_source",
                        "cost_version_id",
                        "fx_date",
                        "platform_sku",
                    ]
                },
                "name": r["name"] or "待关联商品",
                "quantity": float(Decimal(r["quantity_scaled"]) / 10000),
                "standard_quantity": float(Decimal(r["standard_quantity_scaled"]) / 10000),
                "fx_rate": str(Decimal(r["fx_rate_scaled"]) / 100000000) if r["fx_rate_scaled"] else None,
                "sales": money(r["revenue_minor"]),
                "refunds": money(r["refund_minor"]),
                "cost": money(effective_cost),
                "unit_cost": unit_money(r["unit_cost_scaled"]),
                "gross_profit": money(gross),
                "profit": money(profit),
                **{k: money(r[k + "_minor"]) for k in FEE_FIELDS},
                "status": r["accounting_status"],
            }
        )
    return {"items": items, "total": total, "page": filters["page"], "page_size": filters["page_size"]}


def refund_list(session, filters, all_rows=False):
    filters = expand_status(session, filters)
    event_basis = filters.get("date_basis") == "refund"
    line = line_query(filters, ignore_dates=event_basis).subquery()
    q = (
        select(
            RefundEvent,
            line.c.order_id,
            line.c.name,
            line.c.store_name,
            line.c.channel_id,
            line.c.date,
            line.c.revenue_minor,
            line.c.refund_minor,
            line.c.cost_minor,
            line.c.unit_cost_scaled,
            line.c.standard_quantity_scaled,
            line.c.cost_source,
            line.c.cost_version_id,
            line.c.reversal_minor,
            line.c.accounting_status,
        )
        .join(line, line.c.id == RefundEvent.order_line_id)
        .where(RefundEvent.status == "completed", RefundEvent.completed_at <= DEMO_AS_OF)
    )
    if event_basis:
        q = q.where(
            RefundEvent.business_date >= filters["start"], RefundEvent.business_date <= filters["end"]
        )
    if filters.get("refund_id"):
        q = q.where(RefundEvent.id == filters["refund_id"])
    if filters.get("reason"):
        q = q.where(RefundEvent.reason == filters["reason"])
    if filters.get("kind"):
        q = q.where(RefundEvent.refund_type == filters["kind"])
    sort_columns = {
        "name": line.c.name,
        "store_name": line.c.store_name,
        "date": RefundEvent.completed_at,
        "kind": RefundEvent.refund_type,
        "reason": RefundEvent.reason,
        "amount": RefundEvent.amount_minor,
        "cost_reversal": RefundEvent.cost_reversal_minor,
    }
    sort_column = sort_columns.get(filters.get("sort_by"), RefundEvent.completed_at)
    q = q.order_by(
        sort_column.asc() if filters.get("sort_dir") == "asc" else sort_column.desc(), RefundEvent.id
    )
    data = list(session.execute(q))
    reasons, types, by_day = defaultdict(int), defaultdict(int), defaultdict(int)
    for refund, *_ in data:
        reasons[refund.reason] += refund.amount_minor
        types[refund.refund_type] += refund.amount_minor
        by_day[refund.business_date] += refund.amount_minor
    amount = sum(r.amount_minor for r, *_ in data)
    total = len(data)
    if not all_rows:
        offset = (filters["page"] - 1) * filters["page_size"]
        data = data[offset : offset + filters["page_size"]]
    return {
        "items": [
            {
                "id": r.id,
                "date": r.business_date,
                "order_id": order_id,
                "line_id": r.order_line_id,
                "name": name or "待关联商品",
                "store_name": store_name,
                "channel_id": channel_id,
                "amount": money(r.amount_minor),
                "reason": r.reason,
                "kind": r.refund_type,
                "quantity": float(Decimal(r.quantity_scaled) / 10000),
                "recoverable_quantity": float(Decimal(r.recoverable_quantity_scaled) / 10000),
                "cost_reversal": money(r.cost_reversal_minor),
                "paid_date": evidence[0],
                "line_sales": money(evidence[1]),
                "line_refunds": money(evidence[2]),
                "remaining_refundable": money(max(0, evidence[1] - evidence[2])),
                "original_cost_snapshot": money(evidence[3]),
                "unit_cost_snapshot": unit_money(evidence[4]),
                "standard_quantity": float(Decimal(evidence[5]) / 10000),
                "cost_source": evidence[6],
                "cost_version_id": evidence[7],
                "total_cost_reversal": money(evidence[8]),
                "accounting_status": evidence[9],
            }
            for r, order_id, name, store_name, channel_id, *evidence in data
        ],
        "total": total,
        "summary": {
            "amount": money(amount),
            "by_day": [{"date": day, "amount": money(value)} for day, value in sorted(by_day.items())],
            "orders": len({order_id for _, order_id, *_ in session.execute(q)}),
            "rate": None
            if event_basis
            else ratio(amount, Decimal(grouped(session, filters)[0]["sales"]) * 100),
        },
        "reasons": [{"name": k, "value": money(v)} for k, v in reasons.items()],
        "types": [{"name": k, "value": money(v)} for k, v in types.items()],
    }


def expense_list(session, filters):
    """Trace full fee sources and their fixed allocations within the selected cohort."""
    from .domain import allocate_minor

    filters = expand_status(session, filters)
    source_search = str(filters.get("search", "")).strip().lower()
    selected = list(session.execute(line_query(dict(filters, search=""))).mappings())
    selected_ids = {row["id"] for row in selected}
    known_ids = {row["id"] for row in selected if row["accounting_status"] == "complete"}
    all_lines = session.execute(
        select(OrderLine.id, OrderLine.order_id, OrderLine.revenue_minor, Order.store_id, Order.business_date)
        .join(Order)
        .where(Order.status.not_in(["unpaid", "closed"]), Order.paid_at <= DEMO_AS_OF)
    ).all()
    by_order, by_day = defaultdict(dict), defaultdict(dict)
    by_id = {}
    for line_id, order_id, revenue, store_id, business_day in all_lines:
        by_id[line_id] = {line_id: revenue}
        by_order[order_id][line_id] = revenue
        by_day[(store_id, business_day)][line_id] = revenue
    query = select(ExpenseEntry, Store).join(Store).where(ExpenseEntry.business_date <= "2026-09-28")
    if filters.get("channel_ids"):
        query = query.where(Store.channel_id.in_(filters["channel_ids"]))
    if filters.get("store_ids"):
        query = query.where(Store.id.in_(filters["store_ids"]))
    if filters.get("kind"):
        query = query.where(ExpenseEntry.expense_type == filters["kind"])
    product_selected = bool(
        filters.get("sku_ids")
        or filters.get("category")
        or filters.get("platform_sku")
        or filters.get("line_id")
    )
    items = []
    excluded_unallocated = 0
    for expense, store in session.execute(query):
        if (
            source_search
            and source_search
            not in " ".join(
                [
                    expense.id,
                    expense.source,
                    store.name,
                    expense.expense_type,
                    {
                        "platform": "平台费用",
                        "packaging": "包装费用",
                        "logistics": "物流费用",
                        "advertising": "广告推广费用",
                    }.get(expense.expense_type, ""),
                ]
            ).lower()
        ):
            continue
        weights = (
            by_id.get(expense.order_line_id, {})
            if expense.order_line_id
            else by_order[expense.order_id]
            if expense.order_id
            else by_day[(expense.store_id, expense.business_date)]
        )
        selected_source = selected_ids.intersection(weights)
        if expense.allocated:
            if not selected_source:
                continue
            allocation = allocate_minor(expense.amount_minor, weights)
            selected_amount = sum(allocation.get(line_id, 0) for line_id in selected_source)
            accounted_amount = sum(
                allocation.get(line_id, 0) for line_id in selected_source.intersection(known_ids)
            )
        else:
            if not filters["start"] <= expense.business_date <= filters["end"]:
                continue
            if product_selected:
                excluded_unallocated += expense.amount_minor
                continue
            selected_amount = accounted_amount = expense.amount_minor
        items.append(
            {
                "id": expense.id,
                "date": expense.business_date,
                "store_id": store.id,
                "store_name": store.name,
                "channel_id": store.channel_id,
                "kind": expense.expense_type,
                "amount": money(expense.amount_minor),
                "source_amount": money(expense.amount_minor),
                "allocated_amount": money(accounted_amount),
                "selected_amount": money(selected_amount),
                "pending_amount": money(selected_amount - accounted_amount),
                "original_amount": expense.original_amount,
                "currency": expense.currency,
                "source": expense.source,
                "allocated": expense.allocated,
                "allocation_method": expense.allocation_method,
                "order_id": expense.order_id,
                "line_id": expense.order_line_id,
                "selected_lines": len(selected_source),
            }
        )
    items = sort_rows(
        items,
        dict(
            filters,
            sort_by=filters.get("sort_by")
            if filters.get("sort_by")
            in {"date", "kind", "source_amount", "allocated_amount", "selected_amount", "store_name"}
            else "date",
        ),
    )
    total = len(items)
    offset = (filters["page"] - 1) * filters["page_size"]
    summary = {
        "allocated_amount": f"{sum(Decimal(row['allocated_amount']) for row in items):.2f}",
        "selected_amount": f"{sum(Decimal(row['selected_amount']) for row in items):.2f}",
        "excluded_unallocated_fees": money(excluded_unallocated),
    }
    return {
        "items": items[offset : offset + filters["page_size"]],
        "total": total,
        "page": filters["page"],
        "page_size": filters["page_size"],
        "summary": summary,
        "basis": "支付订单归属；source_amount 为完整来源金额，allocated_amount 为当前已核算范围的固定分摊额，selected_amount 另含待核算订单行的分摊。未分摊费用按业务日期纳入。",
    }
