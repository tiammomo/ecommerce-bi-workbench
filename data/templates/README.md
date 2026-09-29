# 标准 CSV 模板 v1

CSV 是交换格式，查询始终读取 SQLite。金额以元为单位，使用无千分位十进制字符串。
输入支持 UTF-8 / UTF-8 BOM；使用 CSV 引号转义逗号、换行及双引号。编码按文本保留前导零。
按依赖顺序提交多个文件；单文件最多20MB，单批最多80MB或100000行。整个批次成功或整体回滚。
完全相同的原始记录跳过，同业务键不同内容阻断。预览30分钟有效，期间业务修订号变化必须重新预览。
新成本只影响以后形成的订单快照。历史补全使用独立重算；零成本说明须以 `确认零成本：` 开头。
平台 `quantity` 乘 `factor` 得到标准单位数量；退款 `quantity` 和 `recoverable_quantity` 已为标准单位。
`paid_at`/`completed_at` 必须带时区；未支付/待处理记录仍保留记录时间，通过状态从财务指标排除。
`scope` 为 base/channel/store，基础成本的 `scope_id` 必须为 base；有效区间左闭右开。
`expenses.amount_original` 允许负数，代表明确费用退回调整；其他金额不允许负值。
待关联或缺失成本/汇率记录保留为待核算，必需外键缺失则阻断。
渠道/店铺等 ID 为跨文件稳定编码。`data/examples` 是互相关联的小样例，演示库中重复导入会跳过。
展示报表 CSV 会保护公式型文本且不承诺可回导；本目录标准模板CSV保留原始编码，可回导。

## channels.csv — 销售渠道

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| name | text | 是 | 参见业务规则；编码按文本读取 |
| color | text | 是 | 参见业务规则；编码按文本读取 |

## stores.csv — 店铺

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| channel_id | text | 是 | 参见业务规则；编码按文本读取 |
| name | text | 是 | 参见业务规则；编码按文本读取 |
| market | text | 是 | 参见业务规则；编码按文本读取 |
| mode | text | 是 | 参见业务规则；编码按文本读取 |
| currency | text | 是 | 参见业务规则；编码按文本读取 |
| timezone | text | 是 | 参见业务规则；编码按文本读取 |

## products.csv — 标准商品

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| name | text | 是 | 参见业务规则；编码按文本读取 |
| category | text | 是 | 参见业务规则；编码按文本读取 |
| series | text | 是 | 参见业务规则；编码按文本读取 |

## skus.csv — 标准 SKU

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| product_id | text | 是 | 参见业务规则；编码按文本读取 |
| spec | text | 是 | 参见业务规则；编码按文本读取 |
| unit | text | 是 | 参见业务规则；编码按文本读取 |

## mappings.csv — 平台 SKU 映射

业务唯一键：`store_id + platform_sku`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| store_id | text | 是 | 参见业务规则；编码按文本读取 |
| platform_product_id | text | 是 | 参见业务规则；编码按文本读取 |
| platform_sku | text | 是 | 参见业务规则；编码按文本读取 |
| sku_id | text | 否 | 参见业务规则；编码按文本读取 |
| unit | text | 是 | 参见业务规则；编码按文本读取 |
| factor | quantity | 是 | 平台单位到标准单位倍数，最多4位小数 |
| status | text | 是 | 参见业务规则；编码按文本读取 |

## fx_rates.csv — 演示汇率

业务唯一键：`currency + date`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| currency | text | 是 | 参见业务规则；编码按文本读取 |
| date | date | 是 | 参见业务规则；编码按文本读取 |
| rate | rate | 是 | 1单位原币兑人民币，最多8位小数 |
| source | text | 是 | 参见业务规则；编码按文本读取 |

## costs.csv — 成本版本

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| sku_id | text | 是 | 参见业务规则；编码按文本读取 |
| scope | text | 是 | 参见业务规则；编码按文本读取 |
| scope_id | text | 是 | 参见业务规则；编码按文本读取 |
| unit_cost | cost | 是 | 人民币元/标准单位，最多4位小数 |
| valid_from | datetime | 是 | 参见业务规则；编码按文本读取 |
| valid_to | datetime | 否 | 参见业务规则；编码按文本读取 |
| note | text | 是 | 参见业务规则；编码按文本读取 |

## orders.csv — 订单

业务唯一键：`channel_id + store_id + platform_order_id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| platform_order_id | text | 是 | 参见业务规则；编码按文本读取 |
| channel_id | text | 是 | 参见业务规则；编码按文本读取 |
| store_id | text | 是 | 参见业务规则；编码按文本读取 |
| paid_at | datetime | 否 | 参见业务规则；编码按文本读取 |
| status | text | 是 | 参见业务规则；编码按文本读取 |
| currency | text | 是 | 参见业务规则；编码按文本读取 |
| fx_rate | rate | 否 | 参见业务规则；编码按文本读取 |

## order_lines.csv — 订单行

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| order_id | text | 是 | 参见业务规则；编码按文本读取 |
| platform_sku | text | 是 | 参见业务规则；编码按文本读取 |
| sku_id | text | 否 | 参见业务规则；编码按文本读取 |
| quantity | quantity | 是 | 参见业务规则；编码按文本读取 |
| factor | quantity | 是 | 参见业务规则；编码按文本读取 |
| revenue_original | money | 是 | 优惠后应收商品金额，原币元，最多2位小数 |

## refunds.csv — 退款事件

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| line_id | text | 是 | 参见业务规则；编码按文本读取 |
| completed_at | datetime | 否 | 参见业务规则；编码按文本读取 |
| amount_original | money | 是 | 参见业务规则；编码按文本读取 |
| kind | text | 是 | 参见业务规则；编码按文本读取 |
| reason | text | 是 | 参见业务规则；编码按文本读取 |
| quantity | quantity | 是 | 参见业务规则；编码按文本读取 |
| recoverable_quantity | quantity | 是 | 参见业务规则；编码按文本读取 |
| status | text | 是 | 参见业务规则；编码按文本读取 |

## expenses.csv — 费用记录

业务唯一键：`id`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| store_id | text | 是 | 参见业务规则；编码按文本读取 |
| date | date | 是 | 参见业务规则；编码按文本读取 |
| kind | text | 是 | 参见业务规则；编码按文本读取 |
| amount_original | signed_money | 是 | 参见业务规则；编码按文本读取 |
| currency | text | 是 | 参见业务规则；编码按文本读取 |
| fx_rate | rate | 是 | 参见业务规则；编码按文本读取 |
| order_id | text | 否 | 参见业务规则；编码按文本读取 |
| line_id | text | 否 | 参见业务规则；编码按文本读取 |
| source | text | 是 | 参见业务规则；编码按文本读取 |

## targets.csv — 月度目标

业务唯一键：`store_id + month`；每行还须有唯一 `id`。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| id | text | 是 | 参见业务规则；编码按文本读取 |
| store_id | text | 是 | 参见业务规则；编码按文本读取 |
| month | month | 是 | 参见业务规则；编码按文本读取 |
| amount | money | 是 | 参见业务规则；编码按文本读取 |
