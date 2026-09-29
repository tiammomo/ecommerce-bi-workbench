import csv
import hashlib
import io
import json
import logging
import os
import time
from pathlib import Path
from uuid import uuid4

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError, OperationalError
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException

from .analytics import analytics, grouped, order_list, parse_filters, refund_list, sort_rows, targets
from .db import ROOT, engine, get_session, write_session
from .domain import BusinessError, money, now, scaled
from .imports import router as imports_router
from .models import (
    Channel,
    CostVersion,
    ListingMapping,
    OperationRecord,
    Product,
    SalesTarget,
    SavedReportView,
    StandardSku,
    Store,
    WorkspaceState,
)
from .operations import (
    commit_operation,
    cost_list,
    difference,
    make_preview,
    recalc_candidates,
    state,
    uid,
    version_json,
)
from .schemas import (
    AnalyticsResponse,
    CommitRequest,
    CostPreviewRequest,
    MappingRequest,
    RecalculationRequest,
    ReportViewRequest,
    SimulationRequest,
    TargetRequest,
)

app = FastAPI(
    title="多渠道经营工作台 API",
    version="0.1.0",
    description="本地单工作区演示。金额均为人民币十进制字符串，所有费率与汇率均为虚构演示假设。",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        value.strip()
        for value in os.getenv("ALLOWED_ORIGINS", "http://127.0.0.1:5173,http://localhost:5173").split(",")
        if value.strip()
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)
logger = logging.getLogger("workbench")
logging.basicConfig(level=getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO))


@app.middleware("http")
async def request_log(request, call_next):
    request_id = uuid4().hex[:12]
    request.state.request_id = request_id
    start = time.perf_counter()
    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    logger.info(
        json.dumps(
            {
                "request_id": request_id,
                "method": request.method,
                "path": request.url.path,
                "status": response.status_code,
                "duration_ms": round((time.perf_counter() - start) * 1000, 2),
            },
            ensure_ascii=False,
        )
    )
    return response


@app.exception_handler(BusinessError)
def business_error(request, exc):
    return JSONResponse(
        status_code=exc.status,
        content={
            "request_id": getattr(request.state, "request_id", None),
            "code": exc.code,
            "message": exc.message,
            "details": exc.details,
        },
    )


@app.exception_handler(RequestValidationError)
def validation_error(request, exc):
    return JSONResponse(
        status_code=422,
        content={
            "request_id": getattr(request.state, "request_id", None),
            "code": "validation_error",
            "message": "请求参数不正确，请检查输入",
            "details": json.loads(json.dumps(exc.errors(), default=str)),
        },
    )


@app.exception_handler(OperationalError)
def database_error(request, exc):
    return JSONResponse(
        status_code=503,
        content={
            "request_id": getattr(request.state, "request_id", None),
            "code": "database_busy",
            "message": "数据库暂时繁忙，请稍后重试；操作未部分提交。",
        },
    )


@app.exception_handler(IntegrityError)
def integrity_error(request, exc):
    return JSONResponse(
        status_code=409,
        content={
            "request_id": getattr(request.state, "request_id", None),
            "code": "integrity_conflict",
            "message": "数据引用或唯一键冲突，操作已回滚，请重新检查。",
        },
    )


@app.exception_handler(HTTPException)
def http_error(request, exc):
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "request_id": getattr(request.state, "request_id", None),
            "code": "not_found" if exc.status_code == 404 else "http_error",
            "message": str(exc.detail),
        },
    )


def filters(request: Request):
    return parse_filters(dict(request.query_params))


@app.get("/health/live")
@app.get("/api/v1/health/live")
def live():
    return {"status": "ok"}


@app.get("/health/ready")
@app.get("/api/v1/health/ready")
def ready():
    try:
        with engine.connect() as connection:
            revision = connection.execute(text("SELECT version_num FROM alembic_version")).scalar_one()
            workspace = connection.execute(select(WorkspaceState.dataset_version)).scalar_one_or_none()
            if not workspace or revision != "0002_precision":
                raise ValueError("not initialized")
        return {"status": "ready", "migration": revision, "dataset_version": workspace}
    except Exception:
        return JSONResponse(
            status_code=503,
            content={"code": "not_initialized", "message": "请先执行数据库迁移与演示数据初始化。"},
        )


