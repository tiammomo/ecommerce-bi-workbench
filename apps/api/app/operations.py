import hashlib
import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

from sqlalchemy import and_, func, or_, select

from .analytics import FEE_FIELDS, grouped, line_query, parse_filters, sort_rows
from .domain import (
    BusinessError,
    apply_snapshots,
    allocate_expenses,
    repair_missing_fx,
    canonical_time,
    cost_index,
    decimal_value,
    line_cost,
    money,
    now,
    ratio,
    resolve_cost,
    scaled,
    unit_money,
)
from .models import (
    ChangeLog,
    CostVersion,
    FxRate,
    ExpenseEntry,
    ListingMapping,
    OperationPreview,
    OperationRecord,
    Order,
    OrderLine,
    Product,
    RefundEvent,
    StandardSku,
    Store,
    WorkspaceState,
)


def uid(prefix):
    return prefix + "_" + uuid4().hex[:16]


def state(session):
    value = session.get(WorkspaceState, "demo")
    if not value:
        value = WorkspaceState(id="demo", dataset_version="", revision=0)
        session.add(value)
        session.flush()
    return value


def version_json(v):
    return {
        "id": v.id,
        "sku_id": v.sku_id,
        "scope": v.level,
        "scope_id": v.scope_id,
        "unit_cost": unit_money(v.unit_cost_scaled),
        "effective_from": v.effective_from,
        "effective_to": v.effective_to,
        "note": v.note,
        "created_at": v.created_at,
    }


def plan_cost_version(session, sku_id, scope, scope_id, unit_cost_scaled, effective_from, effective_to=None):
    if scope not in ("base", "channel", "store"):
        raise BusinessError("成本层级必须为基础、渠道或店铺")
    if not session.get(StandardSku, sku_id):
        raise BusinessError("标准 SKU 不存在")
    scope_id = "base" if scope == "base" else scope_id
    from .models import Channel

    if scope == "channel" and not session.get(Channel, scope_id):
        raise BusinessError("渠道不存在")
    if scope == "store" and not session.get(Store, scope_id):
        raise BusinessError("店铺不存在")
    existing = list(
        session.scalars(
            select(CostVersion)
            .where(CostVersion.sku_id == sku_id, CostVersion.level == scope, CostVersion.scope_id == scope_id)
            .order_by(CostVersion.effective_from)
        )
    )
    close = []
    if any(v.effective_from == effective_from for v in existing):
        raise BusinessError("该作用范围在相同生效时间已有成本版本，请更换生效时间")
    future = [v for v in existing if v.effective_from > effective_from]
    end = effective_to or (future[0].effective_from if future else None)
    if end and end <= effective_from:
        raise BusinessError("生效结束时间必须晚于开始时间")
    for v in existing:
        if v.effective_from < effective_from and (v.effective_to is None or v.effective_to > effective_from):
            close.append({"id": v.id, "old_end": v.effective_to, "new_end": effective_from})
        elif end and v.effective_from < end and v.effective_from > effective_from:
            raise BusinessError("新成本与已有成本生效区间重叠")
    return {
        "sku_id": sku_id,
        "scope": scope,
        "scope_id": scope_id,
        "unit_cost_scaled": unit_cost_scaled,
        "unit_cost": unit_money(unit_cost_scaled),
        "effective_from": effective_from,
        "effective_to": end,
        "close_previous": close,
    }


