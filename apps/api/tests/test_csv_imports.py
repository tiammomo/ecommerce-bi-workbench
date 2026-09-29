from contextlib import contextmanager
from copy import deepcopy
from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.csv_spec import SPECS, dump_csv, safe_display_csv
from app.db import make_engine
from app.domain import BusinessError
from app.imports import commit_import, normalize_row, parse_files, preview_import
from app.models import Base, CostVersion, Order, OrderLine, Product, RefundEvent, WorkspaceState
from app.seed_data import generate_demo


@pytest.fixture
def database(tmp_path):
    engine = make_engine(tmp_path / "test.sqlite3")
    Base.metadata.create_all(engine)

    @contextmanager
    def transaction():
        with engine.connect() as connection:
            connection.info["write_transaction"] = True
            try:
                with Session(connection, expire_on_commit=False) as session, session.begin():
                    yield session
            finally:
                connection.info.pop("write_transaction", None)

    yield transaction
    engine.dispose()


def source_records():
    records = {name: [] for name in SPECS}
    records.update(
        {
            "channels": [{"id": "temu", "name": "Temu", "color": "#2563eb"}],
            "stores": [
                {
                    "id": "shop",
                    "channel_id": "temu",
                    "name": '中文, "店铺"\n第二行',
                    "market": "美国",
                    "mode": "半托管",
                    "currency": "CNY",
                    "timezone": "Asia/Shanghai",
                }
            ],
            "products": [{"id": "0001", "name": "示例商品", "category": "家居收纳", "series": "示例"}],
            "skus": [{"id": "00001", "product_id": "0001", "spec": "标准", "unit": "件"}],
            "mappings": [
                {
                    "id": "map",
                    "store_id": "shop",
                    "platform_product_id": "000001",
                    "platform_sku": "0000001",
                    "sku_id": "00001",
                    "unit": "件",
                    "factor": "1",
                    "status": "mapped",
                }
            ],
            "costs": [
                {
                    "id": "base",
                    "sku_id": "00001",
                    "scope": "base",
                    "scope_id": "base",
                    "unit_cost": "100.0000",
                    "valid_from": "2026-04-02T00:00:00+08:00",
                    "valid_to": "",
                    "note": "基础",
                },
                {
                    "id": "channel",
                    "sku_id": "00001",
                    "scope": "channel",
                    "scope_id": "temu",
                    "unit_cost": "120",
                    "valid_from": "2026-04-02T00:00:00+08:00",
                    "valid_to": "",
                    "note": "渠道",
                },
                {
                    "id": "store",
                    "sku_id": "00001",
                    "scope": "store",
                    "scope_id": "shop",
                    "unit_cost": "115",
                    "valid_from": "2026-04-02T00:00:00+08:00",
                    "valid_to": "",
                    "note": "店铺",
                },
            ],
            "orders": [
                {
                    "id": "order-0001",
                    "platform_order_id": "00000001",
                    "channel_id": "temu",
                    "store_id": "shop",
                    "paid_at": "2026-09-01T12:00:00+08:00",
                    "status": "paid",
                    "currency": "CNY",
                    "fx_rate": "1",
                }
            ],
            "order_lines": [
                {
                    "id": "line-1",
                    "order_id": "order-0001",
                    "platform_sku": "0000001",
                    "sku_id": "00001",
                    "quantity": "1",
                    "factor": "1",
                    "revenue_original": "200.00",
                }
            ],
            "expenses": [
                {
                    "id": "fee-" + kind,
                    "store_id": "shop",
                    "date": "2026-09-01",
                    "kind": kind,
                    "amount_original": amount,
                    "currency": "CNY",
                    "fx_rate": "1",
                    "order_id": "order-0001",
                    "line_id": "",
                    "source": "固定验算",
                }
                for kind, amount in [
                    ("platform", "10"),
                    ("packaging", "2"),
                    ("logistics", "20"),
                    ("advertising", "15"),
                ]
            ],
        }
    )
    return records


def files(records):
    return [(name + ".csv", dump_csv(name, rows).encode()) for name, rows in records.items() if rows]


