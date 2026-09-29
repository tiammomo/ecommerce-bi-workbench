from decimal import Decimal

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import sessionmaker

from app.analytics import analytics, grouped, parse_filters
from app.db import make_engine
from app.domain import (
    BusinessError,
    allocate_minor,
    apply_snapshots,
    canonical_time,
    decimal_value,
    line_cost,
    now,
    resolve_cost,
)
from app.models import (
    Base,
    Channel,
    CostVersion,
    ExpenseEntry,
    ListingMapping,
    Order,
    OrderLine,
    Product,
    RefundEvent,
    StandardSku,
    Store,
    WorkspaceState,
)
from app.operations import commit_operation, difference, make_preview


@pytest.fixture
def session(tmp_path):
    engine = make_engine(tmp_path / "isolated.sqlite3")
    Base.metadata.create_all(engine)
    with sessionmaker(bind=engine, expire_on_commit=False)() as session:
        session.add(Channel(id="temu", name="Temu", color="#2563eb"))
        session.add(Product(id="p1", name="测试商品", category="家居"))
        session.add(WorkspaceState(id="demo", dataset_version="test", revision=1))
        session.flush()
        session.add(Store(id="store1", channel_id="temu", name="Temu A"))
        session.add(StandardSku(id="sku1", product_id="p1", spec="标准款"))
        session.flush()
        session.add(
            ListingMapping(
                id="map1",
                store_id="store1",
                platform_product_id="001",
                platform_sku="0001",
                sku_id="sku1",
                factor_scaled=10000,
            )
        )
        for key, level, scope, cost in [
            ("base1", "base", "base", 1000000),
            ("channel1", "channel", "temu", 1200000),
            ("store_cost1", "store", "store1", 1150000),
        ]:
            session.add(
                CostVersion(
                    id=key,
                    sku_id="sku1",
                    level=level,
                    scope_id=scope,
                    unit_cost_scaled=cost,
                    effective_from=canonical_time("2026-01-01"),
                    created_at=now(),
                )
            )
        session.flush()
        session.add(
            Order(
                id="order1",
                platform_order_no="000001",
                channel_id="temu",
                store_id="store1",
                paid_at=canonical_time("2026-09-01T12:00:00+08:00"),
                business_date="2026-09-01",
                status="paid",
                currency="CNY",
                fx_rate_scaled=100000000,
                fx_date="2026-09-01",
            )
        )
        session.flush()
        session.add(
            OrderLine(
                id="line1",
                order_id="order1",
                platform_sku="0001",
                sku_id="sku1",
                revenue_minor=20000,
                quantity_scaled=10000,
                standard_quantity_scaled=10000,
                original_amount="200.00",
                platform_fee_minor=1000,
                packaging_fee_minor=200,
                logistics_fee_minor=2000,
                advertising_fee_minor=1500,
            )
        )
        session.flush()
        apply_snapshots(session, ["line1"])
        session.commit()
        yield session
    engine.dispose()


def metric(session):
    return grouped(session, parse_filters({}))[0]


def test_fixed_profit_refunds_and_cost_priority(session):
    assert metric(session)["profit"] == "38.00"
    assert metric(session)["gross_profit"] == "85.00"
    assert metric(session)["profit_margin"] == "0.19000000"
    assert resolve_cost(session, "sku1", "temu", "store1", canonical_time("2026-09-01")).id == "store_cost1"
    assert resolve_cost(session, "sku1", "temu", "other", canonical_time("2026-09-01")).id == "channel1"
    assert resolve_cost(session, "sku1", "other", "other", canonical_time("2026-09-01")).id == "base1"
    session.add(
        RefundEvent(
            id="r1",
            order_line_id="line1",
            completed_at=canonical_time("2026-09-15"),
            business_date="2026-09-15",
            amount_minor=2000,
            refund_type="refund_only",
            recoverable_quantity_scaled=0,
        )
    )
    session.flush()
    apply_snapshots(session, ["line1"])
    assert metric(session)["profit"] == "18.00"
    assert metric(session)["profit_margin"] == "0.10000000"
    refund = session.get(RefundEvent, "r1")
    refund.amount_minor = 20000
    refund.refund_type = "return_refund"
    refund.recoverable_quantity_scaled = 10000
    apply_snapshots(session, ["line1"])
    assert metric(session)["profit"] == "-47.00"
    assert metric(session)["profit_margin"] is None
    assert metric(session)["cost"] == "0.00"