def insert_cost_versions(session, changes, note="", operation_id=None):
    results = []
    for change in changes:
        # Revalidate under the write lock. Never trust a browser-supplied plan.
        plan = plan_cost_version(
            session,
            change["sku_id"],
            change["scope"],
            change["scope_id"],
            change["unit_cost_scaled"],
            change["effective_from"],
            change.get("effective_to"),
        )
        for old in plan["close_previous"]:
            session.get(CostVersion, old["id"]).effective_to = old["new_end"]
        version = CostVersion(
            id=uid("cost"),
            sku_id=plan["sku_id"],
            level=plan["scope"],
            scope_id=plan["scope_id"],
            unit_cost_scaled=plan["unit_cost_scaled"],
            effective_from=plan["effective_from"],
            effective_to=plan["effective_to"],
            source="人工维护",
            note=note,
            created_at=now(),
        )
        session.add(version)
        session.add(
            ChangeLog(
                id=uid("log"),
                operation_type="cost",
                entity_id=version.id,
                before_json=json.dumps(plan["close_previous"]),
                after_json=json.dumps(version_json(version), ensure_ascii=False),
                note=note,
                created_at=now(),
                operation_id=operation_id,
            )
        )
        session.flush()
        results.append(version.id)
    return results


def build_cost_changes(session, payload):
    sku_ids = payload.get("sku_ids", [])
    if not sku_ids:
        raise BusinessError("请至少选择一个 SKU")
    if len(sku_ids) > 500:
        raise BusinessError("一次最多维护 500 个 SKU")
    scope = payload.get("scope", "base")
    scope_id = payload.get("scope_id") or "base"
    effective = canonical_time(payload.get("effective_from") or "2026-09-29")
    notes = payload.get("note", "").strip()
    if not notes:
        raise BusinessError("请填写成本变更说明")
    changes = []
    index = cost_index(session)
    for sku_id in sorted(set(sku_ids)):
        versions = index.get((sku_id, scope, scope_id), [])
        previous = next(
            (
                v
                for v in sorted(versions, key=lambda v: v.effective_from, reverse=True)
                if v.effective_from < effective and (v.effective_to is None or effective <= v.effective_to)
            ),
            None,
        )
        kind = payload.get("adjustment_type", "absolute")
        value = decimal_value(
            payload.get("unit_cost")
            if payload.get("unit_cost") is not None and kind == "absolute"
            else payload.get("adjustment_value", "0"),
            4,
        )
        if kind in ("amount", "percent"):
            if not previous:
                # Relative changes must have an explicit prior value at the selected scope.
                raise BusinessError(f"{sku_id} 在所选层级没有有效旧成本，请使用固定金额设置")
            previous_value = Decimal(previous.unit_cost_scaled) / 10000
            value = previous_value + value if kind == "amount" else previous_value * (1 + value / 100)
        elif kind != "absolute":
            raise BusinessError("未知调整方式")
        new_cost = scaled(value, 10000)
        if new_cost < 0:
            raise BusinessError("商品成本不能为负")
        if new_cost == 0 and not payload.get("allow_zero"):
            raise BusinessError("零成本需要明确确认业务原因")
        change = plan_cost_version(session, sku_id, scope, scope_id, new_cost, effective)
        change["previous_cost"] = unit_money(previous.unit_cost_scaled) if previous else None
        change["name"] = session.get(Product, session.get(StandardSku, sku_id).product_id).name
        changes.append(change)
    return changes


def recalc_candidates(session, payload):
    filters = parse_filters(payload)
    # Candidate selection includes the newly configured mapping without rewriting history.
    selected_skus = filters.get("sku_ids", [])
    stmt = line_query(dict(filters, sku_ids=[])).subquery()
    q = select(OrderLine.id).join(stmt, stmt.c.id == OrderLine.id)
    if selected_skus:
        q = q.outerjoin(
            ListingMapping,
            and_(
                ListingMapping.store_id == stmt.c.store_id,
                ListingMapping.platform_sku == OrderLine.platform_sku,
            ),
        )
        q = q.where(or_(OrderLine.sku_id.in_(selected_skus), ListingMapping.sku_id.in_(selected_skus)))
    if payload.get("only_missing", True):
        q = q.where(OrderLine.accounting_status != "complete")
    selected_ids = list(session.scalars(q))
    # An FX repair changes daily allocation weights. Include its complete store/day
    # source scope in the explicit preview rather than reallocating a selected SKU alone.
    scope = fx_recovery_scope(session, selected_ids)
    if scope:
        additional = session.scalars(
            select(OrderLine.id)
            .join(Order)
            .where(
                or_(*[and_(Order.store_id == store, Order.business_date == day) for store, day in scope]),
                Order.status.not_in(["unpaid", "closed"]),
            )
        )
        selected_ids = sorted(set(selected_ids) | set(additional))
    return selected_ids