def initial_import(database, records=None):
    with database() as session:
        preview = preview_import(session, files(records or source_records()))
        assert preview["errors"] == []
        result = commit_import(session, preview["preview_id"], "initial")
    return preview, result


def test_csv_round_trip_bom_chinese_quotes_newlines_and_leading_zero():
    records = source_records()
    parsed, errors, _, total = parse_files(files(records))
    assert not errors
    assert total > 0
    assert parsed["stores"][0]["data"]["name"] == '中文, "店铺"\n第二行'
    assert parsed["orders"][0]["data"]["platform_order_id"] == "00000001"
    assert parsed["products"][0]["data"]["id"] == "0001"
    assert parsed["costs"][0]["data"]["unit_cost"] == "100.0000"


def test_import_fixed_accounting_fixture_and_real_integer_storage(database):
    initial_import(database)
    with database() as session:
        line = session.get(OrderLine, "line-1")
        assert line.cost_minor == 11500
        assert line.cost_source == "store"
        assert line.cost_version_id == "store"
        fees = (
            line.platform_fee_minor
            + line.packaging_fee_minor
            + line.logistics_fee_minor
            + line.advertising_fee_minor
        )
        assert fees == 4700
        assert line.revenue_minor - line.cost_minor - fees == 3800
        assert session.execute(
            text("SELECT typeof(revenue_minor),typeof(cost_minor) FROM order_lines")
        ).one() == ("integer", "integer")
        assert session.execute(text("PRAGMA foreign_keys")).scalar() == 1
        assert session.execute(text("PRAGMA journal_mode")).scalar() == "wal"


def test_repeat_file_skips_all_sources_and_idempotent_commit(database):
    first_preview, first = initial_import(database)
    with database() as session:
        assert commit_import(session, first_preview["preview_id"], "initial") == first
        again = preview_import(session, files(source_records()))
        assert again["new_count"] == 0
        assert again["duplicate_count"] == first["new_count"]
        assert not again["errors"]
        second = commit_import(session, again["preview_id"], "duplicate-import")
        assert second["revision"] == first["revision"]
        assert session.scalar(select(func.count()).select_from(Order)) == 1


def test_conflict_blocks_whole_batch_even_valid_other_rows(database):
    initial_import(database)
    records = {
        "order_lines": deepcopy(source_records()["order_lines"]),
        "products": [{"id": "new", "name": "不应写入", "category": "测试", "series": "测试"}],
    }
    records["order_lines"][0]["revenue_original"] = "999.00"
    with database() as session:
        preview = preview_import(session, files(records))
        assert preview["conflict_count"] == 1
        with pytest.raises(BusinessError, match="阻断性错误"):
            commit_import(session, preview["preview_id"], "conflicting")
        assert session.get(Product, "new") is None
        assert session.get(OrderLine, "line-1").revenue_minor == 20000


@pytest.mark.parametrize("value", ["NaN", "Infinity", "1.001", "1,000.00", "=1+1", "-0.01", "1000000000001"])
def test_reject_invalid_money_without_silent_rounding(value):
    row = source_records()["order_lines"][0] | {"revenue_original": value}
    _, errors = normalize_row("order_lines", row)
    assert any(error["field"] == "revenue_original" for error in errors)


def test_missing_fx_and_mapping_are_explicit_pending_states(database):
    records = source_records()
    records["orders"][0].update(currency="USD", fx_rate="")
    preview, _ = initial_import(database, records)
    assert any("汇率" in row["message"] for row in preview["warnings"])
    with database() as session:
        line = session.get(OrderLine, "line-1")
        assert line.accounting_status == "missing_fx"
        assert line.original_amount == "200.00"
        assert session.get(Order, "order-0001").fx_rate_scaled is None


def test_cost_successor_preview_closes_previous_but_preserves_snapshot(database):
    initial_import(database)
    successor = source_records()["costs"][-1] | {
        "id": "store-new",
        "unit_cost": "125",
        "valid_from": "2026-09-29T00:00:00+08:00",
        "note": "未来版本",
    }
    with database() as session:
        preview = preview_import(session, files({"costs": [successor]}))
        assert not preview["errors"]
        assert preview["cost_interval_changes"][0]["id"] == "store"
        commit_import(session, preview["preview_id"], "future-cost")
        assert session.get(CostVersion, "store").effective_to == "2026-09-28T16:00:00.000000Z"
        assert session.get(OrderLine, "line-1").cost_minor == 11500