@app.get("/api/v1/meta")
def metadata(session: Session = Depends(get_session)):
    workspace = session.get(WorkspaceState, "demo")
    return {
        "channels": [
            {"id": c.id, "name": c.name, "color": c.color} for c in session.scalars(select(Channel))
        ],
        "stores": [
            {
                "id": s.id,
                "name": s.name,
                "channel_id": s.channel_id,
                "site": s.market,
                "market": s.market,
                "mode": s.mode,
                "currency": s.currency,
                "timezone": s.timezone,
            }
            for s in session.scalars(select(Store))
        ],
        "products": [
            {"id": p.id, "name": p.name, "category": p.category} for p in session.scalars(select(Product))
        ],
        "skus": [
            {
                "id": sku.id,
                "product_id": sku.product_id,
                "name": p.name,
                "spec": sku.spec,
                "category": p.category,
            }
            for sku, p in session.execute(select(StandardSku, Product).join(Product))
        ],
        "as_of": "2026-09-28",
        "revision": workspace.revision if workspace else 0,
        "timezone": "Asia/Shanghai",
        "dataset_version": workspace.dataset_version if workspace else "",
        "actor": "演示操作人",
        "currency": "CNY",
    }


@app.get("/api/v1/analytics", response_model=AnalyticsResponse)
def get_analytics(params=Depends(filters), session: Session = Depends(get_session)):
    return analytics(session, params)


@app.get("/api/v1/orders")
def get_orders(params=Depends(filters), session: Session = Depends(get_session)):
    return order_list(session, params)


@app.get("/api/v1/refunds")
def get_refunds(params=Depends(filters), session: Session = Depends(get_session)):
    return refund_list(session, params)


@app.get("/api/v1/costs")
def get_costs(params=Depends(filters), session: Session = Depends(get_session)):
    return cost_list(session, params)


@app.get("/api/v1/costs/changes")
def changes(params=Depends(filters), session: Session = Depends(get_session)):
    from .operations import change_list

    return change_list(session, params)


@app.get("/api/v1/costs/{sku_id}/history")
def cost_history(sku_id: str, session: Session = Depends(get_session)):
    return {
        "items": [
            version_json(c)
            for c in session.scalars(
                select(CostVersion)
                .where(CostVersion.sku_id == sku_id)
                .order_by(CostVersion.effective_from.desc())
            )
        ]
    }


@app.post("/api/v1/costs/preview")
def preview_cost(payload: CostPreviewRequest):
    with write_session() as session:
        return make_preview(session, "cost", payload.model_dump())


@app.post("/api/v1/costs/simulate")
def simulate_cost(payload: SimulationRequest, session: Session = Depends(get_session)):
    unit = scaled(payload.unit_cost, 10000, 4)
    if unit < 0:
        raise BusinessError("试算成本不能为负")
    return difference(session, recalc_candidates(session, payload.model_dump()), unit_override=unit)


@app.post("/api/v1/recalculations/preview")
def preview_recalculation(payload: RecalculationRequest):
    with write_session() as session:
        return make_preview(session, "recalculation", payload.model_dump())


@app.post("/api/v1/operations/commit")
@app.post("/api/v1/costs/commit")
@app.post("/api/v1/recalculations/commit")
def commit(payload: CommitRequest):
    with write_session() as session:
        return commit_operation(session, payload.preview_id, payload.idempotency_key, payload.revision)


@app.get("/api/v1/operations")
def operations(session: Session = Depends(get_session)):
    return {
        "items": [
            {
                "id": o.id,
                "operation_type": o.operation_type,
                "result": json.loads(o.result_json),
                "actor": o.actor,
                "created_at": o.created_at,
            }
            for o in session.scalars(
                select(OperationRecord).order_by(OperationRecord.created_at.desc()).limit(100)
            )
        ]
    }


@app.get("/api/v1/operations/{operation_id}")
def get_operation(operation_id: str, session: Session = Depends(get_session)):
    operation = session.get(OperationRecord, operation_id)
    if not operation:
        raise BusinessError("操作不存在", "not_found", 404)
    return json.loads(operation.result_json)