def fx_recovery_scope(session, line_ids):
    if not line_ids:
        return set()
    return set(
        session.execute(
            select(Order.store_id, Order.business_date)
            .join(OrderLine)
            .join(FxRate, and_(FxRate.currency == Order.currency, FxRate.business_date == Order.fx_date))
            .where(
                OrderLine.id.in_(line_ids),
                or_(Order.fx_rate_scaled.is_(None), OrderLine.accounting_status == "missing_fx"),
            )
        )
    )


def run_recalculation(session, line_ids):
    repaired_fx = repair_missing_fx(session, line_ids)
    apply_snapshots(session, line_ids)
    if repaired_fx:
        allocate_expenses(session)
    return repaired_fx


def fx_difference(session, line_ids, scope):
    expense_ids = list(
        session.scalars(
            select(ExpenseEntry.id).where(
                or_(
                    *[
                        and_(ExpenseEntry.store_id == store, ExpenseEntry.business_date == day)
                        for store, day in scope
                    ]
                )
            )
        )
    )
    filters = {"start": "1900-01-01", "end": "2026-09-28", "_line_ids": line_ids, "_expense_ids": expense_ids}
    before = grouped(session, filters)[0]
    savepoint = session.begin_nested()
    try:
        run_recalculation(session, line_ids)
        after = grouped(session, filters)[0]
    finally:
        savepoint.rollback()
    return {
        "affected_orders": before["orders"],
        "affected_lines": len(line_ids),
        "old_profit": before["profit"],
        "new_profit": after["profit"],
        "profit_delta": f"{Decimal(after['profit']) - Decimal(before['profit']):.2f}",
        "old_margin": before["profit_margin"],
        "new_margin": after["profit_margin"],
        "old_coverage": before["coverage"],
        "new_coverage": after["coverage"],
        "old_missing_lines": before["lines"] - before["known_lines"],
        "new_missing_lines": after["lines"] - after["known_lines"],
        "note": "汇率补全同步恢复原币收入与退款，并重新分摊完整店铺/支付日费用；影响范围已包含该来源范围的订单行。",
        "allocation_scopes": [{"store_id": store, "date": day} for store, day in sorted(scope)],
    }