def test_allocation_exact_and_stable():
    assert allocate_minor(2, {"c": 1, "a": 1, "b": 1}) == {"c": 0, "a": 1, "b": 1}
    assert sum(allocate_minor(1001, {"a": 13, "b": 17, "c": 21}).values()) == 1001
    assert sum(allocate_minor(-1001, {"a": 13, "b": 17, "c": 21}).values()) == -1001
    assert allocate_minor(100, {"a": 0}) == {}
    assert line_cost(123456, 30000) == 3704
    for value in ["NaN", "Infinity", "-Infinity", "1000000000001", "1.001"]:
        with pytest.raises(BusinessError):
            decimal_value(value, places=2)


def test_cost_commit_history_unchanged_idempotent_and_stale(session):
    payload = {
        "sku_ids": ["sku1"],
        "scope": "store",
        "scope_id": "store1",
        "unit_cost": "125",
        "adjustment_type": "absolute",
        "effective_from": "2026-09-29",
        "note": "未来采购批次",
    }
    preview = make_preview(session, "cost", payload)
    old_revision = session.get(WorkspaceState, "demo").revision
    assert preview["revision"] == old_revision
    session.commit()
    result = commit_operation(session, preview["preview_id"], "stable-key")
    session.commit()
    assert commit_operation(session, preview["preview_id"], "stable-key") == result
    assert session.scalar(select(func.count()).select_from(CostVersion)) == 4
    assert session.get(OrderLine, "line1").cost_minor == 11500
    assert metric(session)["profit"] == "38.00"
    assert (
        resolve_cost(session, "sku1", "temu", "store1", canonical_time("2026-09-29")).unit_cost_scaled
        == 1250000
    )
    assert (
        resolve_cost(session, "sku1", "temu", "store1", canonical_time("2026-09-28")).unit_cost_scaled
        == 1150000
    )
    with pytest.raises(BusinessError, match="已变化"):
        commit_operation(session, preview["preview_id"], "different-key")
    with pytest.raises(BusinessError, match="幂等"):
        commit_operation(session, "another-preview", "stable-key")


def test_missing_cost_not_zero_and_explicit_recalc(session):
    line = session.get(OrderLine, "line1")
    line.cost_minor = None
    line.unit_cost_scaled = None
    line.accounting_status = "missing_cost"
    session.flush()
    summary = metric(session)
    assert summary["revenue"] == "200.00"
    assert summary["known_revenue"] == "0.00"
    assert summary["unknown_revenue"] == "200.00"
    assert summary["coverage"] == "0.00000000"
    assert summary["profit_margin"] is None
    preview = make_preview(
        session, "recalculation", {"start": "2026-09-01", "end": "2026-09-01", "only_missing": True}
    )
    assert preview["summary"]["profit_delta"] == "38.00"
    commit_operation(session, preview["preview_id"], "recalc-one")
    assert metric(session)["profit"] == "38.00"
    second = make_preview(
        session, "recalculation", {"start": "2026-09-01", "end": "2026-09-01", "only_missing": True}
    )
    assert second["summary"]["affected_lines"] == 0
    assert metric(session)["coverage"] == "1.00000000"


def test_simulation_is_read_only_and_bridge_reconciles(session):
    before = metric(session)["profit"]
    result = difference(session, ["line1"], 1250000)
    assert result["profit_delta"] == "-10.00"
    assert metric(session)["profit"] == before
    report = analytics(session, parse_filters({}))
    assert sum(Decimal(r["amount"]) for r in report["profit_bridge"]) == Decimal(
        report["summary"]["profit"]
    ) - Decimal(report["previous"]["profit"])