def test_stale_preview_and_cross_request_idempotency_rejected(database):
    initial_import(database)
    row = {"id": "new1", "name": "商品", "category": "类别", "series": "系列"}
    with database() as session:
        older = preview_import(session, files({"products": [row]}))
    with database() as session:
        newer = preview_import(session, files({"products": [row | {"id": "new2"}]}))
        commit_import(session, newer["preview_id"], "newer")
    with database() as session:
        with pytest.raises(BusinessError, match="业务数据已发生变化"):
            commit_import(session, older["preview_id"], "older")
        with pytest.raises(BusinessError, match="幂等键"):
            commit_import(session, older["preview_id"], "initial")
        assert session.get(Product, "new1") is None


def test_refund_cumulative_limit_is_checked_before_any_write(database):
    initial_import(database)
    row = {
        "id": "refund1",
        "line_id": "line-1",
        "completed_at": "2026-09-03T12:00:00+08:00",
        "amount_original": "150",
        "kind": "refund_only",
        "reason": "测试",
        "quantity": "0",
        "recoverable_quantity": "0",
        "status": "completed",
    }
    with database() as session:
        preview = preview_import(session, files({"refunds": [row, row | {"id": "refund2"}]}))
        assert any("累计已完成退款" in error["message"] for error in preview["errors"])
        with pytest.raises(BusinessError):
            commit_import(session, preview["preview_id"], "too-much-refund")


def test_split_foreign_currency_refunds_cancel_original_to_the_cent(database):
    records = source_records()
    records["orders"][0].update(currency="USD", fx_rate="1.5")
    records["order_lines"][0]["revenue_original"] = "0.02"
    records["expenses"] = []
    records["refunds"] = [
        {
            "id": f"split-{index}",
            "line_id": "line-1",
            "completed_at": f"2026-09-0{index + 2}T12:00:00+08:00",
            "amount_original": "0.01",
            "kind": "refund_only",
            "reason": "分笔退款舍入验证",
            "quantity": "0",
            "recoverable_quantity": "0",
            "status": "completed",
        }
        for index in range(2)
    ]
    initial_import(database, records)
    with database() as session:
        assert session.get(OrderLine, "line-1").revenue_minor == 3
        amounts = list(session.scalars(select(RefundEvent.amount_minor).order_by(RefundEvent.id)))
        assert amounts == [2, 1]
        assert sum(amounts) == 3


def test_failure_after_insert_rolls_back_whole_transaction(database, monkeypatch):
    import app.imports as importer

    def fail(*args):
        raise RuntimeError("模拟核算失败")

    monkeypatch.setattr(importer, "apply_snapshots", fail)
    with pytest.raises(RuntimeError, match="模拟核算失败"), database() as session:
        preview = preview_import(session, files(source_records()))
        commit_import(session, preview["preview_id"], "rollback")
    with database() as session:
        assert session.scalar(select(func.count()).select_from(Order)) == 0
        assert session.scalar(select(func.count()).select_from(Product)) == 0
        assert session.get(WorkspaceState, "demo") is None


def test_formula_safe_display_csv_is_distinct_from_source_csv():
    output = safe_display_csv(
        ["名称", "金额"], [["=1+1", "2.00"], ["@SUM(1)", "0.00"], ["正常商品", Decimal("1.23")]]
    )
    assert "'=1+1" in output
    assert "'@SUM(1)" in output
    assert output.startswith("\ufeff")


def test_generator_is_deterministic_and_has_expected_scope():
    first = generate_demo()
    assert first == generate_demo()
    assert len(first["orders"]) == 10000
    assert len(first["stores"]) == 9
    assert len(first["products"]) == 24
    assert len(first["skus"]) == 72
    assert len({row["paid_at"][:10] for row in first["orders"]}) == 180
    assert any(row["id"].startswith("EXP-UNALLOCATED") for row in first["expenses"])
    shared = [row for row in first["orders"] if row["platform_order_id"] == "00000001"]
    assert len(shared) == 9
    assert len({row["store_id"] for row in shared}) == 9
