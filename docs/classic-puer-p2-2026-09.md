# 经典普洱模块 + 帖子展示改造 + 移动端混合流（P2-R1/R2/R3）· 2026-09

三点需求的一次性落地：经典普洱模块（P2-R2）、帖子内容前置折叠（P2-R1）、手机端综合加权流（P2-R3）。

## R1 · 帖子卡片：文字前置 + 折叠

- `src/components/forum-feed.tsx` `ArticleCard`：原逻辑"有视频/图片则完全不显示文字"，改为**文字内容永远显示在媒体之前**。
- 新增 `CollapsibleText` 组件：默认 `line-clamp-3`，检测溢出（scrollHeight > clientHeight）显示"展开全文 ▼ / 收起 ▲"按钮。
- `forum/page.tsx` feed 数据：content 切片 200 → **500 字**（配合折叠展开）。

## R2 · 经典普洱模块（茶品库页 + 自动跟进帖）

### 数据模型（`prisma/migrations/0004_add_classic_tea_fields.sql`）
```sql
teas."isClassic" BOOLEAN DEFAULT false   -- 经典策展标记
teas."marketInfo" JSONB                  -- 东和行情快照
```

### 入口与页面
- **Sidebar**（`forum-sidebar.tsx`）：新 amber 主题卡片"🏵️ 经典普洱"，位于"发布新帖"与"社区"之间（桌面端 lg+）。
- **列表页 `/forum/classics`**（新）：三栏布局，品牌/生熟/搜索筛选，茶品卡片（封面/品牌/年份/生熟/品鉴数/评分/行情条）。空态引导到 /tea。
- **详情页 `/tea/[id]` 增强**：
  - 经典徽章 + 面包屑"经典普洱"层级 + 东和行情快照卡（`parseMarket`，共享于 `src/lib/market-info.ts`）
  - **转化档案时间线**（所有人可见）：历年品鉴按时间正序，展示 标题 + summary(≤500字) + 评分 + 首图 —— 隐私边界：品鉴**全文仍 admin-only**（私人笔记），只公开摘要层；品鉴数量统计与图片墙同步公开（evernote 图床 URL 本就公开）
  - 关联帖子区 = 跟进讨论入口

### 自动跟进帖（灌水+热榜收录）
- `scripts/import-classic-teas.mjs`（幂等）：
  1. 标记 isClassic：经典名单正则（7542/88青/大白菜/紫大益/绿大树/老班章/冰岛/红印/宋聘等 36 词）匹配 name/aliases，或 `tastingNoteCount >= --min-notes`(默认3)
  2. 建"经典普洱"版块（slug=classics，sortOrder=65）
  3. 每款经典茶建一篇 `type=discussion` Article（boardId=classics, teaId 关联, author=admin），标题`【经典普洱】{year} {brand} {name} 跟进讨论帖`，正文含档案链接与灌水引导 → 自动进入 v4.0 热榜体系
  4. 东和行情：读 `rag-data/sku-clean.jsonl`（`--sku-file` 可指定），防御性字段解析后按名称互含匹配，写 marketInfo
- 服务器执行：
  ```bash
  cd /opt/puer-hub && set -a && . ./.env && set +a && \
    node scripts/import-classic-teas.mjs            # 先 --dry 预览
  ```
  （host node_modules 含 pg，与 cron-task.sh 同一运行模式）

## R3 · 移动端综合加权流（桌面三栏不变）

- `forum-feed.tsx`：tab 栏 `hidden lg:flex`（桌面五 tab 原样）；<lg 显示"✨ 为你推荐（热榜 × 新帖 · 综合加权）"头部。
- 混合算法（客户端，matchMedia(max-width:1023px)）：
  ```
  score = 0.5 × 热度位次(服务端tab排序归一化) + 0.3 × 新鲜度(exp(-ageH/72)) + 0.2 × 平滑互动率((up+2×reply+1)/(…+8))
  ```
- 经典普洱卡片（ClassicCard）每 8 帖穿插 1 张，点击进 /tea/[id]。
- `forum/page.tsx` 增查 `isClassic=true` 的 20 款茶传给 ForumFeed。

## 验证
- `npx tsc --noEmit`：仅剩 tests 的 pre-existing 错误（@prisma/adapter-pg 缺失，与本次无关）
- `npx next build`：✓ Compiled successfully，69/69 页面
- `node --check scripts/import-classic-teas.mjs`：OK