def test_unallocated_fee_is_reconciled_without_forcing_sku(session):
    session.add(
        ExpenseEntry(
            id="empty-ad",
            store_id="store1",
            business_date="2026-09-02",
            expense_type="advertising",
            amount_minor=1000,
            allocated=False,
        )
    )
    session.flush()
    overall = metric(session)
    assert overall["profit"] == "28.00"
    sku_rows = grouped(session, parse_filters({}), "sku")
    assert {r["id"] for r in sku_rows} == {"sku1", "unallocated"}
    assert sum(Decimal(r["profit"]) for r in sku_rows) == Decimal(overall["profit"])
    selected = grouped(session, parse_filters({"sku_ids": "sku1"}))[0]
    assert selected["profit"] == "38.00"
    assert selected["excluded_unallocated_fees"] == "10.00"


def test_sqlite_fk_wal_and_transaction_rollback(session):
    assert session.execute(text("PRAGMA foreign_keys")).scalar() == 1
    assert session.execute(text("PRAGMA journal_mode")).scalar() == "wal"
    session.add(StandardSku(id="bad", product_id="missing", spec="非法引用"))
    with pytest.raises(IntegrityError):
        session.flush()
    session.rollback()
    assert session.get(StandardSku, "bad") is None
    assert metric(session)["profit"] == "38.00"


def test_new_mapping_target_selects_historical_unmapped_lines(session):
    mapping = session.get(ListingMapping, "map1")
    mapping.sku_id = None
    mapping.status = "unmapped"
    line = session.get(OrderLine, "line1")
    line.sku_id = None
    line.cost_minor = None
    line.accounting_status = "missing_mapping"
    session.flush()
    preview = make_preview(session, "mapping", {"mapping_id": "map1", "sku_id": "sku1", "unit_factor": "1"})
    commit_operation(session, preview["preview_id"], "map-key")
    assert session.get(OrderLine, "line1").sku_id is None
    recalc = make_preview(
        session,
        "recalculation",
        {"sku_ids": ["sku1"], "start": "2026-09-01", "end": "2026-09-01", "only_missing": True},
    )
    assert recalc["summary"]["affected_lines"] == 1
    assert recalc["summary"]["profit_delta"] == "38.00"
    commit_operation(session, recalc["preview_id"], "mapped-recalc-key")
    assert session.get(OrderLine, "line1").sku_id == "sku1"
    assert metric(session)["profit"] == "38.00"


def test_explicit_fx_repair_restores_revenue_refunds_and_source_allocations(session):
    from app.domain import allocate_expenses
    from app.models import FxRate

    order = session.get(Order, "order1")
    order.currency = "USD"
    order.fx_rate_scaled = None
    line = session.get(OrderLine, "line1")
    line.revenue_minor = 0
    line.accounting_status = "missing_fx"
    session.add(
        FxRate(id="USD:2026-09-01", currency="USD", business_date="2026-09-01", rate_scaled=200000000)
    )
    session.add(
        RefundEvent(
            id="fx-refund",
            order_line_id="line1",
            original_amount="20.00",
            amount_minor=0,
            completed_at=canonical_time("2026-09-05"),
            business_date="2026-09-05",
        )
    )
    for kind, amount in [("platform", 1000), ("packaging", 200), ("logistics", 2000), ("advertising", 1500)]:
        session.add(
            ExpenseEntry(
                id=kind,
                store_id="store1",
                business_date="2026-09-01",
                expense_type=kind,
                amount_minor=amount,
                order_id="order1",
            )
        )
    session.flush()
    allocate_expenses(session)
    assert metric(session)["sales_complete"] is False
    assert metric(session)["profit"] == "-47.00"
    preview = make_preview(
        session,
        "recalculation",
        {"sku_ids": ["sku1"], "start": "2026-09-01", "end": "2026-09-01", "only_missing": True},
    )
    assert preview["summary"]["new_profit"] == "198.00"
    assert preview["summary"]["profit_delta"] == "245.00"
    assert session.get(Order, "order1").fx_rate_scaled is None
    assert metric(session)["sales"] == "0.00"
    commit_operation(session, preview["preview_id"], "fx-repair-key")
    summary = metric(session)
    assert summary["sales"] == "400.00"
    assert summary["refunds"] == "40.00"
    assert summary["profit"] == "198.00"
    assert summary["unallocated_fees"] == "0.00"
    assert summary["sales_complete"] is True