@app.get("/api/v1/mappings")
def mappings(request: Request, session: Session = Depends(get_session)):
    q = select(ListingMapping)
    if request.query_params.get("status"):
        q = q.where(ListingMapping.status == request.query_params["status"])
    return {
        "items": [
            {
                "id": m.id,
                "store_id": m.store_id,
                "platform_sku": m.platform_sku,
                "sku_id": m.sku_id,
                "unit_factor": str(m.factor_scaled / 10000),
                "sales_unit": m.sales_unit,
                "status": m.status,
            }
            for m in session.scalars(q)
        ]
    }


@app.post("/api/v1/mappings/preview")
def preview_mapping(payload: MappingRequest):
    with write_session() as session:
        return make_preview(session, "mapping", payload.model_dump())


@app.get("/api/v1/targets")
def get_targets(request: Request, params=Depends(filters), session: Session = Depends(get_session)):
    return {"items": targets(session, params, request.query_params.get("month"))}


@app.put("/api/v1/targets/{store_id}/{month}")
def put_target(store_id: str, month: str, payload: TargetRequest):
    from datetime import date

    try:
        date.fromisoformat(month + "-01")
    except ValueError:
        raise BusinessError("月份必须使用 YYYY-MM") from None
    amount = scaled(payload.target, 100, 2)
    if amount < 0:
        raise BusinessError("月度目标不能为负")
    digest = hashlib.sha256(json.dumps([store_id, month, amount]).encode()).hexdigest()
    with write_session() as session:
        existing = session.scalar(
            select(OperationRecord).where(OperationRecord.idempotency_key == payload.idempotency_key)
        )
        if existing:
            if existing.request_digest != digest:
                raise BusinessError("幂等标识已用于其他请求", "idempotency_conflict", 409)
            return json.loads(existing.result_json)
        if not session.get(Store, store_id):
            raise BusinessError("店铺不存在")
        target = session.scalar(
            select(SalesTarget).where(SalesTarget.store_id == store_id, SalesTarget.month == month)
        )
        if target:
            target.amount_minor = amount
        else:
            session.add(
                SalesTarget(id=f"{store_id}:{month}", store_id=store_id, month=month, amount_minor=amount)
            )
        revision = state(session)
        revision.revision += 1
        result = {
            "store_id": store_id,
            "month": month,
            "target": money(amount),
            "revision": revision.revision,
        }
        session.add(
            OperationRecord(
                id=uid("op"),
                idempotency_key=payload.idempotency_key,
                request_digest=digest,
                operation_type="target",
                result_json=json.dumps(result),
                created_at=now(),
            )
        )
        return result


def view_json(v):
    return {
        "id": v.id,
        "name": v.name,
        "report_type": v.report_type,
        "filters": json.loads(v.filters_json),
        "columns": json.loads(v.columns_json),
        "sort": json.loads(v.sort_json),
    }


@app.get("/api/v1/reports/views")
def report_views(session: Session = Depends(get_session)):
    return {
        "items": [
            view_json(v)
            for v in session.scalars(select(SavedReportView).order_by(SavedReportView.created_at.desc()))
        ]
    }


@app.post("/api/v1/reports/views")
def create_report(payload: ReportViewRequest):
    with write_session() as session:
        v = SavedReportView(
            id=uid("view"),
            name=payload.name,
            report_type=payload.report_type,
            filters_json=json.dumps(payload.filters, ensure_ascii=False),
            columns_json=json.dumps(payload.columns),
            sort_json=json.dumps(payload.sort),
            created_at=now(),
        )
        session.add(v)
        state(session).revision += 1
        return view_json(v)


@app.patch("/api/v1/reports/views/{view_id}")
def patch_report(view_id: str, payload: dict):
    with write_session() as session:
        v = session.get(SavedReportView, view_id)
        if not v:
            raise BusinessError("报表视图不存在", "not_found", 404)
        if "name" in payload:
            if not str(payload["name"]).strip():
                raise BusinessError("请输入报表名称")
            v.name = str(payload["name"])[:100]
        for key in ["filters", "columns", "sort"]:
            if key in payload:
                setattr(v, key + "_json", json.dumps(payload[key], ensure_ascii=False))
        state(session).revision += 1
        return view_json(v)


