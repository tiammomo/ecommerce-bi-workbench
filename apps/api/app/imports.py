"""CSV staging, validation and atomic import. Source records are never overwritten."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import re
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlalchemy import insert, select

from . import models as m
from .csv_spec import (
    LABELS,
    MAX_BATCH_ROWS,
    MAX_FILE_BYTES,
    SPECS,
    TEMPLATE_VERSION,
    UNIQUE_KEYS,
    decimal_value,
    dump_csv,
    safe_display_csv,
    scaled,
)
from .db import SessionLocal, write_session
from .domain import (
    BusinessError,
    allocate_expenses,
    apply_snapshots,
    business_date,
    canonical_time,
    now,
    update_refund_reversals,
)

router = APIRouter(prefix="/api/v1/imports", tags=["CSV 数据交换"])
MODELS = {
    "channels": m.Channel,
    "stores": m.Store,
    "products": m.Product,
    "skus": m.StandardSku,
    "mappings": m.ListingMapping,
    "fx_rates": m.FxRate,
    "costs": m.CostVersion,
    "orders": m.Order,
    "order_lines": m.OrderLine,
    "refunds": m.RefundEvent,
    "expenses": m.ExpenseEntry,
    "targets": m.SalesTarget,
}


def packed(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def digest(value):
    return hashlib.sha256(packed(value).encode()).hexdigest()


def workspace(session):
    state = session.get(m.WorkspaceState, "demo")
    if state is None:
        state = m.WorkspaceState(id="demo", revision=0, dataset_version="")
        session.add(state)
        session.flush()
    return state


def normalize_row(template, raw):
    output = {}
    errors = []
    for definition in SPECS[template]:
        value = (raw.get(definition.name) or "").strip()
        try:
            if not value:
                if definition.required:
                    raise ValueError("必填字段不能为空")
                output[definition.name] = ""
                continue
            if len(value) > 4000:
                raise ValueError("字段长度不能超过4000字符")
            if definition.kind in {"money", "signed_money", "cost", "rate", "quantity"}:
                places = {"money": 2, "signed_money": 2, "cost": 4, "rate": 8, "quantity": 4}[definition.kind]
                number = decimal_value(value, places, allow_negative=definition.kind == "signed_money")
                if definition.kind == "rate" and number <= 0:
                    raise ValueError("汇率必须大于0")
                scaled(number, 10**places)
                value = format(number, f".{places}f")
            elif definition.kind == "datetime":
                if "T" not in value or datetime.fromisoformat(value.replace("Z", "+00:00")).tzinfo is None:
                    raise ValueError("时间戳必须包含时间和时区")
                value = canonical_time(value)
            elif definition.kind == "date":
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError("业务日期格式为YYYY-MM-DD")
                datetime.strptime(value, "%Y-%m-%d")
            elif definition.kind == "month":
                if not re.fullmatch(r"\d{4}-\d{2}", value):
                    raise ValueError("月份格式为YYYY-MM")
                datetime.strptime(value, "%Y-%m")
            output[definition.name] = value
        except (ValueError, BusinessError) as exc:
            errors.append({"field": definition.name, "message": str(exc)})
    return output, errors


def parse_files(files):
    records = {name: [] for name in SPECS}
    errors, file_details = [], []
    row_count = 0
    total_bytes = 0
    for filename, data in files:
        name = filename.rsplit("/", 1)[-1].rsplit("\\", 1)[-1]
        template = name.removesuffix(".csv")
        if template not in SPECS or not name.endswith(".csv"):
            errors.append(
                {
                    "file": name,
                    "row": 0,
                    "field": "filename",
                    "message": "文件名必须为标准模板名称，例如 orders.csv",
                }
            )
            continue
        total_bytes += len(data)
        if len(data) > MAX_FILE_BYTES or total_bytes > MAX_FILE_BYTES * 4:
            raise BusinessError("文件超出限制：单文件20MB、单批次80MB", code="upload_too_large", status=413)
        count = 0
        try:
            text = data.decode("utf-8-sig")
            if "\x00" in text:
                raise ValueError("CSV不能含NUL字符")
            stream = io.StringIO(text, newline="")
            reader = csv.DictReader(stream, strict=True)
            expected = [item.name for item in SPECS[template]]
            if reader.fieldnames != expected:
                raise ValueError("列名及顺序必须与模板一致：" + ",".join(expected))
            for row in reader:
                if None in row:
                    errors.append(
                        {
                            "file": name,
                            "row": reader.line_num,
                            "field": "",
                            "message": "列数多于模板，请为含逗号的文本加引号",
                        }
                    )
                    continue
                count += 1
                row_count += 1
                if row_count > MAX_BATCH_ROWS:
                    raise BusinessError("单批次最多允许100000行", code="upload_too_large", status=413)
                normalized, issues = normalize_row(template, row)
                errors.extend({"file": name, "row": reader.line_num, **issue} for issue in issues)
                if not issues:
                    records[template].append({"file": name, "row": reader.line_num, "data": normalized})
        except (UnicodeDecodeError, ValueError, csv.Error) as exc:
            errors.append({"file": name, "row": 0, "field": "", "message": f"CSV读取失败：{exc}"})
        file_details.append(
            {
                "name": name,
                "template": template,
                "label": LABELS[template],
                "total_rows": count,
                "sha256": hashlib.sha256(data).hexdigest(),
            }
        )
    return records, errors, file_details, row_count


def source_index(session, templates):
    """Committed source payloads retain identity even when accounting snapshots change."""
    index = {name: {} for name in templates}
    for payload in session.scalars(
        select(m.ImportBatch.payload_json).where(m.ImportBatch.status == "committed")
    ):
        parsed = json.loads(payload)
        for template in templates:
            for record in parsed.get("records", {}).get(template, []):
                row = record["data"]
                index[template][row["id"]] = row
    return index


def model_source(template, obj):
    """Normalize non-imported records, used when API-created records meet CSV keys."""
    fields = {
        "mappings": {"unit": "sales_unit", "factor": "factor_scaled"},
        "fx_rates": {"date": "business_date", "rate": "rate_scaled"},
        "costs": {
            "scope": "level",
            "unit_cost": "unit_cost_scaled",
            "valid_from": "effective_from",
            "valid_to": "effective_to",
        },
        "orders": {"platform_order_id": "platform_order_no", "fx_rate": "fx_rate_scaled"},
        "order_lines": {
            "quantity": "quantity_scaled",
            "factor": "factor_scaled",
            "revenue_original": "original_amount",
        },
        "refunds": {
            "line_id": "order_line_id",
            "amount_original": "original_amount",
            "kind": "refund_type",
            "quantity": "quantity_scaled",
            "recoverable_quantity": "recoverable_quantity_scaled",
        },
        "expenses": {
            "date": "business_date",
            "kind": "expense_type",
            "amount_original": "original_amount",
            "fx_rate": "fx_rate_scaled",
            "line_id": "order_line_id",
        },
        "targets": {"amount": "amount_minor"},
    }
    raw = {}
    for item in SPECS[template]:
        attr = fields.get(template, {}).get(item.name, item.name)
        value = getattr(obj, attr, "")
        if value is None:
            value = ""
        if value != "" and attr.endswith("_scaled"):
            scale = 100_000_000 if item.kind == "rate" else 10_000
            value = str(Decimal(value) / scale)
        if value != "" and attr.endswith("_minor"):
            value = str(Decimal(value) / 100)
        raw[item.name] = str(value)
    result, _ = normalize_row(template, raw)
    return result


def validate_records(session, records):
    existing = {
        name: {obj.id: obj for obj in session.scalars(select(model))} for name, model in MODELS.items()
    }
    submitted_templates = [name for name, values in records.items() if values]
    source = source_index(session, submitted_templates)
    current = {name: {} for name in SPECS}
    for name, rows in existing.items():
        for key, obj in rows.items():
            current[name][key] = source.get(name, {}).get(key) or model_source(name, obj)
    new = {name: [] for name in SPECS}
    errors, warnings, closures = [], [], []
    duplicate_count = conflict_count = 0

    def issue(record, field, message):
        errors.append({"file": record["file"], "row": record["row"], "field": field, "message": message})

    business_keys = {
        name: {tuple(row.get(key) for key in UNIQUE_KEYS[name]): row["id"] for row in rows.values()}
        for name, rows in current.items()
    }
    for template in SPECS:
        for record in records[template]:
            row = record["data"]
            old = current[template].get(row["id"])
            if old is not None:
                if row == old:
                    duplicate_count += 1
                else:
                    conflict_count += 1
                    issue(record, "id", "相同业务编码已存在，但内容不同；请使用明确的修改或历史重算流程")
                continue
            key = tuple(row.get(column) for column in UNIQUE_KEYS[template])
            if key in business_keys[template]:
                conflict_count += 1
                issue(record, ",".join(UNIQUE_KEYS[template]), "业务唯一键已存在，不能以不同编码重复导入")
                continue
            current[template][row["id"]] = row
            business_keys[template][key] = row["id"]
            new[template].append(record)

    def reference(record, key, target, optional=False):
        value = record["data"].get(key)
        if optional and not value:
            return None
        if value not in current[target]:
            issue(record, key, f"引用不存在：{value}（{LABELS[target]}）")
            return None
        return current[target][value]

    for template, values in new.items():
        for record in values:
            row = record["data"]
            if template == "stores":
                reference(record, "channel_id", "channels")
                if row["channel_id"] == "temu" and row["mode"] != "半托管":
                    issue(record, "mode", "本工作区Temu店铺经营模式必须为半托管")
            elif template == "skus":
                reference(record, "product_id", "products")
            elif template == "mappings":
                reference(record, "store_id", "stores")
                reference(record, "sku_id", "skus", True)
                if Decimal(row["factor"]) <= 0:
                    issue(record, "factor", "单位换算系数必须大于0")
                if row["status"] not in {"mapped", "unmapped"} or bool(row["sku_id"]) != (
                    row["status"] == "mapped"
                ):
                    issue(record, "status", "映射状态与标准SKU必须一致：mapped或unmapped")
                if not row["sku_id"]:
                    warnings.append(
                        {
                            "file": record["file"],
                            "row": record["row"],
                            "message": "待关联商品允许导入，相关订单利润待核算",
                        }
                    )
            elif template == "costs":
                reference(record, "sku_id", "skus")
                if row["scope"] == "channel":
                    reference(record, "scope_id", "channels")
                elif row["scope"] == "store":
                    reference(record, "scope_id", "stores")
                elif row["scope"] != "base" or row["scope_id"] != "base":
                    issue(record, "scope", "作用层级必须为base/channel/store；基础scope_id必须为base")
                if row["valid_to"] and row["valid_to"] <= row["valid_from"]:
                    issue(record, "valid_to", "生效结束时间必须晚于开始时间，区间为左闭右开")
                if Decimal(row["unit_cost"]) == 0 and not row["note"].startswith("确认零成本："):
                    issue(record, "note", "零成本须以“确认零成本：”开头说明业务原因")
            elif template == "orders":
                store = reference(record, "store_id", "stores")
                reference(record, "channel_id", "channels")
                if store and store["channel_id"] != row["channel_id"]:
                    issue(record, "channel_id", "订单渠道与店铺所属渠道不一致")
                if row["status"] not in {"paid", "unpaid", "closed", "cancelled"}:
                    issue(record, "status", "订单状态须为paid/unpaid/closed/cancelled")
                if not row["paid_at"]:
                    issue(record, "paid_at", "请提供带时区记录时间，未支付订单使用记录时间并保留unpaid状态")
                if row["currency"] == "CNY" and row["fx_rate"] and Decimal(row["fx_rate"]) != 1:
                    issue(record, "fx_rate", "人民币汇率必须为1")
                if not row["fx_rate"]:
                    warnings.append(
                        {
                            "file": record["file"],
                            "row": record["row"],
                            "message": "缺少汇率，保留原币金额，人民币收入与利润待核算",
                        }
                    )
            elif template == "order_lines":
                order = reference(record, "order_id", "orders")
                reference(record, "sku_id", "skus", True)
                if Decimal(row["quantity"]) <= 0 or Decimal(row["factor"]) <= 0:
                    issue(record, "quantity", "销量与单位换算系数必须大于0")
                try:
                    scaled(Decimal(row["quantity"]) * Decimal(row["factor"]), 10_000)
                    if order and order["fx_rate"]:
                        scaled(Decimal(row["revenue_original"]) * Decimal(order["fx_rate"]), 100)
                except ValueError as exc:
                    issue(record, "revenue_original", str(exc))
            elif template == "refunds":
                line = reference(record, "line_id", "order_lines")
                if row["status"] not in {"completed", "pending"}:
                    issue(record, "status", "退款状态须为completed/pending")
                if row["kind"] not in {"refund_only", "return_refund", "cancel_before_shipping"}:
                    issue(record, "kind", "退款类型须为refund_only/return_refund/cancel_before_shipping")
                if not row["completed_at"]:
                    issue(record, "completed_at", "请提供完成或记录时间，待处理退款使用pending状态")
                if Decimal(row["recoverable_quantity"]) > Decimal(row["quantity"]):
                    issue(record, "recoverable_quantity", "可回收数量不得大于退款标准单位数量")
                if row["kind"] == "refund_only" and Decimal(row["recoverable_quantity"]) > 0:
                    issue(record, "recoverable_quantity", "仅退款不可转回商品成本")
                if line:
                    order = current["orders"].get(line["order_id"])
                    if order and order["paid_at"] and row["completed_at"] < order["paid_at"]:
                        issue(record, "completed_at", "退款发生时间不能早于支付时间")
                    if order and order["status"] in {"unpaid", "closed"}:
                        issue(record, "line_id", "未支付订单不能导入退款")
            elif template == "expenses":
                reference(record, "store_id", "stores")
                order = reference(record, "order_id", "orders", True)
                line = reference(record, "line_id", "order_lines", True)
                if line and not order:
                    order = current["orders"].get(line["order_id"])
                if line and row["order_id"] and line["order_id"] != row["order_id"]:
                    issue(record, "line_id", "费用订单行与订单不匹配")
                if order and order["store_id"] != row["store_id"]:
                    issue(record, "store_id", "费用归属店铺与订单店铺不一致")
                if row["kind"] not in {"platform", "packaging", "logistics", "advertising"}:
                    issue(record, "kind", "费用科目须为platform/packaging/logistics/advertising")
                if row["currency"] == "CNY" and Decimal(row["fx_rate"]) != 1:
                    issue(record, "fx_rate", "人民币汇率必须为1")
                try:
                    scaled(Decimal(row["amount_original"]) * Decimal(row["fx_rate"]), 100)
                except ValueError as exc:
                    issue(record, "amount_original", str(exc))
            elif template == "targets":
                reference(record, "store_id", "stores")

    # Cumulative bounds include both persisted and incoming refunds.
    by_line = defaultdict(list)
    for row in current["refunds"].values():
        if row["status"] == "completed":
            by_line[row["line_id"]].append(row)
    for record in new["refunds"]:
        row = record["data"]
        line = current["order_lines"].get(row["line_id"])
        if not line:
            continue
        group = by_line[row["line_id"]]
        if sum(Decimal(value["amount_original"]) for value in group) > Decimal(line["revenue_original"]):
            issue(record, "amount_original", "累计已完成退款金额超过原订单行可退商品收入")
        bound = Decimal(line["quantity"]) * Decimal(line["factor"])
        if sum(Decimal(value["recoverable_quantity"]) for value in group) > bound:
            issue(record, "recoverable_quantity", "累计可回收标准数量超过原订单行标准数量")
        if sum(Decimal(value["quantity"]) for value in group) > bound:
            issue(record, "quantity", "累计退款标准数量超过原订单行标准数量")

    # Adding a successor ends the previous open version, without touching snapshots.
    groups = defaultdict(list)
    new_cost_records = {record["data"]["id"]: record for record in new["costs"]}
    for row in current["costs"].values():
        # Source payload may describe an interval that a later operation already ended.
        stored = existing["costs"].get(row["id"])
        actual = {**row, "valid_to": stored.effective_to or ""} if stored else dict(row)
        groups[(row["sku_id"], row["scope"], row["scope_id"])].append(actual)
    for versions in groups.values():
        versions.sort(key=lambda row: row["valid_from"])
        for previous, following in zip(versions, versions[1:]):
            end = previous["valid_to"]
            if previous["valid_from"] == following["valid_from"] or (end and end > following["valid_from"]):
                problem = new_cost_records.get(following["id"]) or new_cost_records.get(previous["id"])
                if problem:
                    issue(problem, "valid_from", "相同SKU与作用范围的成本有效区间重叠")
            elif not end:
                if following["id"] not in new_cost_records:
                    problem = new_cost_records.get(previous["id"])
                    if problem:
                        issue(problem, "valid_to", "新版本不能越过已有历史版本；请提供明确截止时间")
                else:
                    closures.append(
                        {
                            "id": previous["id"],
                            "effective_to": following["valid_from"],
                            "sku_id": previous["sku_id"],
                        }
                    )
                    previous["valid_to"] = following["valid_from"]
    return new, errors, warnings, duplicate_count, conflict_count, closures, current


def preview_import(session, files):
    records, errors, file_details, total_rows = parse_files(files)
    new, issues, warnings, duplicates, conflicts, closures, _ = validate_records(session, records)
    errors.extend(issues)
    state = workspace(session)
    preview_id = "IMP-" + uuid4().hex
    summary = {
        "preview_id": preview_id,
        "revision": state.revision,
        "total_rows": total_rows,
        "new_count": sum(len(rows) for rows in new.values()),
        "duplicate_count": duplicates,
        "conflict_count": conflicts,
        "errors": errors,
        "warnings": warnings,
        "files": file_details,
        "cost_interval_changes": closures,
        "can_commit": not errors,
    }
    payload = {"records": new, "closures": closures, "files": file_details}
    timestamp = now()
    session.add(
        m.ImportBatch(
            id=preview_id,
            template_type=",".join(info["template"] for info in file_details),
            template_version=TEMPLATE_VERSION,
            file_digest=digest(file_details),
            preview_json=packed(summary),
            payload_json=packed(payload),
            revision=state.revision,
            status="blocked" if errors else "previewed",
            created_at=timestamp,
        )
    )
    session.add(
        m.OperationPreview(
            id=preview_id,
            operation_type="import",
            request_json=packed({"batch_id": preview_id}),
            summary_json=packed(summary),
            revision=state.revision,
            created_at=timestamp,
            expires_at=(datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        )
    )
    session.flush()
    return summary


def transformed(template, row, lookup, timestamp):
    data = dict(row)
    if template in {"channels", "stores", "products", "skus"}:
        return data
    if template == "mappings":
        data["sales_unit"] = data.pop("unit")
        data["factor_scaled"] = scaled(data.pop("factor"), 10_000)
        data["sku_id"] = data["sku_id"] or None
    elif template == "fx_rates":
        data["business_date"] = data.pop("date")
        data["rate_scaled"] = scaled(data.pop("rate"), 100_000_000)
    elif template == "costs":
        data["level"] = data.pop("scope")
        data["unit_cost_scaled"] = scaled(data.pop("unit_cost"), 10_000)
        data["effective_from"] = data.pop("valid_from")
        data["effective_to"] = data.pop("valid_to") or None
        data["created_at"] = timestamp
        data["source"] = "标准CSV导入"
    elif template == "orders":
        data["platform_order_no"] = data.pop("platform_order_id")
        value = data.pop("fx_rate")
        data["fx_rate_scaled"] = scaled(value, 100_000_000) if value else None
        data["business_date"] = business_date(data["paid_at"])
        data["fx_date"] = data["business_date"]
    elif template == "order_lines":
        order = lookup["orders"][row["order_id"]]
        rate = order["fx_rate"]
        data["quantity_scaled"] = scaled(data.pop("quantity"), 10_000)
        data["factor_scaled"] = scaled(data.pop("factor"), 10_000)
        data["standard_quantity_scaled"] = scaled(Decimal(row["quantity"]) * Decimal(row["factor"]), 10_000)
        data["original_amount"] = data.pop("revenue_original")
        data["revenue_minor"] = scaled(Decimal(data["original_amount"]) * Decimal(rate), 100) if rate else 0
        data["sku_id"] = data["sku_id"] or None
        data["accounting_status"] = "missing_fx" if not rate else "missing_cost"
    elif template == "refunds":
        line = lookup["order_lines"][row["line_id"]]
        order = lookup["orders"][line["order_id"]]
        data["order_line_id"] = data.pop("line_id")
        data["original_amount"] = data.pop("amount_original")
        data["amount_minor"] = (
            scaled(Decimal(data["original_amount"]) * Decimal(order["fx_rate"]), 100)
            if order["fx_rate"]
            else 0
        )
        data["refund_type"] = data.pop("kind")
        data["business_date"] = business_date(data["completed_at"])
        data["quantity_scaled"] = scaled(data.pop("quantity"), 10_000)
        data["recoverable_quantity_scaled"] = scaled(data.pop("recoverable_quantity"), 10_000)
    elif template == "expenses":
        data["business_date"] = data.pop("date")
        data["expense_type"] = data.pop("kind")
        data["original_amount"] = data.pop("amount_original")
        data["amount_minor"] = scaled(Decimal(data["original_amount"]) * Decimal(row["fx_rate"]), 100)
        data["fx_rate_scaled"] = scaled(data.pop("fx_rate"), 100_000_000)
        data["fx_date"] = data["business_date"]
        data["order_line_id"] = data.pop("line_id") or None
        data["order_id"] = data["order_id"] or None
    elif template == "targets":
        data["amount_minor"] = scaled(data.pop("amount"), 100)
    return data


def commit_import(session, preview_id, idempotency_key):
    if not idempotency_key or len(idempotency_key) > 200:
        raise BusinessError("请提供1～200字符的幂等键")
    request_digest = digest({"preview_id": preview_id, "type": "import"})
    operation = session.scalar(
        select(m.OperationRecord).where(m.OperationRecord.idempotency_key == idempotency_key)
    )
    if operation:
        if operation.request_digest != request_digest:
            raise BusinessError("该幂等键已用于不同请求", code="idempotency_conflict", status=409)
        return json.loads(operation.result_json)
    batch = session.get(m.ImportBatch, preview_id)
    preview = session.get(m.OperationPreview, preview_id)
    if not batch or not preview:
        raise BusinessError("导入预览不存在", code="not_found", status=404)
    if batch.status == "committed":
        prior = session.get(m.OperationRecord, batch.operation_id)
        return json.loads(prior.result_json)
    state = workspace(session)
    if batch.revision != state.revision:
        raise BusinessError("业务数据已发生变化，请重新预览导入", code="stale_preview", status=409)
    if preview.expires_at < now():
        raise BusinessError("导入预览已过期，请重新上传预览", code="expired_preview", status=409)
    summary = json.loads(batch.preview_json)
    if summary["errors"]:
        raise BusinessError(
            "本批次包含阻断性错误，未写入任何业务数据", code="invalid_import", details=summary["errors"][:100]
        )
    payload = json.loads(batch.payload_json)
    # Revalidate under the write lock. No browser-calculated amounts are accepted.
    new, errors, _, duplicates, conflicts, closures, lookup = validate_records(session, payload["records"])
    if errors or conflicts or duplicates:
        raise BusinessError(
            "导入依赖发生变化，请重新预览", code="stale_preview", status=409, details=errors[:100]
        )
    timestamp = now()
    operation_id = "OP-" + uuid4().hex
    for template in SPECS:
        values = [transformed(template, record["data"], lookup, timestamp) for record in new[template]]
        if template == "costs":
            # Reuse interactive cost policy under this write lock; keep source IDs stable.
            from .operations import plan_cost_version

            for value in sorted(values, key=lambda item: item["effective_from"]):
                plan = plan_cost_version(
                    session,
                    value["sku_id"],
                    value["level"],
                    value["scope_id"],
                    value["unit_cost_scaled"],
                    value["effective_from"],
                    value["effective_to"],
                )
                for prior in plan["close_previous"]:
                    session.get(m.CostVersion, prior["id"]).effective_to = prior["new_end"]
                value["effective_to"] = plan["effective_to"]
                session.execute(insert(m.CostVersion), [value])
                session.flush()
            continue
        for index in range(0, len(values), 500):
            session.execute(insert(MODELS[template]), values[index : index + 500])
    for change in closures:
        version = session.get(m.CostVersion, change["id"])
        version.effective_to = change["effective_to"]
        session.add(
            m.ChangeLog(
                id="CHANGE-" + uuid4().hex,
                operation_type="import_cost_successor",
                entity_id=version.id,
                before_json=packed({"effective_to": None}),
                after_json=packed(change),
                note="CSV后继成本版本结束上一开放区间，历史订单快照保留",
                created_at=timestamp,
                operation_id=operation_id,
            )
        )
    session.flush()
    new_lines = [record["data"]["id"] for record in new["order_lines"]]
    if new_lines:
        apply_snapshots(session, new_lines)
    refund_lines = list({record["data"]["line_id"] for record in new["refunds"]})
    if refund_lines:
        update_refund_reversals(session, refund_lines)
    if new_lines or new["expenses"]:
        allocate_expenses(session)
    new_count = sum(len(values) for values in new.values())
    if new_count:
        state.revision += 1
    result = {
        "operation_id": operation_id,
        "batch_id": preview_id,
        "revision": state.revision,
        "new_count": new_count,
        "duplicate_count": summary["duplicate_count"],
        "conflict_count": 0,
        "summary": {
            "new_count": new_count,
            "duplicate_count": summary["duplicate_count"],
            "affected_order_lines": len(new_lines),
        },
    }
    batch.status = "committed"
    batch.operation_id = operation_id
    session.add(
        m.OperationRecord(
            id=operation_id,
            idempotency_key=idempotency_key,
            request_digest=request_digest,
            operation_type="import",
            result_json=packed(result),
            created_at=timestamp,
        )
    )
    session.flush()
    return result


class ImportCommit(BaseModel):
    preview_id: str
    idempotency_key: str = Field(min_length=1, max_length=200)


@router.get("/templates")
def templates():
    return {
        "items": [
            {
                "name": name,
                "label": LABELS[name],
                "version": TEMPLATE_VERSION,
                "filename": name + ".csv",
                "unique_key": UNIQUE_KEYS[name],
                "fields": [
                    {
                        "name": item.name,
                        "type": item.kind,
                        "required": item.required,
                        "description": item.description,
                    }
                    for item in fields
                ],
            }
            for name, fields in SPECS.items()
        ],
        "max_file_bytes": MAX_FILE_BYTES,
        "max_batch_rows": MAX_BATCH_ROWS,
    }


@router.get("/templates/{name}")
def template_download(name: str):
    name = name.removesuffix(".csv")
    if name not in SPECS:
        raise BusinessError("未知CSV模板", code="not_found", status=404)
    return Response(
        dump_csv(name, []),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{name}.csv"'},
    )


@router.post("/preview")
def preview_upload(files: list[UploadFile] = File(...)):
    if not files or len(files) > len(SPECS):
        raise BusinessError(f"请选择1～{len(SPECS)}个标准模板文件")
    content = [(file.filename or "unknown.csv", file.file.read(MAX_FILE_BYTES + 1)) for file in files]
    with write_session() as session:
        return preview_import(session, content)


@router.post("/commit")
def import_commit(body: ImportCommit):
    with write_session() as session:
        return commit_import(session, body.preview_id, body.idempotency_key)


@router.get("/exports/{name}")
def standard_export(name: str):
    """Round-trippable source CSV, distinct from formula-protected display exports."""
    name = name.removesuffix(".csv")
    if name not in SPECS:
        raise BusinessError("未知CSV模板", code="not_found", status=404)
    with SessionLocal() as session:
        rows = [
            model_source(name, row) for row in session.scalars(select(MODELS[name]).order_by(MODELS[name].id))
        ]
        return Response(
            dump_csv(name, rows),
            media_type="text/csv; charset=utf-8",
            headers={
                "Content-Disposition": f'attachment; filename="{name}.csv"',
                "X-CSV-Template-Version": TEMPLATE_VERSION,
            },
        )


@router.get("/batches")
def batches():
    with SessionLocal() as session:
        rows = session.scalars(select(m.ImportBatch).order_by(m.ImportBatch.created_at.desc()).limit(100))
        return {
            "items": [
                {
                    "id": row.id,
                    "template_type": row.template_type,
                    "template_version": row.template_version,
                    "status": row.status,
                    "created_at": row.created_at,
                    "operation_id": row.operation_id,
                    "file_digest": row.file_digest,
                    **{
                        key: value
                        for key, value in json.loads(row.preview_json).items()
                        if key in {"total_rows", "new_count", "duplicate_count", "conflict_count"}
                    },
                }
                for row in rows
            ]
        }


@router.get("/errors/{preview_id}")
def errors_download(preview_id: str):
    with SessionLocal() as session:
        batch = session.get(m.ImportBatch, preview_id)
        if batch is None:
            raise BusinessError("导入预览不存在", code="not_found", status=404)
        errors = json.loads(batch.preview_json)["errors"]
        content = safe_display_csv(
            ["文件", "原始行号", "字段", "错误原因"],
            [[item["file"], item["row"], item["field"], item["message"]] for item in errors],
        )
        return Response(
            content,
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="errors-{preview_id}.csv"'},
        )