def test_status_scope_summary_rows_export_underlying_amounts(session):
    line = session.get(OrderLine, "line1")
    line.advertising_fee_minor = 10000
    session.flush()
    report = analytics(session, parse_filters({"status": "negative", "group_by": "sku"}))
    assert report["summary"]["profit"] == "-47.00"
    assert len(report["rows"]) == 1
    assert report["rows"][0]["profit"] == report["summary"]["profit"]
    empty = analytics(session, parse_filters({"status": "high_refund"}))
    assert empty["summary"]["sales"] == "0.00"


def test_preview_expiry_does_not_write(session):
    from app.models import OperationPreview

    preview = make_preview(
        session,
        "cost",
        {
            "sku_ids": ["sku1"],
            "scope": "base",
            "unit_cost": "110",
            "effective_from": "2026-10-01",
            "note": "过期测试",
        },
    )
    session.get(OperationPreview, preview["preview_id"]).expires_at = "2000-01-01T00:00:00.000000Z"
    session.commit()
    with pytest.raises(BusinessError, match="已过期"):
        commit_operation(session, preview["preview_id"], "expired-key")
    assert session.scalar(select(func.count()).select_from(CostVersion)) == 3


def test_sqlite_immediate_lock_timeout_rolls_back_without_partial_write(session):
    from sqlalchemy.exc import OperationalError

    engine = session.get_bind()
    session.commit()
    with engine.connect() as first, engine.connect() as second:
        first.info["write_transaction"] = True
        second.info["write_transaction"] = True
        second.connection.driver_connection.execute("PRAGMA busy_timeout=25")
        try:
            with sessionmaker(bind=first)() as writer:
                writer.get(WorkspaceState, "demo")  # BEGIN IMMEDIATE acquires the writer slot.
                with sessionmaker(bind=second)() as blocked:
                    with pytest.raises(OperationalError, match="locked"):
                        blocked.get(WorkspaceState, "demo")
                    blocked.rollback()
                writer.rollback()
            # Retry succeeds after the owner releases the lock.
            with sessionmaker(bind=second)() as retry:
                assert retry.get(WorkspaceState, "demo").revision == 1
                retry.rollback()
        finally:
            first.info.pop("write_transaction", None)
            second.info.pop("write_transaction", None)
            second.connection.driver_connection.execute("PRAGMA busy_timeout=5000")
    assert session.scalar(select(func.count()).select_from(CostVersion)) == 3


def test_concurrent_cost_commits_accept_one_revision(session):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Barrier

    engine = session.get_bind()
    payload = {
        "sku_ids": ["sku1"],
        "scope": "base",
        "unit_cost": "110",
        "effective_from": "2026-10-01",
        "note": "并发版本测试",
    }
    first = make_preview(session, "cost", payload)
    second = make_preview(session, "cost", dict(payload, unit_cost="120"))
    session.commit()
    barrier = Barrier(2)

    def worker(preview, key):
        with engine.connect() as connection:
            connection.info["write_transaction"] = True
            try:
                with sessionmaker(bind=connection)() as transaction:
                    barrier.wait(timeout=3)
                    with transaction.begin():
                        return commit_operation(transaction, preview["preview_id"], key)["revision"]
            except BusinessError as error:
                return error.code
            finally:
                connection.info.pop("write_transaction", None)

    with ThreadPoolExecutor(max_workers=2) as pool:
        a = pool.submit(worker, first, "concurrent-a")
        b = pool.submit(worker, second, "concurrent-b")
        results = [a.result(timeout=10), b.result(timeout=10)]
    assert sorted(map(str, results)) == ["2", "stale_preview"]
    session.expire_all()
    assert session.scalar(select(func.count()).select_from(CostVersion)) == 4


def test_sqlite_rejects_fractional_fees_and_oversized_scaled_values(session):
    with pytest.raises(IntegrityError):
        session.execute(text("UPDATE order_lines SET advertising_fee_minor = 1.25 WHERE id = 'line1'"))
    session.rollback()
    with pytest.raises(IntegrityError):
        session.execute(
            text("UPDATE cost_versions SET unit_cost_scaled = 100000000000001 WHERE id = 'base1'")
        )
    session.rollback()
    assert session.get(OrderLine, "line1").advertising_fee_minor == 1500