@app.delete("/api/v1/reports/views/{view_id}")
def delete_report(view_id: str):
    with write_session() as session:
        v = session.get(SavedReportView, view_id)
        if not v:
            raise BusinessError("报表视图不存在", "not_found", 404)
        session.delete(v)
        state(session).revision += 1
        return {"deleted": True}


def csv_response(rows, filename):
    output = io.StringIO(newline="")
    if rows:
        fields = list(rows[0])
        writer = csv.DictWriter(output, fields, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            safe = {}
            for k, value in row.items():
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False)
                # Exact numeric fields stay numeric; protect user-controlled labels and IDs.
                if isinstance(value, str) and value.startswith(("=", "+", "-", "@", "\t", "\r")):
                    try:
                        from decimal import Decimal

                        Decimal(value)
                    except Exception:
                        value = "'" + value
                safe[k] = value
            writer.writerow(safe)
    else:
        output.write("说明\r\n当前筛选无数据\r\n")
    return Response(
        ("\ufeff" + output.getvalue()).encode("utf-8"),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@app.get("/api/v1/reports/export")
def export_report(request: Request, params=Depends(filters), session: Session = Depends(get_session)):
    report_type = request.query_params.get("report_type", "channels")
    if report_type == "orders":
        rows = order_list(session, params, all_rows=True)["items"]
    elif report_type == "refunds":
        rows = refund_list(session, params, all_rows=True)["items"]
    elif report_type == "costs":
        rows = cost_list(session, dict(params, page=1, page_size=10000))["items"]
    elif report_type in ("changes", "cost_changes"):
        from .operations import change_list

        rows = change_list(session, params, all_rows=True)["items"]
    else:
        group = {"channels": "channel", "stores": "store", "products": "sku", "daily": "day"}.get(report_type)
        if report_type == "products":
            requested_group = params.get("group_by", "sku")
            if requested_group in ("sku", "product", "listing"):
                group = requested_group
        if not group:
            raise BusinessError("未知报表类型")
        from .analytics import expand_status

        params = expand_status(session, params)
        rows = sort_rows(grouped(session, params, group), params)
    for row in rows:
        row.update(
            currency_basis="CNY",
            accounting_basis="实际审计时间；不受销售期间筛选影响"
            if report_type in ("changes", "cost_changes")
            else "支付订单归属口径"
            if params.get("date_basis") != "refund"
            else "退款发生时间口径",
            data_as_of="2026-09-28",
        )
    return csv_response(rows, f"{report_type}-{params['start']}-{params['end']}.csv")


@app.get("/api/v1/expenses")
def expenses(params=Depends(filters), session: Session = Depends(get_session)):
    from .analytics import expense_list

    return expense_list(session, params)


@app.post("/api/v1/demo/reset")
def reset_demo(payload: dict):
    if os.getenv("APP_MODE", "demo") != "demo":
        raise BusinessError("当前运行模式不允许恢复演示数据", "demo_mode_required", 403)
    if payload.get("confirm") is not True:
        raise BusinessError("请明确确认恢复演示工作区；业务修改和保存视图将被重置。")
    from .seed import reset_demo

    with write_session() as session:
        return reset_demo(session)


# Seed and CSV exchange implementation is kept separate from reporting.
app.include_router(imports_router)

WEB_DIST = ROOT / "apps/web/dist"


@app.get("/{path:path}", include_in_schema=False)
def frontend(path: str):
    if path.startswith("api/") or path.startswith("health/"):
        raise HTTPException(404, "API 不存在")
    target = (WEB_DIST / path).resolve()
    if not target.is_relative_to(WEB_DIST.resolve()):
        raise HTTPException(404, "资源不存在")
    if target.is_file():
        return FileResponse(target)
    if Path(path).suffix or path.startswith("assets/"):
        raise HTTPException(404, "静态资源不存在")
    if (WEB_DIST / "index.html").is_file():
        return FileResponse(WEB_DIST / "index.html")
    raise HTTPException(404, "前端尚未构建，请运行开发服务或构建前端。")