def difference(session, line_ids, unit_override=None):
    if not line_ids:
        return {
            "affected_orders": 0,
            "affected_lines": 0,
            "old_profit": "0.00",
            "new_profit": "0.00",
            "profit_delta": "0.00",
            "old_margin": None,
            "new_margin": None,
            "old_coverage": None,
            "new_coverage": None,
            "old_missing_lines": 0,
            "new_missing_lines": 0,
        }
    fx_scope = fx_recovery_scope(session, line_ids)
    if fx_scope and unit_override is None:
        return fx_difference(session, line_ids, fx_scope)
    index = cost_index(session)
    mappings = {(m.store_id, m.platform_sku): m for m in session.scalars(select(ListingMapping))}
    refunds = {}
    for r in session.scalars(
        select(RefundEvent).where(
            RefundEvent.order_line_id.in_(line_ids),
            RefundEvent.status == "completed",
            RefundEvent.completed_at <= "2026-09-28T15:59:59.000000Z",
        )
    ):
        row = refunds.setdefault(r.order_line_id, [0, 0, 0])
        row[0] += r.amount_minor
        row[1] += r.cost_reversal_minor
        row[2] += r.recoverable_quantity_scaled
    old_profit = new_profit = old_revenue = new_revenue = 0
    old_complete = new_complete = 0
    order_ids = set()
    for line, order in session.execute(
        select(OrderLine, Order).join(Order).where(OrderLine.id.in_(line_ids))
    ):
        order_ids.add(order.id)
        refund, old_reversal, recoverable = refunds.get(line.id, [0, 0, 0])
        net = line.revenue_minor - refund
        fees = sum(getattr(line, f + "_minor") for f in FEE_FIELDS)
        if line.accounting_status == "complete" and line.cost_minor is not None:
            old_complete += 1
            old_profit += net - line.cost_minor + old_reversal - fees
            old_revenue += net
        m = mappings.get((order.store_id, line.platform_sku))
        sku_id = m.sku_id if m else line.sku_id
        quantity = int(Decimal(line.quantity_scaled) * (m.factor_scaled if m else line.factor_scaled) / 10000)
        version = resolve_cost(session, sku_id, order.channel_id, order.store_id, order.paid_at, index)
        unit = unit_override if unit_override is not None else version.unit_cost_scaled if version else None
        if unit is not None and sku_id and order.fx_rate_scaled:
            new_complete += 1
            cost = line_cost(unit, quantity)
            reversal = min(cost, line_cost(unit, recoverable))
            new_profit += net - cost + reversal - fees
            new_revenue += net
    return {
        "affected_orders": len(order_ids),
        "affected_lines": len(line_ids),
        "old_profit": money(old_profit),
        "new_profit": money(new_profit),
        "profit_delta": money(new_profit - old_profit),
        "old_margin": ratio(old_profit, old_revenue),
        "new_margin": ratio(new_profit, new_revenue),
        "old_coverage": ratio(old_complete, len(line_ids)),
        "new_coverage": ratio(new_complete, len(line_ids)),
        "old_missing_lines": len(line_ids) - old_complete,
        "new_missing_lines": len(line_ids) - new_complete,
    }


