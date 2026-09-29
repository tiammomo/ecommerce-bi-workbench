"""Deterministic source records; these always enter SQLite through the CSV importer."""

from __future__ import annotations

import math
import random
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP

from .csv_spec import SPECS

DATASET_VERSION = "demo-2026-09-28-v1"
DEMO_AS_OF = "2026-09-28T23:59:59+08:00"
START_DATE = date(2026, 4, 2)
END_DATE = date(2026, 9, 28)
TZ = timezone(timedelta(hours=8))


def money(value) -> str:
    return str(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def instant(day: date, hour=12, minute=0) -> str:
    return datetime(day.year, day.month, day.day, hour, minute, tzinfo=TZ).isoformat()


def generate_demo() -> dict[str, list[dict]]:
    randomizer = random.Random(20260928)
    records = {name: [] for name in SPECS}
    records["channels"] = [
        {"id": "pdd", "name": "拼多多", "color": "#F59E0B"},
        {"id": "temu", "name": "Temu", "color": "#3B82F6"},
        {"id": "1688", "name": "阿里 1688", "color": "#14B8A6"},
    ]
    store_names = {
        "pdd": ["栖物家居旗舰店", "栖物生活优选店", "简物厨房专营店"],
        "temu": ["Nestora US", "Nestora EU", "Everyday Living"],
        "1688": ["栖物源头工厂", "简物百货批发", "日常制造供应链"],
    }
    for channel in records["channels"]:
        for index, name in enumerate(store_names[channel["id"]], start=1):
            cid = channel["id"]
            records["stores"].append(
                {
                    "id": f"{cid}-{index}",
                    "channel_id": cid,
                    "name": name,
                    "market": ("美国" if index != 2 else "欧洲") if cid == "temu" else "中国",
                    "mode": "半托管" if cid == "temu" else "商家自营",
                    "currency": "USD" if cid == "temu" else "CNY",
                    "timezone": "America/Los_Angeles" if cid == "temu" else "Asia/Shanghai",
                }
            )
    names = [
        "云朵折叠收纳箱",
        "模块化抽屉分隔板",
        "极简桌面收纳盒",
        "衣柜分层置物架",
        "棉麻衣物收纳袋",
        "透明密封储物罐",
        "旅行衣物整理袋",
        "可叠放鞋盒",
        "硅胶厨房沥水垫",
        "不锈钢多用滤网",
        "防滑隔热锅垫",
        "小麦秸秆餐具套装",
        "磁吸调料收纳架",
        "折叠洗菜沥水篮",
        "竹木切菜板",
        "旋转厨房挂钩",
        "加厚超细纤维毛巾",
        "长柄清洁刷",
        "便携粘毛滚筒",
        "可替换海绵拖把",
        "旅行分装瓶",
        "轻量便携衣架",
        "浴室免打孔置物架",
        "抽绳垃圾分类袋",
    ]
    base_costs = {}
    for product_index, name in enumerate(names, start=1):
        product_id = f"P{product_index:03d}"
        records["products"].append(
            {
                "id": product_id,
                "name": name,
                "category": ["家居收纳", "厨房用品", "日用百货"][(product_index - 1) // 8],
                "series": ["有序生活", "日常厨房", "轻巧日常"][(product_index - 1) // 8],
            }
        )
        for variant_index in range(3):
            sku_number = (product_index - 1) * 3 + variant_index + 1
            sku_id = f"SKU{sku_number:03d}"
            records["skus"].append(
                {
                    "id": sku_id,
                    "product_id": product_id,
                    "spec": ["奶油白 / 标准款", "雾灰色 / 标准款", "奶油白 / 加大款"][variant_index],
                    "unit": "件",
                }
            )
            base = Decimal(str(8 + (product_index * 7) % 31 + variant_index * 3))
            base_costs[sku_id] = base
            if sku_id not in {"SKU070", "SKU071"}:
                if sku_id == "SKU004":
                    records["costs"].extend(
                        [
                            {
                                "id": "C-BASE-SKU004-V1",
                                "sku_id": sku_id,
                                "scope": "base",
                                "scope_id": "base",
                                "unit_cost": str(base),
                                "valid_from": instant(START_DATE, 0),
                                "valid_to": instant(date(2026, 9, 10), 0),
                                "note": "演示历史采购成本",
                            },
                            {
                                "id": "C-BASE-SKU004-V2",
                                "sku_id": sku_id,
                                "scope": "base",
                                "scope_id": "base",
                                "unit_cost": str(base * Decimal("1.28")),
                                "valid_from": instant(date(2026, 9, 10), 0),
                                "valid_to": "",
                                "note": "演示：原料采购成本上调28%",
                            },
                        ]
                    )
                else:
                    records["costs"].append(
                        {
                            "id": f"C-BASE-{sku_id}",
                            "sku_id": sku_id,
                            "scope": "base",
                            "scope_id": "base",
                            "unit_cost": str(base),
                            "valid_from": instant(START_DATE, 0),
                            "valid_to": "",
                            "note": "演示基础采购成本",
                        }
                    )
                if sku_number <= 12:
                    records["costs"].append(
                        {
                            "id": f"C-TEMU-{sku_id}",
                            "sku_id": sku_id,
                            "scope": "channel",
                            "scope_id": "temu",
                            "unit_cost": str(base * Decimal("1.12")),
                            "valid_from": instant(START_DATE, 0),
                            "valid_to": "",
                            "note": "演示渠道差异成本，不包含物流",
                        }
                    )
                if sku_number <= 6:
                    records["costs"].append(
                        {
                            "id": f"C-TEMU1-{sku_id}",
                            "sku_id": sku_id,
                            "scope": "store",
                            "scope_id": "temu-1",
                            "unit_cost": str(base * Decimal("1.06")),
                            "valid_from": instant(START_DATE, 0),
                            "valid_to": "",
                            "note": "演示店铺批量采购优惠",
                        }
                    )
    for store in records["stores"]:
        for sku in records["skus"]:
            records["mappings"].append(
                {
                    "id": f"MAP-{store['id']}-{sku['id']}",
                    "store_id": store["id"],
                    "platform_product_id": f"{store['id']}-{sku['product_id']}",
                    "platform_sku": f"000{sku['id'][3:]}",
                    "sku_id": sku["id"],
                    "unit": "包（10件）" if store["channel_id"] == "1688" else "件",
                    "factor": "10" if store["channel_id"] == "1688" else "1",
                    "status": "mapped",
                }
            )
        records["mappings"].append(
            {
                "id": f"MAP-{store['id']}-UNMAPPED",
                "store_id": store["id"],
                "platform_product_id": f"{store['id']}-待关联",
                "platform_sku": "009999",
                "sku_id": "",
                "unit": "件",
                "factor": "1",
                "status": "unmapped",
            }
        )
    rates = {}
    for offset in range(180):
        day = START_DATE + timedelta(days=offset)
        rate = Decimal("7.12") + Decimal(offset % 11) / 1000
        rates[day.isoformat()] = rate
        records["fx_rates"].extend(
            [
                {
                    "id": f"FX-CNY-{day}",
                    "currency": "CNY",
                    "date": str(day),
                    "rate": "1.00000000",
                    "source": "本位币",
                },
                {
                    "id": f"FX-USD-{day}",
                    "currency": "USD",
                    "date": str(day),
                    "rate": f"{rate:.8f}",
                    "source": "模拟汇率，非实际行情",
                },
            ]
        )
    # A weighted day distribution has natural variation and modest growth.
    weighted_days = [1 + 0.32 * index / 179 + 0.12 * math.sin(index / 7) for index in range(180)]
    daily_counts = [int(10000 * weight / sum(weighted_days)) for weight in weighted_days]
    for index in range(10000 - sum(daily_counts)):
        daily_counts[179 - index] += 1
    paid_store_daily = defaultdict(Decimal)
    serial = 0
    for offset, order_count in enumerate(daily_counts):
        day = START_DATE + timedelta(days=offset)
        for day_index in range(order_count):
            serial += 1
            # Last thirty days this one store grows revenue while ad/fulfilment costs erode profit.
            weights = [1.65 if offset >= 150 else 1.05, 1, 0.85, 1.2, 0.9, 0.8, 0.65, 0.55, 0.5]
            stores = records["stores"]
            store = randomizer.choices(stores, weights=weights)[0]
            if day == date(2026, 9, 25) and store["id"] == "1688-3":
                store = stores[6]  # Explicit paid-revenue-zero advertising day.
            cid, sid = store["channel_id"], store["id"]
            oid = f"ORD-{serial:06d}"
            status = "unpaid" if serial % 43 == 0 else "paid"
            rate = rates[str(day)] if cid == "temu" else Decimal(1)
            missing_fx = (
                False  # Unknown-FX imports are covered separately; demo sales remain fully convertible.
            )
            records["orders"].append(
                {
                    "id": oid,
                    "platform_order_id": f"{day:%Y%m%d}{day_index // 9:06d}-{day_index % 9}",
                    "channel_id": cid,
                    "store_id": sid,
                    "paid_at": instant(day, 8 + day_index % 15, randomizer.randrange(60)),
                    "status": status,
                    "currency": store["currency"],
                    "fx_rate": "" if missing_fx else str(rate),
                }
            )
            total = Decimal(0)
            line_count = randomizer.choices([1, 2, 3], [0.73, 0.23, 0.04])[0]
            used = set()
            for line_index in range(line_count):
                sku_number = randomizer.choices(
                    list(range(1, 73)), [4 if number <= 12 else 1 for number in range(1, 73)]
                )[0]
                while sku_number in used:
                    sku_number = randomizer.randint(1, 72)
                used.add(sku_number)
                sku_id = f"SKU{sku_number:03d}"
                unmatched = serial % 197 == 0 and line_index == 0
                factor = 10 if cid == "1688" and not unmatched else 1
                quantity = randomizer.choices([1, 2, 3], [0.78, 0.17, 0.05])[0]
                markup = {"pdd": Decimal("1.75"), "temu": Decimal("2.7"), "1688": Decimal("1.48")}[cid]
                price = (
                    base_costs[sku_id] * markup * Decimal(str(randomizer.choice([0.94, 0.98, 1, 1.05, 1.09])))
                )
                if sku_id == "SKU001" and offset >= 150:
                    price *= Decimal("0.84")
                revenue_cny = price * quantity * factor
                original = Decimal(money(revenue_cny / rate))
                actual_cny = Decimal(money(original * rate))
                total += actual_cny
                line_id = f"{oid}-L{line_index + 1}"
                records["order_lines"].append(
                    {
                        "id": line_id,
                        "order_id": oid,
                        "platform_sku": "009999" if unmatched else f"000{sku_number:03d}",
                        "sku_id": "" if unmatched else sku_id,
                        "quantity": str(quantity),
                        "factor": str(factor),
                        "revenue_original": money(original),
                    }
                )
                refund_chance = 0.45 if sku_id == "SKU001" and offset >= 140 else 0.055
                if status == "paid" and not missing_fx and randomizer.random() < refund_chance:
                    lag = randomizer.randint(2, 15)
                    refund_day = min(day + timedelta(days=lag), END_DATE)
                    kind = randomizer.choices(
                        ["refund_only", "return_refund", "cancel_before_shipping"], [0.53, 0.4, 0.07]
                    )[0]
                    full = kind != "refund_only" or randomizer.random() < 0.32
                    amount = original if full else original * Decimal("0.25")
                    recoverable = quantity * factor if kind != "refund_only" else 0
                    records["refunds"].append(
                        {
                            "id": f"REF-{line_id}",
                            "line_id": line_id,
                            "completed_at": instant(refund_day, 23),
                            "amount_original": money(amount),
                            "kind": kind,
                            "reason": "尺寸与预期不符"
                            if sku_id == "SKU001"
                            else randomizer.choice(
                                ["个人原因", "运输破损", "尺寸不合适", "商品瑕疵", "未按时送达"]
                            ),
                            "quantity": str(quantity * factor if full else 0),
                            "recoverable_quantity": str(recoverable),
                            "status": "pending" if serial % 59 == 0 else "completed",
                        }
                    )
            if status == "paid":
                paid_store_daily[(sid, str(day))] += total
                fees = {
                    "platform": total
                    * {"pdd": Decimal("0.035"), "temu": Decimal("0.085"), "1688": Decimal("0.021")}[cid],
                    "packaging": Decimal("2.3") if cid != "1688" else Decimal("6"),
                    "logistics": Decimal("4.8")
                    if cid == "pdd"
                    else Decimal("18")
                    if cid == "temu"
                    else Decimal("12"),
                }
                if sid == "pdd-1" and offset >= 150:
                    fees["logistics"] *= Decimal("2.2")
                for kind, amount in fees.items():
                    records["expenses"].append(
                        {
                            "id": f"EXP-{oid}-{kind}",
                            "store_id": sid,
                            "date": str(day),
                            "kind": kind,
                            "amount_original": money(amount),
                            "currency": "CNY",
                            "fx_rate": "1",
                            "order_id": oid,
                            "line_id": "",
                            "source": "模拟订单履约费用",
                        }
                    )
    for (sid, day), sales in sorted(paid_store_daily.items()):
        fee_rate = Decimal("0.40") if sid == "pdd-1" and day >= "2026-08-30" else Decimal("0.075")
        records["expenses"].append(
            {
                "id": f"EXP-AD-{sid}-{day}",
                "store_id": sid,
                "date": day,
                "kind": "advertising",
                "amount_original": money(sales * fee_rate),
                "currency": "CNY",
                "fx_rate": "1",
                "order_id": "",
                "line_id": "",
                "source": "模拟店铺日广告账单，估算分摊",
            }
        )
    records["expenses"].append(
        {
            "id": "EXP-UNALLOCATED-1688-3-20260925",
            "store_id": "1688-3",
            "date": "2026-09-25",
            "kind": "advertising",
            "amount_original": "320.00",
            "currency": "CNY",
            "fx_rate": "1",
            "order_id": "",
            "line_id": "",
            "source": "演示无销售日广告费用",
        }
    )
    # Same platform order number, different stores: each remains a distinct order.
    for row in records["orders"][:100]:
        row["platform_order_id"] = f"000{row['id'][4:]}"
    first_by_store = {}
    for row in records["orders"]:
        if row["store_id"] not in first_by_store:
            row["platform_order_id"] = "00000001"
            first_by_store[row["store_id"]] = row["id"]
    for store in records["stores"]:
        for month in range(4, 10):
            monthly_sales = sum(
                amount
                for (sid, day), amount in paid_store_daily.items()
                if sid == store["id"] and day.startswith(f"2026-{month:02d}")
            )
            records["targets"].append(
                {
                    "id": f"TARGET-{store['id']}-2026{month:02d}",
                    "store_id": store["id"],
                    "month": f"2026-{month:02d}",
                    "amount": money((monthly_sales * Decimal("1.03")).quantize(Decimal("1000"))),
                }
            )
    return records


SCENARIOS = [
    {
        "id": "sales-up-profit-down",
        "object": "pdd-1 / 栖物家居旗舰店",
        "period": "2026-08-30～2026-09-28",
        "evidence": "订单权重增长，物流费用2.2倍，广告率从7.5%升为40%",
    },
    {
        "id": "cross-channel-sku",
        "object": "SKU001～SKU012",
        "period": "全部180天",
        "evidence": "各渠道价格不同；Temu渠道覆盖，temu-1店铺覆盖；1688包到件系数为10",
    },
    {
        "id": "refund-concentration",
        "object": "SKU001 / 云朵折叠收纳箱",
        "period": "2026-08-20～2026-09-28",
        "evidence": "退款事件集中且促销折价，核验退款及贡献利润",
    },
    {
        "id": "cost-rise",
        "object": "SKU004 / 模块化抽屉分隔板",
        "period": "2026-09-10",
        "evidence": "基础成本22元上涨至28.16元；C-BASE-SKU004-V1/V2；Temu仍优先覆盖",
    },
    {
        "id": "cost-inheritance",
        "object": "SKU001",
        "period": "全部180天",
        "evidence": "temu-1店铺成本15.90，temu-2渠道16.80，pdd-1基础15.00",
    },
    {
        "id": "missing-cost",
        "object": "SKU070、SKU071",
        "period": "全部180天",
        "evidence": "有映射无有效成本，可补齐2026-04-02起生效的成本后显式重算",
    },
    {
        "id": "unmapped",
        "object": "平台 SKU 009999",
        "period": "每第197笔订单首行",
        "evidence": "销售保留，利润待核算；映射维护后历史补全",
    },
    {
        "id": "refund-date-basis",
        "object": "REF- 开头退款事件",
        "period": "支付后2～15天",
        "evidence": "完成日与支付日不同；仅退款成本不转回，可回收退货按历史成本转回",
    },
    {
        "id": "unallocated-expense",
        "object": "1688-3 / EXP-UNALLOCATED-1688-3-20260925",
        "period": "2026-09-25",
        "evidence": "当日无订单，320元广告费用保留未分摊且扣整体与店铺利润",
    },
    {
        "id": "duplicate-platform-number",
        "object": "平台订单号00000001",
        "period": "2026-04-02",
        "evidence": "9家店各自第一笔订单同号但ID、渠道+店铺+原订单号唯一键不同",
    },
]