def test_recalculation_preview_reports_subset_coverage(session):
    line = session.get(OrderLine, "line1")
    line.accounting_status = "missing_cost"
    line.cost_minor = None
    session.flush()
    preview = make_preview(
        session, "recalculation", {"start": "2026-09-01", "end": "2026-09-01", "only_missing": True}
    )
    summary = preview["summary"]
    assert summary["old_coverage"] == "0.00000000"
    assert summary["new_coverage"] == "1.00000000"
    assert summary["old_missing_lines"] == 1
    assert summary["new_missing_lines"] == 0


def test_cost_summary_separates_base_and_inherited_coverage(session):
    from app.operations import cost_list

    session.get(CostVersion, "base1").effective_to = canonical_time("2026-09-01")
    session.flush()
    report = cost_list(session, parse_filters({"channel_ids": "temu"}))
    assert report["summary"]["base_coverage"] == "0.00000000"
    assert report["summary"]["coverage"] == "1.00000000"
    assert report["items"][0]["unit_cost"] == "120.0000"


def test_non_demo_mode_rejects_reset_without_opening_database(monkeypatch):
    from fastapi.testclient import TestClient
    from app.main import app

    monkeypatch.setenv("APP_MODE", "production")
    with TestClient(app) as client:
        response = client.post("/api/v1/demo/reset", json={"confirm": True})
    assert response.status_code == 403
    assert response.json()["code"] == "demo_mode_required"
    assert response.json()["request_id"] == response.headers["x-request-id"]


def test_expense_evidence_preserves_source_allocations_when_sku_filtered(session):
    from app.analytics import expense_list
    from app.domain import allocate_expenses

    session.add(StandardSku(id="sku2", product_id="p1", spec="第二款"))
    session.flush()
    session.add(
        OrderLine(
            id="line2",
            order_id="order1",
            platform_sku="0002",
            sku_id="sku2",
            revenue_minor=10000,
            cost_minor=5000,
            quantity_scaled=10000,
            accounting_status="complete",
        )
    )
    session.add(
        ExpenseEntry(
            id="daily-ad",
            store_id="store1",
            business_date="2026-09-01",
            expense_type="advertising",
            amount_minor=1001,
        )
    )
    session.flush()
    allocate_expenses(session)
    report = expense_list(session, parse_filters({"kind": "advertising", "sku_ids": "sku1"}))
    assert report["total"] == 1
    assert report["items"][0]["source_amount"] == "10.01"
    assert report["items"][0]["allocated_amount"] == "6.67"
    assert (
        report["summary"]["allocated_amount"]
        == grouped(session, parse_filters({"sku_ids": "sku1"}))[0]["advertising_fee"]
    )
    second = expense_list(session, parse_filters({"kind": "advertising", "sku_ids": "sku2"}))
    assert second["items"][0]["allocated_amount"] == "3.34"
    assert report["items"][0]["allocated_amount"] != report["items"][0]["source_amount"]


def test_weekly_sql_trend_preserves_money_distinct_orders_and_clips_periods(session):
    session.add(
        OrderLine(
            id="line-extra",
            order_id="order1",
            platform_sku="0001",
            sku_id="sku1",
            revenue_minor=10000,
            cost_minor=5000,
            quantity_scaled=10000,
            accounting_status="complete",
        )
    )
    session.add(
        Order(
            id="order-week2",
            platform_order_no="000002",
            channel_id="temu",
            store_id="store1",
            paid_at=canonical_time("2026-09-08T12:00:00+08:00"),
            business_date="2026-09-08",
            status="paid",
            currency="CNY",
            fx_rate_scaled=100000000,
            fx_date="2026-09-08",
        )
    )
    session.flush()
    session.add(
        OrderLine(
            id="line-week2",
            order_id="order-week2",
            platform_sku="0001",
            sku_id="sku1",
            revenue_minor=30000,
            cost_minor=9000,
            quantity_scaled=10000,
            accounting_status="complete",
        )
    )
    session.add(
        ExpenseEntry(
            id="unallocated-week1",
            store_id="store1",
            business_date="2026-09-02",
            expense_type="advertising",
            amount_minor=320,
            allocated=False,
        )
    )
    session.flush()
    report = analytics(
        session, parse_filters({"start": "2026-09-01", "end": "2026-09-09", "trend_grain": "week"})
    )
    assert [(row["date"], row["end_date"]) for row in report["trend"]] == [
        ("2026-09-01", "2026-09-06"),
        ("2026-09-07", "2026-09-09"),
    ]
    assert [row["orders"] for row in report["trend"]] == [1, 1]
    for key in ["sales", "revenue", "refunds", "profit", "advertising_fee"]:
        assert sum(Decimal(row[key]) for row in report["trend"]) == Decimal(report["summary"][key])
    assert report["channel_trends"][0]["id"] == "temu"
    assert report["channel_trends"][0]["trend"] == report["trend"]
    assert report["store_rankings"][0]["id"] == "store1"
    assert report["store_rankings"][0]["previous_revenue"] == "0.00"
    assert "600.00" in report["summary"]["narrative"]
    assert report["trend_grain"] == "week"


