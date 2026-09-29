# 多渠道经营工作台

面向经营负责人与渠道运营的 BI 工作台。拼多多、Temu 半托管、1688 三个渠道、多店铺、统一 SKU 分析；包含销售、贡献利润、成本版本、退款、标准 CSV 导入及报表导出。

业务数据为固定模拟数据，统计截至 **2026-09-28**，使用真实 FastAPI 接口与本地 SQLite 持久化。平台费用、汇率、经营表现均为演示假设。

## 启动

准备 Node.js 22.12+、pnpm、Python 3.11+ 和 uv，然后在项目根目录执行。项目用 `.nvmrc` 固定本次验证的 Node.js 24.14.0，用 `apps/api/.python-version` 固定 Python 3.14.3；`uv sync` 按此版本准备 Python 环境。

```bash
python3 scripts/setup.py
pnpm dev
```

默认页面地址为 <http://127.0.0.1:5173>，API 文档为 <http://127.0.0.1:8000/docs>。初始化脚本安装依赖、执行迁移、生成并导入演示 CSV、导出 API 类型；重复 seed 保留既有业务修改。开发启动脚本只管理自己创建的进程。

如果默认端口已被占用，可执行 `WEB_PORT=5174 pnpm dev`，并打开 <http://127.0.0.1:5174>。

端口可通过 `API_PORT`、`WEB_PORT` 调整。服务默认仅监听本机。示例：

```bash
API_PORT=8001 WEB_PORT=5174 pnpm dev
```

构建后使用单一后端进程提供页面和 API：

```bash
pnpm build
python3 scripts/serve.py
```

此时打开 <http://127.0.0.1:8000>。SQLite 不需要单独启动。

## 页面与分析路径

| 页面 | 主要能力 |
|---|---|
| 经营总览 | 销售与利润 KPI、趋势、渠道贡献、经营异常与目标 |
| 渠道对比 | 三渠道的销售、贡献利润、费用与店铺下钻 |
| 店铺分析 | 店铺排名、经营表现、明细与月度目标 |
| 商品分析 | 统一 SKU、多渠道对比、商品表现与映射 |
| 利润与费用 | 利润形成、费用结构、期间变化与明细 |
| 退款与售后 | 支付归属/退款发生两种口径、退款原因与订单 |
| 报表中心 | 预置报表、保存视图、CSV 导出、模板与数据导入 |
| 商品成本管理 | 分层成本、历史版本、预览、试算与历史重算 |

全局筛选写入 URL，刷新和返回可恢复；店铺受渠道约束，点击图表与表格保留分析上下文。正式业务数据由后端计算，所有页面使用统一口径。

## 金额和成本口径

- 净销售收入 = 支付商品收入 − 已完成商品退款。
- 商品毛利 = 净销售收入 − 有效商品成本。
- 经营贡献利润 = 商品毛利 − 平台费 − 包装费 − 商家物流费 − 广告费。此指标不包括人员、房租等固定费用。
- 成本优先级为 **店铺 SKU → 渠道 SKU → 基础 SKU**，依订单支付时间匹配有效区间；三层不相加。
- 历史订单保留成本快照。新增成本版本不重写历史，历史修复通过预览和确认重算完成。
- 未知成本不按零处理。利润只涵盖已核算范围，同时展示覆盖率与未核算销售额。
- 退款只有可回收商品才按原成本转回；仅退款不退货保留商品成本。已发生费用不会因退款自动消失。
- 费用在完整来源范围内分摊后再筛选。不能归属商品的费用单列，整体和店铺仍承担这些费用。
- 人民币金额保存整数分，单位成本保存 10,000 倍整数、汇率保存 100,000,000 倍整数；Python Decimal 计算，API 金额返回十进制字符串。
- 默认日期按支付归属，退款统计截至演示日期；售后页可切换退款发生时间。比例使用汇总分子/分母，不能平均单行利润率。

## 数据位置与 CSV

- 工作数据库：`.localdata/workbench.sqlite3`，可通过 `DATABASE_PATH` 覆盖；相对路径从项目根目录解析。
- 完整演示 CSV：`.localdata/demo-csv/`。
- 模板：`data/templates/`；小规模样例：`data/examples/`。
- 导入后的 SQLite 是查询依据。修改 CSV 后需显式重新导入，文件不会自动覆盖数据库。
- 标准模板支持 UTF-8/BOM，金额以元为单位输入十进制文本。业务编码保留前导零。
- 导入先校验预览，再确认提交；完全重复记录跳过、同键不同内容报冲突，阻断性错误使整批不写入。
- 报表 CSV 是分析结果；标准模板 CSV 是可导入数据，两种文件用途不同。

