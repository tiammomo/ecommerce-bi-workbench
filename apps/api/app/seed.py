"""Explicit demo initialization/reset. API startup never calls this module."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from sqlalchemy import delete

from .csv_spec import LABELS, SPECS, UNIQUE_KEYS, dump_csv
from .db import ROOT, write_session
from .domain import BusinessError
from .imports import commit_import, preview_import, workspace
from .models import Base, WorkspaceState
from .seed_data import DATASET_VERSION, DEMO_AS_OF, SCENARIOS, generate_demo


def write_source_files(records, directory: Path):
    directory.mkdir(parents=True, exist_ok=True)
    files = []
    for name, rows in records.items():
        data = dump_csv(name, rows).encode("utf-8")
        (directory / f"{name}.csv").write_bytes(data)
        files.append((f"{name}.csv", data))
    return files


def examples(records):
    """A small self-contained selection with valid references and leading-zero IDs."""
    result = {name: [] for name in SPECS}
    orders = records["orders"][:3]
    order_ids = {row["id"] for row in orders}
    lines = [row for row in records["order_lines"] if row["order_id"] in order_ids]
    sku_ids = {row["sku_id"] for row in lines}
    skus = [row for row in records["skus"] if row["id"] in sku_ids]
    product_ids = {row["product_id"] for row in skus}
    line_ids = {row["id"] for row in lines}
    store_ids = {row["store_id"] for row in orders}
    result.update(
        {
            "channels": records["channels"],
            "stores": [row for row in records["stores"] if row["id"] in store_ids],
            "products": [row for row in records["products"] if row["id"] in product_ids],
            "skus": skus,
            "mappings": [
                row
                for row in records["mappings"]
                if row["store_id"] in store_ids and row["sku_id"] in sku_ids
            ],
            "fx_rates": records["fx_rates"][:2],
            "costs": [
                row
                for row in records["costs"]
                if row["sku_id"] in sku_ids and (row["scope"] != "store" or row["scope_id"] in store_ids)
            ],
            "orders": orders,
            "order_lines": lines,
            "refunds": [row for row in records["refunds"] if row["line_id"] in line_ids],
            "expenses": [row for row in records["expenses"] if row["order_id"] in order_ids],
            "targets": [
                row
                for row in records["targets"]
                if row["store_id"] in store_ids and row["month"] == "2026-04"
            ],
        }
    )
    return result


def write_templates(records):
    write_source_files({name: [] for name in SPECS}, ROOT / "data/templates")
    write_source_files(examples(records), ROOT / "data/examples")
    doc = [
        "# 标准 CSV 模板 v1",
        "",
        "CSV 是交换格式，查询始终读取 SQLite。金额以元为单位，使用无千分位十进制字符串。",
        "输入支持 UTF-8 / UTF-8 BOM；使用 CSV 引号转义逗号、换行及双引号。编码按文本保留前导零。",
        "按依赖顺序提交多个文件；单文件最多20MB，单批最多80MB或100000行。整个批次成功或整体回滚。",
        "完全相同的原始记录跳过，同业务键不同内容阻断。预览30分钟有效，期间业务修订号变化必须重新预览。",
        "新成本只影响以后形成的订单快照。历史补全使用独立重算；零成本说明须以 `确认零成本：` 开头。",
        "平台 `quantity` 乘 `factor` 得到标准单位数量；退款 `quantity` 和 `recoverable_quantity` 已为标准单位。",
        "`paid_at`/`completed_at` 必须带时区；未支付/待处理记录仍保留记录时间，通过状态从财务指标排除。",
        "`scope` 为 base/channel/store，基础成本的 `scope_id` 必须为 base；有效区间左闭右开。",
        "`expenses.amount_original` 允许负数，代表明确费用退回调整；其他金额不允许负值。",
        "待关联或缺失成本/汇率记录保留为待核算，必需外键缺失则阻断。",
        "渠道/店铺等 ID 为跨文件稳定编码。`data/examples` 是互相关联的小样例，演示库中重复导入会跳过。",
        "展示报表 CSV 会保护公式型文本且不承诺可回导；本目录标准模板CSV保留原始编码，可回导。",
        "",
    ]
    for name, fields in SPECS.items():
        doc.extend(
            [
                f"## {name}.csv — {LABELS[name]}",
                "",
                f"业务唯一键：`{' + '.join(UNIQUE_KEYS[name])}`；每行还须有唯一 `id`。",
                "",
                "| 字段 | 类型 | 必填 | 说明 |",
                "| --- | --- | --- | --- |",
            ]
        )
        doc.extend(
            f"| {field.name} | {field.kind} | {'是' if field.required else '否'} | {field.description or '参见业务规则；编码按文本读取'} |"
            for field in fields
        )
        doc.append("")
    (ROOT / "data/templates/README.md").write_text("\n".join(doc), encoding="utf-8")
    (ROOT / "data/scenarios.json").write_text(
        json.dumps(SCENARIOS, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def seed_session(session, *, reset=False):
    current = session.get(WorkspaceState, "demo")
    if current and current.dataset_version == DATASET_VERSION and not reset:
        return {
            "status": "already_initialized",
            "dataset_version": DATASET_VERSION,
            "revision": current.revision,
        }
    old_revision = current.revision if current else 0
    if reset:
        for table in reversed(Base.metadata.sorted_tables):
            session.execute(delete(table))
        session.expunge_all()
        session.add(
            WorkspaceState(id="demo", revision=old_revision, dataset_version="", demo_as_of=DEMO_AS_OF)
        )
        session.flush()
    records = generate_demo()
    files = write_source_files(records, ROOT / ".localdata/demo-csv")
    write_templates(records)
    preview = preview_import(session, files)
    if preview["errors"]:
        raise BusinessError("演示数据验证失败", details=preview["errors"][:20])
    result = commit_import(session, preview["preview_id"], f"seed-{DATASET_VERSION}-{preview['preview_id']}")
    state = workspace(session)
    state.dataset_version = DATASET_VERSION
    state.demo_as_of = DEMO_AS_OF
    result.update(
        {
            "status": "reset" if reset else "initialized",
            "dataset_version": DATASET_VERSION,
            "counts": {name: len(rows) for name, rows in records.items()},
        }
    )
    return result


def reset_demo(session):
    return seed_session(session, reset=True)


def run_seed(reset=False):
    with write_session() as session:
        return seed_session(session, reset=reset)


def main():
    parser = argparse.ArgumentParser(description="初始化或显式恢复模拟数据；普通seed不会覆盖业务修改")
    parser.add_argument(
        "--reset", action="store_true", help="清除本演示工作区的业务修改和视图，再恢复固定数据"
    )
    args = parser.parse_args()
    print(json.dumps(run_seed(reset=args.reset), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