## 部署清单（服务器）
1. `git pull`
2. 应用 migration：`docker exec -i puer-hub-postgres psql -U puer -d puerhub < prisma/migrations/0004_add_classic_tea_fields.sql`（库名/用户按 .env 实际）
3. 跑导入脚本（上面命令，先 `--dry`）
4. 前端镜像 server-side 构建（Mac arm64 vs 服务器 x86_64，沿用 20260909T130320Z 发布流程：git worktree 基线 + 变更文件 overlay + deploy.sh）
5. 验证：`/forum/classics` 200 且有茶品卡；`/tea/{id}` 显示转化档案；`/forum` 手机宽度显示"为你推荐"；帖子卡片文字在视频前

## 部署记录（2026-09-09，release 20260909T135121Z-f8231c6）

服务器非 git 仓库（rsync 同步模式），实际流程：

1. **migration**：`docker exec -i puer-hub-postgres psql -U puerhub -d puerhub < 0004_…sql`
   → ALTER TABLE ×2 + CREATE INDEX；`isClassic` boolean / `marketInfo` jsonb 就位。
2. **导入脚本调优**（实跑前发现并修正）：
   - 名单过宽（572 款）→ 剔除山头词（老班章/冰岛/昔归…是产区非品种），只收
     唛号标杆（7542/7572/8582/8592/8653/8892/7742/8853/7532）+ 超级 IP + 号级/印级；
     `min-notes` 默认 3→4；排除脏名（`name ~ '^[12][0-9]{3}-'`，滤掉"（资料）…""转发|…"笔记标题残留）→ **312 款**
   - 跟进帖加 `--max-threads=40` 上限（品鉴数优先），避免一次灌爆论坛
   - 东和 SKU 匹配 0 条 → 两轮修正：价格字段实为 `market_price_per_jian`（元/件，
     格式化为"13 万/件"）；名称互含因"2004年401批次…青饼"写法差异失配 → 改为
     **经典关键词交集 + 年份一致**匹配 → **41 款命中**（抽查精准：
     "2001-紫大益4号青短脚A" ↔ "2001年紫大益4号青饼(断南)" 43 万/件）
   - 跟进帖标题去冗余（name 已带"YYYY-品牌"前缀时不再重复 year/brand，"未知"品牌不写入）
   - **dry-run 陷阱**：dry 不写 isClassic 时 Step4 行情查询候选集恒空，匹配数恒 0——
     dry 的 [4/4] 结果仅在已实跑过 Step1 后才有参考意义
3. **数据结果**：经典茶 312 款；classics 版块（7738efe2）；跟进帖 40（标题后 SQL 批量修正）；行情 41 款。重跑幂等（标记/建帖均 skip）。
4. **镜像**：本地组装 APP_CONTEXT（排除 src/generated、public/uploads）→ rsync
   `/opt/puer-hub/releases/20260909T135121Z-f8231c6/context/` → 服务器
   `docker build`（约 3 分钟）→ 旧镜像打 `rollback-20260909T135121Z-f8231c6` →
   `app.active.override.yml` → compose up 切换 → `/forum` 200。
   - 注意：compose up 期间 SSH 会话中断会留下半 recreate 状态（旧镜像 running + 端口未就绪），
     重跑同一条 compose up 即恢复
5. **外部验证**：`/forum`、`/forum/classics`、`/tea/[id]` 全 200；classics 页有
   篇品鉴徽标 + 万/件行情价；详情页有"转化档案 · 历年品鉴"+ 平均分（无品鉴记录的茶
   按设计不渲染时间轴）；`?tab=latest` 跟进帖可见（标题干净）。

### 回滚

```bash
cd /opt/puer-hub && docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f rag-service.yml -f releases/20260909T135121Z-f8231c6/app.rollback.override.yml \
  up -d --no-deps --no-build app
# rollback.override.yml 指向 puer-hub-app:rollback-20260909T135121Z-f8231c6（需先创建该文件）
# DB 变更（isClassic/marketInfo/跟进帖）为增量数据，回滚镜像不影响；如需清理：
#   UPDATE teas SET "isClassic"=false, "marketInfo"=NULL; DELETE FROM articles WHERE title LIKE '【经典普洱】%';
```