成本、目标、保存视图与操作记录在服务重启、浏览器缓存清除后仍然保留。演示数据重置是单独的显式操作，不会在正常启动时发生。

## 工程结构

前端为 React / TypeScript / Vite / Tailwind / shadcn 风格可定制组件 / ECharts / TanStack Query 与 Table；后端为 FastAPI / SQLAlchemy / SQLite / Alembic。依赖以 `pnpm-lock.yaml` 和 `apps/api/uv.lock` 锁定。

已验证版本：React 19.3.0、TypeScript 5.9.3、Vite 7.3.6、Tailwind 4.3.3、ECharts 6.1.0、FastAPI 0.141.1、SQLAlchemy 2.0.54、Alembic 1.20.0、SQLite 3.50.4。包管理器为 pnpm 12.6.0。

```text
apps/web/                 前端页面、共享图表表格和交互
apps/api/app/             数据模型、领域计算、API、CSV 与 seed
apps/api/tests/           领域、接口和 CSV 测试
packages/api-types/       OpenAPI 及生成的 TypeScript 类型
data/                     模板与可读样例
scripts/                  初始化、启动、类型生成等工具
tests/e2e/                真实 API 和浏览器验收
docs/                     口径、接口约定、场景与截图
.localdata/               本机运行数据，不提交版本控制
```

## 验证命令

```bash
pnpm typecheck
pnpm build
pnpm api:types
pnpm exec playwright install chromium
pnpm test:e2e
```

浏览器验收默认自动创建临时 SQLite 工作区，并在 8011/5175 启动独立服务，结束后清理，不修改日常演示数据库。可用 `E2E_API_PORT`、`E2E_WEB_PORT` 修改验收端口；显式设置 `E2E_BASE_URL` 时使用指定的现有服务，此时测试的写操作会作用于该服务。后端检查在 `apps/api` 目录执行：

```bash
uv run pytest
uv run ruff check .
```

前端显示层和瀑布图测试运行 `pnpm test:web`。后端格式检查运行 `pnpm format:check:api`。真实后端双进程重启验收运行 `pnpm test:persistence`，使用独立临时数据库。

实际执行记录与截图见 [验证记录](docs/VALIDATION.md)。演示场景见 [场景索引](docs/SCENARIOS.md)。


## 维护命令

在项目根目录运行：

```bash
pnpm db:migrate        # 显式升级到当前数据库版本
pnpm db:seed           # 初次导入；已初始化时跳过，保留业务修改
pnpm db:backup         # 使用 SQLite backup API 生成一致性副本
```

备份路径默认 `.localdata/backup-日期-时间.sqlite3`。自定义路径：

```bash
pnpm db:backup --output /absolute/path/workbench-backup.sqlite3
```

备份恢复可以先停止工作台，再设置 `DATABASE_PATH=/absolute/path/workbench-backup.sqlite3` 启动并核查。保留原数据库；不要用正在运行时的文件复制覆盖 WAL 数据库。

确实需要删除演示工作区的业务修改时，使用界面「演示数据 → 确认恢复」，或以下明确重置命令：

```bash
uv run --directory apps/api python -m app.cli reset --confirm
```

`APP_MODE` 不是 `demo` 时，后端禁止网页恢复接口。普通启动不执行 seed 或重置。开发模式在启动终端按 Ctrl+C 停止；端口占用只提示错误，不结束其他服务。

`.env.example` 列出实际支持的环境变量。配置以进程环境为准，该示例不会自动加载。导入预览的规范化 CSV 内容及文件摘要暂存在 SQLite 的导入批次记录中，与数据库一起持久化；无需额外的 CSV 暂存目录。

## 本版本范围

- 本机单工作区、演示操作人，不含平台 API 拉取及账号体系。
- 演示数据集固定 180 天，2026-04-02 至 2026-09-28；日期对比遵循这段实际数据范围。
- 仅展示模拟费率和汇率，不代表平台结算规则。可通过标准 CSV 导入自己的规范化记录。
- SQLite 采用单 API 工作进程，面向本机约 1 万订单的评审与业务原型；没有宣称通过多用户公网或百万订单压测。