def test_refund_server_sort_full_evidence_and_daily_total_before_pagination(session):
    from app.analytics import refund_list

    for refund_id, amount, day in [("small", 1000, "2026-09-04"), ("large", 5000, "2026-09-05")]:
        session.add(
            RefundEvent(
                id=refund_id,
                order_line_id="line1",
                completed_at=canonical_time(day),
                business_date=day,
                amount_minor=amount,
                original_amount=f"{Decimal(amount) / 100:.2f}",
                refund_type="refund_only",
            )
        )
    session.flush()
    report = refund_list(session, parse_filters({"sort_by": "amount", "sort_dir": "desc", "page_size": "1"}))
    assert report["items"][0]["id"] == "large"
    assert report["total"] == 2
    assert report["items"][0]["paid_date"] == "2026-09-01"
    assert report["items"][0]["line_sales"] == "200.00"
    assert report["items"][0]["line_refunds"] == "60.00"
    assert report["items"][0]["remaining_refundable"] == "140.00"
    assert report["items"][0]["original_cost_snapshot"] == "115.00"
    assert report["items"][0]["unit_cost_snapshot"] == "115.0000"
    assert report["items"][0]["cost_source"] == "store"
    assert report["summary"]["by_day"] == [
        {"date": "2026-09-04", "amount": "10.00"},
        {"date": "2026-09-05", "amount": "50.00"},
    ]
    ascending = refund_list(
        session, parse_filters({"sort_by": "amount", "sort_dir": "asc", "page_size": "1"})
    )
    assert ascending["items"][0]["id"] == "small"


def test_change_history_filters_audit_scope_and_shares_full_export_query(session):
    from app.operations import change_list

    session.add(Store(id="store2", channel_id="temu", name="Temu B"))
    session.flush()
    for scope, scope_id, note in [("base", "base", "基础采购调整"), ("store", "store1", "店铺专属调整")]:
        preview = make_preview(
            session,
            "cost",
            {
                "sku_ids": ["sku1"],
                "scope": scope,
                "scope_id": scope_id,
                "unit_cost": "125",
                "effective_from": "2026-10-01",
                "note": note,
            },
        )
        commit_operation(session, preview["preview_id"], "history-" + scope)
    # Audit operations took place now; selected historical sales dates do not hide them.
    all_data = change_list(
        session,
        parse_filters(
            {
                "start": "2000-01-01",
                "end": "2000-01-02",
                "sku_ids": "sku1",
                "sort_by": "id",
                "sort_dir": "asc",
                "page_size": "1",
            }
        ),
    )
    assert all_data["total"] == 2
    assert len(all_data["items"]) == 1
    exported = change_list(
        session,
        parse_filters({"sku_ids": "sku1", "sort_by": "id", "sort_dir": "asc", "page_size": "1"}),
        all_rows=True,
    )
    assert len(exported["items"]) == 2
    assert exported["items"][0]["id"] == all_data["items"][0]["id"]
    store2 = change_list(session, parse_filters({"store_ids": "store2"}))
    assert store2["total"] == 1
    assert store2["items"][0]["note"] == "基础采购调整"
    by_note = change_list(session, parse_filters({"search": "店铺专属"}))
    assert by_note["total"] == 1
    assert by_note["items"][0]["sku_id"] == "sku1"
    assert change_list(session, parse_filters({"channel_ids": "another-channel"}))["total"] == 1
    assert change_list(session, parse_filters({"sku_ids": "not-existing"}))["total"] == 0