def make_preview(session, operation_type, payload):
    changes = []
    if operation_type == "cost":
        changes = build_cost_changes(session, payload)
        summary = {
            "affected_orders": 0,
            "affected_lines": 0,
            "old_profit": "0.00",
            "new_profit": "0.00",
            "profit_delta": "0.00",
            "note": "仅新增成本规则，已形成的历史订单快照保持不变；历史补全需单独重算。",
        }
    elif operation_type == "recalculation":
        ids = recalc_candidates(session, payload)
        summary = difference(session, ids)
        changes = [{"affected_lines": len(ids), "only_missing": payload.get("only_missing", True)}]
    elif operation_type == "mapping":
        mapping = session.get(ListingMapping, payload.get("mapping_id"))
        if not mapping or not session.get(StandardSku, payload.get("sku_id")):
            raise BusinessError("映射或标准 SKU 不存在")
        factor = scaled(payload.get("unit_factor", 1), 10000, 4)
        if factor <= 0:
            raise BusinessError("单位换算系数必须为正")
        changes = [
            {
                "mapping_id": mapping.id,
                "old_sku_id": mapping.sku_id,
                "sku_id": payload["sku_id"],
                "unit_factor": str(Decimal(factor) / 10000),
            }
        ]
        summary = {
            "affected_orders": 0,
            "profit_delta": "0.00",
            "note": "只更新映射规则，历史订单通过独立重算流程处理。",
        }
    else:
        raise BusinessError("未知操作类型")
    revision = state(session).revision
    preview = OperationPreview(
        id=uid("preview"),
        operation_type=operation_type,
        request_json=json.dumps(payload, sort_keys=True, ensure_ascii=False),
        summary_json=json.dumps({"changes": changes, "summary": summary}, ensure_ascii=False),
        revision=revision,
        expires_at=(datetime.now(timezone.utc) + timedelta(minutes=15)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        created_at=now(),
    )
    session.add(preview)
    session.flush()
    return {
        "preview_id": preview.id,
        "revision": revision,
        "expires_at": preview.expires_at,
        "changes": changes,
        "summary": summary,
    }


def commit_operation(session, preview_id, idempotency_key, expected_revision=None):
    if not idempotency_key or len(idempotency_key) > 200:
        raise BusinessError("请提供有效幂等标识")
    digest = hashlib.sha256(preview_id.encode()).hexdigest()
    existing = session.scalar(
        select(OperationRecord).where(OperationRecord.idempotency_key == idempotency_key)
    )
    if existing:
        if existing.request_digest != digest:
            raise BusinessError("幂等标识已用于其他请求", "idempotency_conflict", 409)
        return json.loads(existing.result_json)
    preview = session.get(OperationPreview, preview_id)
    if not preview:
        raise BusinessError("预览不存在", "not_found", 404)
    current = state(session)
    if (
        preview.expires_at < now()
        or preview.revision != current.revision
        or (expected_revision is not None and expected_revision != preview.revision)
    ):
        raise BusinessError("数据已变化或预览已过期，请重新预览", "stale_preview", 409)
    payload = json.loads(preview.request_json)
    plan = json.loads(preview.summary_json)
    operation_id = uid("op")
    if preview.operation_type == "cost":
        changes = build_cost_changes(session, payload)
        version_ids = insert_cost_versions(session, changes, payload["note"], operation_id)
        plan["summary"]["version_ids"] = version_ids
    elif preview.operation_type == "recalculation":
        ids = recalc_candidates(session, payload)
        summary = difference(session, ids)
        before = {
            line.id: {
                "revenue": line.revenue_minor,
                "fees": {key: getattr(line, key + "_minor") for key in FEE_FIELDS},
                "cost": line.cost_minor,
                "version": line.cost_version_id,
                "status": line.accounting_status,
            }
            for line in session.scalars(select(OrderLine).where(OrderLine.id.in_(ids)))
        }
        run_recalculation(session, ids)
        for line in session.scalars(select(OrderLine).where(OrderLine.id.in_(ids))):
            session.add(
                ChangeLog(
                    id=uid("log"),
                    operation_type="recalculation",
                    entity_id=line.id,
                    before_json=json.dumps(before[line.id]),
                    after_json=json.dumps(
                        {
                            "revenue": line.revenue_minor,
                            "fees": {key: getattr(line, key + "_minor") for key in FEE_FIELDS},
                            "cost": line.cost_minor,
                            "version": line.cost_version_id,
                            "status": line.accounting_status,
                        }
                    ),
                    note=payload.get("note", "显式重算历史"),
                    created_at=now(),
                    operation_id=operation_id,
                )
            )
        plan["summary"] = summary
    elif preview.operation_type == "mapping":
        mapping = session.get(ListingMapping, payload["mapping_id"])
        before = {"sku_id": mapping.sku_id, "factor_scaled": mapping.factor_scaled}
        mapping.sku_id, mapping.factor_scaled, mapping.status = (
            payload["sku_id"],
            scaled(payload["unit_factor"], 10000, 4),
            "mapped",
        )
        session.add(
            ChangeLog(
                id=uid("log"),
                operation_type="mapping",
                entity_id=mapping.id,
                before_json=json.dumps(before),
                after_json=json.dumps(payload),
                created_at=now(),
                note="映射修改不自动重写历史",
                operation_id=operation_id,
            )
        )
    current.revision += 1
    result = {"operation_id": operation_id, "revision": current.revision, "summary": plan["summary"]}
    session.add(
        OperationRecord(
            id=operation_id,
            idempotency_key=idempotency_key,
            request_digest=digest,
            operation_type=preview.operation_type,
            result_json=json.dumps(result),
            created_at=now(),
        )
    )
    session.flush()
    return result


def cost_list(session, filters):
    at = canonical_time(filters.get("effective_date") or "2026-09-28")
    query = select(StandardSku, Product).join(Product)
    if filters.get("sku_ids"):
        query = query.where(StandardSku.id.in_(filters["sku_ids"]))
    if filters.get("category"):
        query = query.where(Product.category == filters["category"])
    if filters.get("search"):
        from sqlalchemy import or_

        query = query.where(
            or_(Product.name.contains(filters["search"]), StandardSku.id.contains(filters["search"]))
        )
    stores = list(session.scalars(select(Store)))
    store_id = filters.get("store_ids", [None])[0] if filters.get("store_ids") else None
    channel_id = next((s.channel_id for s in stores if s.id == store_id), None) or (
        filters.get("channel_ids", [None])[0] if filters.get("channel_ids") else None
    )
    index = cost_index(session)
    sales = {r["id"]: r for r in grouped(session, filters, "sku")}
    items = []
    for sku, product in session.execute(query):
        version = resolve_cost(session, sku.id, channel_id, store_id, at, index)
        base = resolve_cost(session, sku.id, None, None, at, index)
        previous = None
        if version:
            candidates = [
                v
                for v in index.get((sku.id, version.level, version.scope_id), [])
                if v.effective_from < version.effective_from
            ]
            previous = max(candidates, key=lambda v: v.effective_from) if candidates else None
        performance = sales.get(sku.id, {})
        row = {
            "id": sku.id,
            "sku_id": sku.id,
            "name": product.name,
            "spec": sku.spec,
            "category": product.category,
            "channel_id": channel_id,
            "store_id": store_id,
            "base_cost": unit_money(base.unit_cost_scaled) if base else None,
            "unit_cost": unit_money(version.unit_cost_scaled) if version else None,
            "source": version.level if version else "missing",
            "version_id": version.id if version else None,
            "effective_from": version.effective_from if version else None,
            "effective_to": version.effective_to if version else None,
            "previous_cost": unit_money(previous.unit_cost_scaled) if previous else None,
            "change_rate": ratio(
                version.unit_cost_scaled - previous.unit_cost_scaled, previous.unit_cost_scaled
            )
            if previous and version
            else None,
            "profit": performance.get("profit", "0.00"),
            "profit_margin": performance.get("profit_margin"),
            "coverage": performance.get("coverage", "1.00000000"),
            "revenue": performance.get("revenue", "0.00"),
        }
        row["inheritance"] = [
            {
                "store_id": s.id,
                "store_name": s.name,
                "channel_id": s.channel_id,
                "unit_cost": unit_money(v.unit_cost_scaled)
                if (v := resolve_cost(session, sku.id, s.channel_id, s.id, at, index))
                else None,
                "source": v.level if v else "missing",
            }
            for s in stores
        ]
        items.append(row)
    summary = {
        "coverage": ratio(sum(r["unit_cost"] is not None for r in items), len(items)),
        "base_coverage": ratio(sum(r["base_cost"] is not None for r in items), len(items)),
        "sales_coverage": grouped(session, filters)[0]["coverage"],
        "missing_count": sum(r["unit_cost"] is None for r in items),
        "rising_count": sum(
            r["change_rate"] is not None and Decimal(r["change_rate"]) > Decimal(".1") for r in items
        ),
        "negative_count": sum(Decimal(r["profit"]) < 0 for r in items),
    }
    status = filters.get("status")
    if status == "missing_cost":
        items = [r for r in items if r["unit_cost"] is None or Decimal(r["coverage"]) < 1]
    elif status == "negative":
        items = [r for r in items if Decimal(r["profit"]) < 0]
    elif status == "low_margin":
        items = [
            r for r in items if r["profit_margin"] is not None and Decimal(r["profit_margin"]) < Decimal(".1")
        ]
    elif status in ("rising", "cost_increase"):
        items = [
            r for r in items if r["change_rate"] is not None and Decimal(r["change_rate"]) > Decimal(".1")
        ]
    items = sort_rows(items, filters)
    total = len(items)
    offset = (filters["page"] - 1) * filters["page_size"]
    return {
        "items": items[offset : offset + filters["page_size"]],
        "total": total,
        "page": filters["page"],
        "page_size": filters["page_size"],
        "summary": summary,
    }


def change_list(session, filters, all_rows=False):
    """Audit-time history; business sales-date filters intentionally do not apply."""
    after_sku = func.json_extract(ChangeLog.after_json, "$.sku_id")
    before_sku = func.json_extract(ChangeLog.before_json, "$.sku_id")
    sku_columns = [CostVersion.sku_id, OrderLine.sku_id, ListingMapping.sku_id, after_sku, before_sku]
    effective_sku = func.coalesce(*sku_columns).label("sku_id")
    q = (
        select(ChangeLog, effective_sku)
        .outerjoin(
            CostVersion, and_(ChangeLog.operation_type == "cost", CostVersion.id == ChangeLog.entity_id)
        )
        .outerjoin(
            OrderLine, and_(ChangeLog.operation_type == "recalculation", OrderLine.id == ChangeLog.entity_id)
        )
        .outerjoin(Order, Order.id == OrderLine.order_id)
        .outerjoin(
            ListingMapping,
            and_(ChangeLog.operation_type == "mapping", ListingMapping.id == ChangeLog.entity_id),
        )
    )
    if filters.get("sku_ids"):
        q = q.where(or_(*[column.in_(filters["sku_ids"]) for column in sku_columns]))
    if filters.get("channel_ids"):
        channels = filters["channel_ids"]
        stores = select(Store.id).where(Store.channel_id.in_(channels))
        q = q.where(
            or_(
                CostVersion.level == "base",
                and_(CostVersion.level == "channel", CostVersion.scope_id.in_(channels)),
                and_(CostVersion.level == "store", CostVersion.scope_id.in_(stores)),
                Order.channel_id.in_(channels),
                ListingMapping.store_id.in_(stores),
            )
        )
    if filters.get("store_ids"):
        stores = filters["store_ids"]
        channels = select(Store.channel_id).where(Store.id.in_(stores))
        q = q.where(
            or_(
                CostVersion.level == "base",
                and_(CostVersion.level == "channel", CostVersion.scope_id.in_(channels)),
                and_(CostVersion.level == "store", CostVersion.scope_id.in_(stores)),
                Order.store_id.in_(stores),
                ListingMapping.store_id.in_(stores),
            )
        )
    if filters.get("search"):
        term = "%" + filters["search"] + "%"
        q = q.where(
            or_(
                ChangeLog.entity_id.ilike(term),
                ChangeLog.note.ilike(term),
                *[column.ilike(term) for column in sku_columns],
            )
        )
    if filters.get("operation_type"):
        q = q.where(ChangeLog.operation_type == filters["operation_type"])
    total = session.scalar(select(func.count()).select_from(q.subquery()))
    sort_column = {
        "id": ChangeLog.id,
        "created_at": ChangeLog.created_at,
        "operation_type": ChangeLog.operation_type,
    }.get(filters.get("sort_by"), ChangeLog.created_at)
    q = q.order_by(
        sort_column.asc() if filters.get("sort_dir") == "asc" else sort_column.desc(), ChangeLog.id
    )
    if not all_rows:
        q = q.offset((filters["page"] - 1) * filters["page_size"]).limit(filters["page_size"])
    return {
        "items": [
            {
                "id": entry.id,
                "operation_type": entry.operation_type,
                "entity_id": entry.entity_id,
                "sku_id": sku_id,
                "before": json.loads(entry.before_json),
                "after": json.loads(entry.after_json),
                "note": entry.note,
                "created_at": entry.created_at,
                "operation_id": entry.operation_id,
            }
            for entry, sku_id in session.execute(q)
        ],
        "total": total,
        "page": filters["page"],
        "page_size": filters["page_size"],
        "date_basis": "实际审计时间；不受销售期间筛选影响",
    }
