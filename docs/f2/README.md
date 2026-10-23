# F2 我的茶仓 · 运行手册

PRD v0.3 §5 Phase 2。目标：让用户存自己的茶、记自己的品鉴，并在条目页
对照站长线 —— 这是站内第一份「不依赖任何社区数据」的价值。

## 上线开关

```bash
FEATURE_CELLAR=1     # 默认关。关着时前台 404、接口 404、导航不出现
```

后台审核队列（`/admin/cellar-requests`）**不受这个开关门禁** —— 前台关了
但队列里还有待审核的申请时，站长仍然要能处理。

## 迁移

```sql
prisma/migrations/20261023_cellar/migration.sql
```

只增不删、全部可空、幂等。**先 SQL 后镜像** —— 新镜像里的 Prisma Client
认识新表，旧镜像不认识。

## 站主要做的三件事

### 1. 给种子用户代录茶仓

`/admin/cellar-requests` → 「代录茶仓」tab → 搜 UID/用户名 → 选人 → 代录一条。

代录的仓储评分来源标成「**站长评**」（本人录的是「自评」）。将来做社区带
时这两种来源不能混，所以别手动改这个标记。

### 2. 审核自建茶品

同一个页面 → 「自建茶品待审核」tab → 搜茶品库 → 勾选要并入的那款 → 确认并入。

并入后，引用这条申请的茶仓条目会自动挂上那款茶 —— 用户加的茶从此能对照
站长线了。

### 3. 核对描述词库的四维分类

```bash
node --import tsx scripts/seed-descriptor-vocab.mjs            # dry-run
node --import tsx scripts/seed-descriptor-vocab.mjs --apply
```

默认写一份 `docs/f1/vocab-preview.csv`（Excel 能直接打开）—— **这份要给
站长核对**：生熟与年份段是从笔记所属的茶直接读出来的（确定事实），但
「这个词属于香气/滋味/水路/体感哪一维」是模型判的，可能不准。

## 退出标准的观测

```bash
node --import tsx scripts/cellar-usage-report.mjs
node --import tsx scripts/cellar-usage-report.mjs --days 30
node --import tsx scripts/cellar-usage-report.mjs --json
```

PRD §5 Phase 2 的退出标准是「站长与至少 10 位种子用户内测一周，
**快速品鉴的中位耗时 < 30 秒**」。报表就盯这两条：

- 参与用户 ≥ 10 位
- 快速品鉴中位耗时 < 30 秒

口径：中位数不用平均数（一次挂机会把平均数拉长好几倍）；耗时只统计带
`elapsed_seconds` 的记录；合成账号的记录剔除。

## 已知限制

- 用户品鉴图片走站内既有的 `/api/upload`，落地是**公开 URL**（UUID 不可猜，
  但无访问控制）且带水印。要真正私有需新增私有层 + 带鉴权的读取路由，
  站内目前没有。
- 储仓评分 45/50/55/60 的**锚点描述文案**与四维各档描述文案是占位文案，
  等站长提供。
- Phase 3 的社区带还没做：`users.share_aggregate` / `share_consented_at`
  两个字段已建，但**不参与任何聚合**。
