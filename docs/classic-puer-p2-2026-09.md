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

## R4 · 品牌吧 + 移动端懒加载（2026-09-10 已上线，release 20260909T144914Z-b55b043）

用户反馈三项改进，实现如下：

### R4-1 桌面端 classics 左侧热门茶品（≤10 款）

`/forum/classics` 主区左侧新增 `HotTeasWidget`（lg+ 显示）：
- 热度 = `tastingNoteCount×10 + avgRating×2 + (有行情快照?3:0) + 关联跟进帖数`，取前 10
- 近 30 天有新品鉴（TastingNote distinct teaId 倒序）的茶名前打绿点，兼顾"最近更新"信号
- 每项显示 品鉴数 + 行情价，点击进 `/tea/[id]`

### R4-2 经典普洱改品牌吧（贴吧式）

- 顶部横向 pills：全部 / 大益吧 / 下关吧 / 福今吧 / 今大福吧 / 黎明吧 / 兴海吧 / 其他吧
  （其他吧 = brand NOT IN 六厂牌；pill 带各吧茶品数，groupBy brand 统计）
- 吧内茶品列表（TeaList 行式卡片，热度排序）：缩略图 + 年份/批次/生熟徽标 +
  品鉴数/评分/跟进数 + 右侧行情价；保留 生熟/关键词 筛选（hidden bar 字段透传）
- 跟进发帖闭环：茶品详情页"关联帖子"标题行新增「✏️ 发布跟进帖」按钮（未登录显示
  登录引导），深链 `/forum/new?board=classics&tea=<id>&teaName=…&teaBrand=…&teaYear=…&title=【跟进】…`；
  `/forum/new` 挂载时读 URL 查询参数预填版块/关联茶品/标题（POST /api/boards/[slug] 原生支持 teaId）

### R4-3 移动端：懒加载 + 去 banner + "新"徽标重设计

- **懒加载**：新增 `src/lib/forum-feed-server.ts`（fetchForumFeed：从 forum/page.tsx 抽取的
  v4 热榜窗口算法 + offset/limit 分页）与 `GET /api/forum/feed?tab=&offset=&limit=`。
  移动端 feed 底部哨兵（rootMargin 600px）触发拉取，append-only 追加（不与首屏重排，
  避免阅读中卡片跳动），客户端按 id 去重。**热榜窗口耗尽后服务端自动"归档续读"**
  （createdAt 倒序、排除置顶）——解决"week 窗口只有 5 帖刷不动"的问题。
  `forum/page.tsx` SSR 首屏也改走 fetchForumFeed（单一数据源，排序与分页一致）。
- **去 banner**：删除移动端"为你推荐"头部。
- **"新"徽标**：`isNew = 未读(localStorage puer_seen_posts) && createdAt 距今 < 48h`
  （此前所有未读帖都挂"新"，现仅最近两天且没看过的才显示；滚动进入视口即标记已读、徽标消失）。

### 验证

- `npx tsc --noEmit` 通过（唯一报错为 tests/ 目录预存 `@prisma/adapter-pg` 缺失，与本次无关）
- eslint：修复新增的 prefer-const/未转义引号/未用变量；剩余 set-state-in-effect /
  purity 报错与 HEAD 基线同类同量（非门禁规则）
- 生产构建 `npm run build` 见构建日志

### 回滚

纯前端 + API 增量（无 DB 迁移）：回滚镜像即可；`/api/forum/feed` 为新增路由，
旧镜像无此路由不影响回滚后页面（移动端退回无懒加载的 SSR 全量列表）。

### 部署记录（2026-09-10，release 20260909T144914Z-b55b043）

无 DB 变更，纯镜像发布，流程与上次相同（工作树组装 context → rsync → 服务器 build）：

1. **镜像**：本地 `.releases/20260909T144914Z-b55b043/context/`（APP_CONTEXT 307 文件 ≈2MB，
   排除 uploads/generated）→ rsync `/opt/puer-hub/releases/<id>/context/` → 服务器
   `docker build` ≈4 分钟 → `puer-hub-app:20260909T144914Z-b55b043`（b42f8eca0a9d）
2. **切换**：旧镜像（f8231c6，a916a21d…）打 `rollback-20260909T144914Z-b55b043` →
   `app.active.override.yml` → compose up（nohup 后台跑激活脚本，防 SSH 中断留半 recreate 状态；
   脚本内建失败自动回滚 + 30×2s 健康轮询）→ `/forum` 200，一次成功
3. **验证**：`/forum`、`/forum/classics`、`?bar=dayi`、`/tea/[id]`、`/forum/new?board=classics…` 全 200；
   classics 页含品牌吧 pills + 热门茶品 widget；`/api/forum/feed` 分页正常（week offset=15
   返回跟进帖 + hasMore）；dayi 吧列表 DB 硬过滤 brand=大益（页面出现的福今茶名来自
   HotTeasWidget 全局热门，符合设计）；移动端「为你推荐」banner 已无；懒加载
   IntersectionObserver 代码在 JS chunk 中确认
4. **注意**：dayi/all 页 tea 链接 127/120 差异 = 列表 take:120 截断 + widget 10 条去重，正常

回滚命令：

```bash
cd /opt/puer-hub && docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f rag-service.yml -f releases/20260909T144914Z-b55b043/app.rollback.override.yml \
  up -d --no-deps --no-build app
# rollback.override.yml 指向 puer-hub-app:rollback-20260909T144914Z-b55b043（需先创建该文件）
```

## R5 · 经典普洱退出首页 + 手机端入口与升级机制（2026-09-09 已上线，release 20260909T152646Z-7d1c19a）

### 背景
用户反馈：手机端首页被大量经典普洱跟进帖占据——跟进帖无视频/轮播图、内容为多篇茶记聚合，与普通帖风格差异大，体验差。决策：经典普洱内容退出首页信息流（跟进帖 + 穿插茶品卡片均移除），改为专区入口 + 人工升级机制。

### R5-1 跟进帖不进主 feed，升级后才进入
- `Article` 新增 `promotedHomeAt DateTime?`（NULL = 仅存在于茶品档案/classics 区；非空 = 已升级，进入主 feed）。生产 migration：
  `ALTER TABLE articles ADD COLUMN IF NOT EXISTS "promotedHomeAt" TIMESTAMP(3);`
- `fetchForumFeed`（`src/lib/forum-feed-server.ts`）where 增加排除条件：`OR: [teaId null, board.slug <> 'classics', promotedHomeAt != null]`，覆盖 week/latest/essence/归档续读全部分支。注意：归档查询原有的 AND（hotOverride NULL-safe）与新增 AND 必须合并进同一数组，spread 后直接写 AND 键会覆盖丢失。
- 同步排除：`LatestPosts`（右侧栏最新）、首页 `/` recentArticles、`forum/page.tsx` 不再查询 classicTeas。

### R5-2 帖子详情页「升级到首页」按钮
- 新组件 `src/components/promote-home-button.tsx` + 新 API `POST /api/boards/[slug]/promote`（toggle promotedHomeAt，返回 isPromoted）。
- 权限：帖子作者、admin、Lv.3+（比 pin/essence 的 admin/Lv3 宽一档，作者可自行升级自己的跟进帖；UI 与 API 同口径校验）。
- 渲染条件：thread 页文章 meta 操作行，仅 `board.slug==='classics' && teaId` 的跟进帖。

### R5-3 手机端右上角「经典普洱」入口
- `header.tsx` 移动区（搜索图标左侧）常显 amber pill「🏵️ 经典」→ `/forum/classics`；slide-down 菜单在「首页」后加「🏵️ 经典普洱」项。桌面端不加（有导航/侧栏）。
- i18n 词条：经典普洱→經典普洱、经典→經典。

### R5-4 classics 页移动端适配
- 新增移动端热门茶品横滑条（lg:hidden，pills 下方）：top10 小卡（序号/绿点/品鉴数/行情）。
- 茶品行 meta 行追加行情价（原先 hidden sm:block 仅桌面可见，移动端现在也能看到）。
- 筛选表单 flex-wrap + 搜索框移动端 flex-1 自适应。

### 验证（本地冒烟，pg@54329 容器）
- seed：a1=已升级跟进帖、a2=未升级跟进帖、a3=普通帖。feed week/latest 均返回 [a1,a3]、排除 a2；SQL 置 NULL 后 a1 从 feed 消失（toggle 语义）。
- `/forum` HTML 无【跟进】标题；`/forum/classics?bar=dayi` 含横滑条 + 13万/件价格。
- header 含 `/forum/classics` 链接；promote API 未登录 401。
- tsc clean；build exit 0；eslint 无新增问题（剩余均为 HEAD 基线同类）。

### R5 部署记录（2026-09-09，release 20260909T152646Z-7d1c19a）
1. **migration 先行**（加列对旧镜像前向安全）：宿主机写 SQL 文件 → `docker exec -i puer-hub-postgres psql -U puerhub -d puerhub < file`。
   `ALTER TABLE articles ADD COLUMN IF NOT EXISTS "promotedHomeAt" TIMESTAMP(3);` → 列确认存在，生产跟进帖 40 条。
2. **context 组装**：clean working tree rsync APP_CONTEXT（排除 `src/generated`、`uploads`——本地 public/uploads 有 91MB 开发残留，首次未排除致 93MB/852 文件，排除后 2.6MB/309 文件与 R4 一致）→ rsync -az 到 `/opt/puer-hub/releases/<rid>/`。
3. **build**：服务器 `nohup docker build -t puer-hub-app:<rid> . > build.log` ≈2min → image `a2f2a98998eb`。
4. **激活**：简化 activate.sh（跳过 image.tar 校验，镜像已在本地；保留 rollback tag + ERR 自动回滚 + 30×2s 健康轮询）nohup 后台执行 → 一次成功。PREVIOUS=b42f8eca0a9d（R4）已打 `rollback-20260909T152646Z-7d1c19a`。
5. **生产验证**：`/forum`、`/forum/classics`、`/` 全 200；首屏【跟进】标题 0；feed week 窗口 2 帖（无跟进，质量门槛正常）；归档续读 offset=60 返回 30 帖、classics 板块 0（AND 合并正确）；classics 页横滑条 + header 经典入口在 HTML 中；promote API 未登录 401；postgres/minio/rag/ws 容器全部健康。

回滚命令：

```bash
cd /opt/puer-hub && docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f rag-service.yml -f releases/20260909T152646Z-7d1c19a/app.rollback.override.yml \
  up -d --no-deps --no-build app
# rollback.override.yml 指向 puer-hub-app:rollback-20260909T152646Z-7d1c19a（需先创建该文件）
# 注意：回滚 R5 无需回滚 DB——旧代码不认识 promotedHomeAt 列，加列对旧镜像前向安全
```

## R6 · 发布新经典入口 + 茶品图片预览 + 三吧补茶（2026-09-09 已上线，release 20260909T225255Z-fe0ccd3）

### R6 需求与实现

1. **「发布跟进帖」→「发布新经典」（Lv.2+）**：classics 页头部按钮改为「✨ 发布新经典」→ `/encyclopedia/new?classic=1`（创建茶品档案并入选经典普洱吧）。仅 `session.user.level >= 2` 显示，与 `POST /api/teas` 的建档权限一致。表单顶部新增「🏵️ 入选经典普洱吧」勾选框（`?classic=1` 深链自动预勾选；用 `window.location.search` 读取避免 useSearchParams 的 Suspense 包裹需求）。zod schema 新增 `isClassic`。
2. **权限分层**：发布新经典（建茶品档案）= Lv.2+；跟进帖 = 各茶品档案页「✏️ 发布跟进帖」，**所有登录用户**可发（现状即满足，未改动）。
3. **茶品图片预览三级 fallback**：`coverImage`（正面封面）→ `gallery[0]`（图库第一张）→ 最近 3 篇品鉴笔记第一图。背景：全库 312 款经典茶仅 7 款有封面/图库，但 1587 条茶记带图（Evernote 导入是主要图源）。落地位置：classics 吧列表行（`TeaThumb` 14×14）、移动横滑卡（新增 h-20 顶部大图）、桌面 HotTeasWidget（新增 8×8 缩略）、茶品详情页封面（原先无封面则无图，现三级链兜底）。查询侧 `teaSelect` 增加 `gallery` + `tastingNotes(take 3, images only)`。
4. **今大福/黎明/兴海吧补茶**（生产 SQL `/tmp/puer-r6-classics.sql`，已执行）：
   - 今大福 5 款（brand 本就正确）：大国韵茶王(3篇)、金九茶王(2篇)、山野(2篇)、大国韵茶王青饼(1篇)、班章宫廷熟(1篇)
   - 黎明 4 款（brand「未知」→「黎明」归一）：2001-黎明7540(2篇)、2008-黎明雅韵(2篇)、2005-黎明乔木王(1篇)、2004-黎明巴达山老树圆茶(1篇)
   - 兴海 4 款（brand 归一：未知/班章→「兴海」）：2004-兴海大曼吕(4篇)、2003-兴海302景迈(3篇)、2020-兴海班章三星(1篇)、兴海-2010班章贡饼(1篇)
   - 数据发现：teas 表 28 个品牌中黎明/兴海的茶记关联档案 brand 全标「未知」（Evernote 导入未归一），靠名称/茶记内容 LIKE 找回。

### R6 验证与部署（2026-09-09）

- 本地：tsc clean（仅预存 tests/adapter-pg 错误）；`next build` exit 0（58s）。
- **数据先行**（UPDATE 前向安全，旧镜像可渲染）：scp SQL → `docker exec -i puer-hub-postgres psql -v ON_ERROR_STOP=1`，事务提交，三吧计数 5/4/4。
- **部署**：commit `fe0ccd3` → context 2.6MB/307 文件 rsync → 服务器 docker build ≈2min → activate.sh（R5 简化版改 rid）一次成功。image `0e9e062b62de`；PREVIOUS `a2f2a98998eb`（R5）已打 `rollback-20260909T225255Z-fe0ccd3`。
- **生产验证**：`/forum/classics`（含 ?bar=jindafu/liming/xinghai）、`/encyclopedia/new?classic=1`、`/tea/11652958…`（兴海大曼吕）全 200；黎明吧 4 款、今大福吧 5 款茶名全在 HTML 且 TeaList `<img>` 带图（茶记图 `/uploads/evernote/…`）；兴海大曼吕详情页出现封面 img（此前无封面）；未登录 classics 页「发布新经典」0 次（权限渲染正确）；容器全部健康。

回滚命令：

```bash
cd /opt/puer-hub && docker compose -f docker-compose.yml -f docker-compose.override.yml \
  -f rag-service.yml -f releases/20260909T225255Z-fe0ccd3/app.rollback.override.yml \
  up -d --no-deps --no-build app
# rollback.override.yml 指向 puer-hub-app:rollback-20260909T225255Z-fe0ccd3（需先创建该文件）
# 数据回滚（可选，仅当需撤销三吧补茶/品牌归一时）：
#   UPDATE teas SET "isClassic"=false WHERE id IN (<R6 13 款 id>);
#   UPDATE teas SET brand='未知' WHERE id IN (黎明 4 款 ∪ 兴海大曼吕、302景迈); UPDATE teas SET brand='班章' WHERE id IN (c0b91521…,d30b131b…);
```

## R7 · 手机端字号整体调大 + App 打包方案存档（2026-09-10 已上线，release 20260910T014427Z-fd6ceb7）

1. **App 打包方案**：完整规划保存至 `docs/app-packaging-plan.md`（Capacitor 远程加载壳，iOS 先行；**状态=暂停待启动**，免费 Apple ID 可完成 Phase 0 PoC）。
2. **手机端字号**：`globals.css` 中 ≤767px 视口 `html { font-size: 112.5% }`（rem 基准 16→18px，+12.5%），全站字号/间距等比放大约一号，桌面端不受影响；68 处硬编码 `text-[10-13px]` 批量转 `rem`（0.625/0.6875/0.75/0.8125rem）以跟随缩放，8/9px 图标角标保留。
3. **部署**：commit `fd6ceb7` → context 2.6MB → 服务器 build → activate 一次成功；PREVIOUS `0e9e062b62de`（R6）已打 rollback tag。生产 CSS chunk 验证含 `font-size:112.5%` 与 `.6875rem`；`/`(307→/forum)、`/forum`、`/forum/classics` 全通。

回滚：同 R6 方式，指向 `rollback-20260910T014427Z-fd6ceb7`；或仅回滚字号（`globals.css` 单文件改动，revert 该 commit 的 CSS 部分即可）。

## R8 · 电脑端左侧经典普洱热点茶品榜（2026-09-10 已上线，release 20260910T015538Z-04bc968）

1. **需求**：电脑端左侧栏「🏵️ 经典普洱」入口展示热点茶品，动态更新，点击进入经典普洱区。
2. **实现**（`src/components/forum-sidebar.tsx`，全站 4 处使用该侧栏的页面同步生效）：
   - 入口卡片升级为模块：标题行「🏵️ 经典普洱 / 热点茶品 · 动态更新 + 更多›」→ `/forum/classics`；下方 top5 茶品行（序号 + 28px 缩略图 + 名称 + 品鉴数）→ `/tea/[id]` 档案页。
   - **动态排序**：两个 `groupBy`（tastingNotes / articles 各取每茶 `_max createdAt` top12）合并为「最近活动时间」降序取 5；不足按 `tastingNoteCount` 热度补足（无活动记录排后）。发布新茶记/跟进帖后侧栏即时变化（页面 force-dynamic）。
   - 缩略图三级链复用（封面→图库→茶记图）；全部查询 `.catch()` 降级，DB 异常时模块回退为纯入口卡片不阻塞侧栏。
3. **部署**：commit `04bc968` → 服务器 build 95s → activate 一次成功；PREVIOUS（R7 `fd6ceb7` 镜像）已打 rollback tag。生产验证：`/forum` HTML 含模块标题与 5 个 `/tea/<id>` 行链接，`/forum`、`/forum/classics` 200。

回滚：同前，指向 `rollback-20260910T015538Z-04bc968`（纯前端改动，无 DB 变更）。

## R9 · 帖子卡片重构为 Reddit/X 式布局（2026-09-10 已上线，release 20260910T023053Z-893c91b）

1. **问题**：移动端卡片左列投票（↑N↓ 约 70px 宽）压缩标题为窄多行；元信息行 flex-wrap + 关注按钮 min-h 换行导致标题下方大片空白。
2. **新结构**（`forum-feed.tsx` ArticleCard，移动/桌面统一）：
   - 行1：32px 头像（链接用户页，无图首字母圆）+ 作者（AuthorHover）· 时间 · 版块；徽标（新/flair/⭐/📌）右移行尾
   - 行2：标题独占整行宽度
   - 行3：正文折叠预览（不变）；行4：媒体 4:3（不变）
   - 行5（底部操作行，border-t + mt-auto 贴底）：横排投票 + 💬 评论数按钮（0 时显示"评论"）+ 右侧关注按钮
3. **评估依据**：Reddit mobile / X 的信息层级——身份先行、标题阅读优先、操作触达在拇指热区（底部）；消除 wrap 留白。桌面统一该结构（维护单套代码）。
4. **部署小插曲**：首次 activate 在 docker build 导层未完成时启动 → `No such image` 触发自动回滚（旧镜像持续服务，无中断）；确认 image 后重跑 activate 一次成功。教训：启动 activate 前必须看到 build.log `#26 DONE`。
5. **验证**：`/forum` 200；HTML 含新头像标记（`w-8 h-8 rounded-full` ×4）。

回滚：指向 `rollback-20260910T023053Z-893c91b`（纯前端改动，无 DB 变更）。

## R10 · 桌面懒加载修复 + 侧栏扩容滚动 + 专业条款注册勾选 + SEO 系统优化（2026-09-10 已上线，release 20260910T034132Z-ce87da6）

1. **桌面 feed 懒加载**（`forum-feed.tsx`）：sentinel/IntersectionObserver 原仅 `isMobile` 启用——桌面 week 窗口质量门槛只剩 4 帖时无法归档续读。现桌面/移动通用，滚到底自动加载更早归档帖。
2. **侧栏经典普洱扩容**（`forum-sidebar.tsx`）：top5 → 12 款；茶品列表 `max-h-72 overflow-y-auto overscroll-contain`——卡片不拉长，鼠标悬停滚轮即滚列表（滚穿后再滚页面，符合「滑到哪里哪里动」）。
3. **条款专业化 + 注册勾选**：`/rules`（8 条，参考 Reddit Rules 结构）、`/privacy`（8 节）、`/terms`（9 节）全部重写（卡片式分节 + 更新日期 + 页面互链 + SEO meta）；注册页新增必勾「已阅读并同意《社区规则》《隐私政策》《用户协议》」（未勾选按钮禁用 + submit 二次校验）。
4. **SEO**（依据 GSC 报告 `docs/puer.im-Performance-on-Search-2026-09-10.xlsx`：228 展示/5 点击，台湾 58/美国 31/香港 19，长尾 tea/thread 页排名 7-10）：
   - **nginx www→apex 301**（`/etc/nginx/sites-enabled/puer`：主块 server_name 移除 www，新增 www 80/443 301 块；证书 SAN 本含 www；备份 `/etc/nginx/puer.bak.20260910`）——消除 www/apex 重复收录（GSC 见 www.puer.im/article 页面分散权重）。注意：nginx 非 systemd 管理，reload 用 `nginx -s reload`；sites-enabled 下勿留备份文件（通配 include 会冲突）。
   - 首页 title/description 重写：「Puêr 普洱茶论坛 — 以茶会友，品鉴生普熟普经典普洱」+ 关键词描述（生普/熟普/大益/中老期）。
   - `/forum` title 用 `absolute` 绕过模板：「普洱茶论坛_普洱茶交流社区_生普熟普品鉴 - PuerHub」+ keywords 13 个 + og 同步。
   - `/user/[id]` noindex（GSC 19 展示 0 点击，纯浪费抓取预算）。
5. **部署**：commit `ce87da6`；context 白名单式 rsync 3.5MB/13 项（首次误传整树 102M 已中止清理——本地 puer-ai 3.4G/ws-server 46M/rag-src 35M 必须排除）；build ≈6min（`#26 DONE` 确认后 activate 一次成功）；PREVIOUS（R9 `893c91b`）已打 rollback tag。title absolute 修正后同 rid 目录二次 build+activate。
6. **验证**：`/forum` title 新版、12 个 tea 行链接、`max-h-72` 容器、桌面 sentinel 文案均在 HTML；`/register` 勾选、`/rules|/privacy|/terms` 新文案 200；`www.puer.im/x → 301 https://puer.im/x`；`/user/<id>` `noindex`；首页 robots index,follow。

回滚：镜像指向 `rollback-20260910T034132Z-ce87da6`；nginx 回滚 `cp /etc/nginx/puer.bak.20260910 /etc/nginx/sites-enabled/puer && nginx -s reload`。

### SEO 后续建议（未实施，供后续轮次）
- Google 大词（普洱/普洱茶）竞争极高，短期内现实目标是长尾词第一屏：金大益、金针白莲、7542 唛号、以茶会友等已有 2-28 位排名——tea 档案页 title/desc 已覆盖，持续发品鉴帖即可爬升。
- GSC 提交 sitemap、监控「网页索引」报告，观察 www 301 后索引合并（约 2-4 周）。
- 内容为王：312 茶档案 + 1587 品鉴图是最大资产，可做「品牌茶档案聚合页」（/tea?brand=大益 已有）SEO 化 title。

### R10-fix · 桌面懒加载数据未渲染修复（release 20260910T040121Z-b875347，commit b875347）
- 症状：R10 上线后桌面滚到底显示「到底了」但列表仍只有首屏 4 帖。
- 根因：`forum-feed.tsx` 的 `items` useMemo 桌面分支 `if (!isMobile) return orderedBase` 不拼 `extraArticles`（懒加载数据被丢弃）；且页面不满一屏时 observer 连续触发，把归档一次性拉完 → `hasMore=false` → 「到底了」。（服务端 API 正常：`offset=4&limit=10` 返回 10 条 + hasMore=true。）
- 修复：桌面分支改为 `[...orderedBase, ...extraArticles]`（与移动端 append-only 一致）。
- 回滚：`rollback-20260910T040121Z-b875347` tag 已就位。

## R11 · 茶品内容 SEO：图片/视频收录 + 档案页长尾词（2026-09-10 已上线，release 20260910T041507Z-08d9295）

1. **定位**：茶友搜索多用具体茶品名（长尾），312 茶档案 + 1587 品鉴图 + 视频帖是差异化内容资产。本轮让 Google 正式收录这些内容的图片与视频。
2. **新 lib `src/lib/seo-image.ts`**：`absImageUrl()`（相对图 URL 绝对化，localhost 归一生产域）+ `firstImageFromHtml()`（帖子 HTML 首图提取）——JSON-LD/og/sitemap 共用。
3. **茶档案页 `/tea/[id]`**：
   - title 升级：`品牌 名称 年份 生茶/熟茶普洱茶档案`（例「下关 再品04下关方砖125g 生茶普洱茶档案」）——承接「2003 大益 7542 生茶」式搜索。
   - Product JSON-LD 加 `image`（hero 三级链绝对化）、`category`、`aggregateRating`（有品鉴评分时输出星级评分——富摘要）。
   - og:image；hero/茶记缩略图/图库 `<img>` alt 全部语义化（茶名+品牌+年份+生熟）。
4. **帖子页 `/forum/thread/[id]`**：Article JSON-LD 加 `image`（首图绝对 URL → Google Images 收录帖子图）；`videoUrl` 帖输出 **VideoObject JSON-LD**（contentUrl/thumbnailUrl/uploadDate → Google 视频搜索）；generateMetadata 首图提取改用共用 helper。
5. **sitemap.xml 图片扩展**：`<image:image>` 115 条（帖子首图 + 茶封面）——Google Images 收录主通道；robots 未禁 /uploads ✓。
6. **验证**：tea 页新 title + `"image":"https://puer.im/uploads/evernote/..."`；thread Article `"image":[...]`；视频帖 `VideoObject` + contentUrl；sitemap 115 个 image:image。
7. **GSC 操作建议**：sitemap 已自动更新，GSC 会重新抓取；2-4 周后在 GSC「效果→搜索结果→图片/视频」tab 观察收录；「网址检查」对几个重点茶档案页（大益 7542/金大益）手动请求编入索引可加速。

回滚：`rollback-20260910T041507Z-08d9295` tag 已就位。

## R12 · 经典普洱审核制（admin/classics）+ 品鉴笔记升降级 + 移动端已读降权（2026-09-10 已上线，release 20260910T054921Z-cfc08ba）

**背景数据（上线前核实）**：茶库 2763 款茶、isClassic=325 款、品鉴笔记 1686 条且 **teaId 关联率 100%**（"笔记全部归档"前提已满足，无需补归档脚本）。同名茶品合并工具 R2 已有（/admin/teas 相似度检测 + merge API）。

1. **审核流（用户需求 #2）**：新增 `/admin/classics` 经典普洱审核台——
   - 待审核 tab（!isClassic 且有笔记）/ 已发布经典 tab；搜索 + 品牌筛选（按茶品数 Top20）。
   - 「发布为经典 ✓」/「下架」一键切换 isClassic（POST `/api/admin/teas/classic`，admin 守卫）。经典区（/forum/classics、侧栏热点茶品）只认 isClassic=true。
   - 新拆分出的茶品 isClassic=false 自动进入待审核池（符合"归档先审后发"）。
2. **笔记升降级（用户需求 #4）**：审核台内展开茶品（GET `/api/admin/teas/[id]/notes` 轻量列表，倒序 200 条）后每条笔记可：
   - **↓ 合并（降级）**：输入目标茶名 → POST `/api/admin/tasting-notes/move` 移动 teaId；
   - **↑ 独立成茶（升级）**：prompt 输入新茶名 → POST `/api/admin/tasting-notes/split` 创建新茶（继承原茶品牌/年份/生熟，isClassic=false）并把笔记挂过去。
   - 新 lib `src/lib/tea-stats.ts`：`recomputeTeaStats()` 重算 tastingNoteCount + avgRating（五维非空均值），move/split 后双方茶品自动重算。
3. **茶品内笔记时间倒序（用户需求 #5）**：核实 `/tea/[id]` tastingNotes 查询已 `orderBy createdAt desc`——无需改动。
4. **未发布茶品的去留（用户需求 #3）**：暂保持 /tea 茶品库对所有茶可见（经典区已收紧）；等管理员用审核台清理出"经典白名单"后再决定是否隐藏非经典档案（用户明确"还没想起初怎么办"，下轮定）。
5. **移动端已读降权（用户需求 B，回答"是否科学"）**：业界标准做法（Reddit/X/小红书的信息流都做已读降权，探索-利用平衡）。站内本就有已读跟踪（IntersectionObserver + localStorage，`puer_seen_posts`），但移动端加权分未消费该信号。本轮：移动端推荐分 `0.5×热榜位次+0.3×新鲜度+0.2×互动率` **×0.35 已读惩罚**（沉底不剔除，用户仍可找回）；已读记忆 cap 200→400 条（超出自然遗忘≈时间窗）；用**进入页面时的已读快照**计算，阅读过程中新标的已读不当场重排（避免正在看的卡片跳动），下次进入生效——正是"每次进去看到不同的"。
6. **部署**：commit `cfc08ba`；context 白名单 rsync 3.5M（本地 public/uploads 91M 开发残留已排除——docker 生产 uploads 为 volume 挂载）；build #26 DONE 95.4s；activate 一次成功（PREVIOUS sha256:4a7e…）；`/admin/classics` 307 登录守卫、API 403 权限守卫、/forum 200、容器无错误日志。
7. **管理员操作指引**：/admin/classics → 「待审核」里按品牌批量审（大益/下关等标杆唛号放行）；发现归档不准的茶展开笔记做合并/独立；「已发布经典」里把不够经典的下架。

回滚：镜像 `rollback-20260910T054921Z-cfc08ba` tag 已就位（activate 时自动打）。

## R13 · 品牌修正工具 + 品牌吧入库管理 + 笔记合并品牌搜索（2026-09-10 已上线，release 20260910T061159Z-80f21fb）

**背景（用户反馈）**：归档产生的品牌大量脏数据——`未知 1257`、`班章 115`（山头非品牌）、`老班章 26`、`大印藏 8`（茶名被当品牌）、`富华/永年/吾心光明/洞天福地…` 等。需要能编辑品牌、管理品牌吧，且笔记合并搜索要支持品牌+茶名。

1. **品牌编辑（双模式）**（`/admin/classics` 审核台）：
   - 单茶：每行「✏️ 品牌」按钮 prompt 改（默认值=当前品牌）。
   - 批量：品牌筛选下拉选中某品牌（如"大印藏"）→ 行前出现勾选框 + 「全选（N）」→ 输入新品牌（datalist 现有品牌候选）→ 批量改。API：`POST /api/admin/teas/brand`（{teaIds[], brand}，admin 守卫）。
2. **品牌吧入库**（可管理）：
   - 新表 `brand_bars`（migration `0005_brand_bars.sql`：CREATE TABLE + 六大吧种子 INSERT ON CONFLICT，已在生产执行 ✓）；schema.prisma 新增 model BrandBar，prisma generate 已随镜像重建。
   - `/forum/classics` 吧配置改从 DB 读取（`loadBars()`，空表/异常回退内置 DEFAULT_BARS，零停机切换）——"其他吧"逻辑不变（未归入任何吧的品牌自动进）。
   - 审核台「🏷️ 品牌吧管理」面板：每吧可改图标/吧名/品牌列表（逗号分隔，一吧多品牌）、保存/删除、底部新增吧。API：`GET/POST/DELETE /api/admin/brand-bars`。
   - **品牌修正联动**：把"大印藏"批量改成"大益"后自动归入大益吧；新品牌想独立成吧在面板加即可。
3. **笔记合并搜索增强**：展开「笔记管理」后合并输入框支持「品牌 茶名」/纯茶名/纯品牌 检索（`moveNote` 归一化匹配 brand+name），并挂 `datalist#tea-options`（候选格式 `品牌 茶名`，2000 条上限）。
4. **部署**：commit `80f21fb`；**先跑 0005 migration 再切流量**（避免新代码查表 500）；context 3.6M（rsync 排除 uploads）；build #26 DONE；activate 一次成功；验证：classics 六大吧渲染与上线前一致（DB 驱动）、两 API 403 守卫、容器跑新镜像。

**管理员操作指引（品牌清理建议顺序）**：品牌筛选选「未知/班章/老班章/大印藏」等 → 按茶名判断真实品牌（勐海茶厂→大益、下关茶厂→下关…）→ 勾选批量改 → 需要新吧（如"中茶吧"）在品牌吧面板加。

## R14 · 品牌实体化：品牌 CRUD + 茶品归属管理 + 品牌吧必须选现有品牌（2026-09-10 已上线，release 20260910T062943Z-18c00b2）

**概念修正（用户反馈）**：品牌和品牌吧是两回事——先有品牌（实体），品牌吧只能从现有品牌中选择创建，不能随意建。

1. **品牌实体表 `brands`**（migration `0006_brands.sql`：建表 + 现有 `teas.brand` 去重值 30 个品牌种子导入，生产已执行 ✓）。`teas.brand` 字符串保留为关联键（全站查询零破坏），一茶一品牌唯一对应由写入路径保证。
2. **新页 `/admin/brands` 品牌管理**（侧栏工具组「🏷️ 品牌管理」）：
   - 品牌列表（搜索、按茶品数排序、显示品牌简介/图标/茶品数）；
   - **资料编辑**：改名/简介——**事务同步**：`brands.name` + 该品牌全部 `teas.brand` + `brand_bars.brands` 数组内的旧名，一处改名全局生效；重名校验；
   - **创建品牌**：输入名称即可建空品牌，展开后搜索加茶；
   - **删除品牌**：仅允许删除无茶品的品牌（有茶需先移出），删除时同步从品牌吧配置移除；
   - **茶品归属管理**（展开品牌）：搜索框支持「品牌 茶名/纯茶名/纯品牌」检索全站茶品 →「+ 划入」（`teas.brand` 改为该品牌，原品牌自动脱离）；现有茶品列表可「移出」（置「未知」）。
3. **品牌吧改为从现有品牌勾选**（`/admin/classics` 吧管理面板重做）：自由文本输入 → **品牌 chips 多选**（显示品牌名+茶品数）；新增吧先落本地再勾品牌（未勾品牌保存被拦：「请先勾选至少一个品牌」）；API 层双重校验（`brand-bars` POST 校验 brands ⊆ brands 表，不存在即 400 提示先去品牌管理创建）。
4. **R13 批量改品牌联动**：`POST /api/admin/teas/brand` 改到新品牌名时自动补建品牌行（幂等），保证品牌实体完整。
5. **部署**：commit `18c00b2`；先跑 0006 migration 再切流量；build #26 DONE 93.5s；activate 遇容器替换竞态（首次 activate 被中断后二次运行 docker daemon 报 no such container，但 compose 已拉起新容器）——验证：forum 200、容器跑新镜像、`rollback-20260910T062943Z-18c00b2` tag 在位、`/admin/brands` 307 守卫、API 403 守卫、classics 200。

**注意**：activate 首次运行被中断后，同 RID 二次运行会因 rollback tag/容器竞态报错——但镜像 tag 与容器实际已就位；以后避免中断 activate（总结经验）。

## R15 · 批量品牌运营 + 按品牌批量合并茶品（2026-09-10 已上线，release 20260910T092008Z-aab998f）

**用户需求**：① 品牌管理中茶品可批量移出**到其他品牌**（非仅未知）② 品牌下可搜索全站茶品**批量移入** ③ 茶品合并模块按品牌分组，品牌下**批量勾选多款合并**。

1. **`POST /api/admin/brands/teas` 增强**：新增 `toBrandId` 参数——批量移出目标品牌（校验存在 + 不可等于源品牌），默认仍「未知」（目标品牌行不存在自动补建）。
2. **新 API `POST /api/admin/teas/merge-batch`**：`{keepId, removeIds[]}` 批量合并——事务转移全部笔记/帖子到保留主体 → 被合并茶名去重进主体 aliases → 删除被合并茶 → `recomputeTeaStats(keepId)` 重算统计。返回 `{merged, moved:{tastingNotes, articles}}`。
3. **`/admin/brands` 批量操作 UI**：
   - 搜索候选区：checkbox 多选 + 全选/清空 + 「⬇ 批量移入所选 (N)」+ 保留单个「+ 移入」快捷；搜索结果支持「品牌 茶名 / 纯茶名 / 纯品牌」检索全站 2763 款；
   - 品牌内茶品列表：checkbox 多选（全选含未显示的全部）+ 吸顶操作条「⇨ 批量移出 (N)」+ **目标品牌下拉**（未知 + 全部其他品牌含数量）；
   - 切换品牌展开时自动清空勾选。
4. **`/admin/teas` 重写为按品牌合并**：品牌下拉（按茶品数降序，含数量）→ 品牌内茶品列表（☑ 勾选待合并 + ◉ radio 指定保留主体⭐，默认第一个勾选）+ 品牌内筛选框 → 吸顶「🔗 合并所选到主体」一键批量；右栏「疑似重复」品牌内相似度提示（阈值 0.4–1 可调，最多 50 对）每对「勾选这对」快捷；合并成功显示转移笔记/帖子数并从列表移除。
5. **部署**：commit `aab998f`；无 migration；build #26 DONE 94.2s；activate 完成（ACTIVATED + PREVIOUS 记录；curl 健康检查遇容器启动窗口 reset 一次，不影响）。线上验证：forum/classics 200、admin/brands 与 admin/teas 307 守卫、merge-batch POST 403 守卫 ✓。

## R16 · 已读降权·会话恢复（切 app 回来 / 黑屏点亮时重排）（2026-09-10 已上线，release 20260910T132308Z-ba5753b）

**用户复核发现缺口**：R12 的已读降权只在「进入页面（组件 mount）」拍快照，三个场景中两个不生效：
- ① 彻底重开（页面重新加载）→ 组件重新 mount，重拍快照 ✓ 原本就生效；
- ② 切换 app 回来（页面后台保活未销毁）→ 无监听，快照停留旧值 ✗；
- ③ 黑屏后点亮屏幕 → 同② ✗。

**修复**（`forum-feed.tsx`）：监听 `visibilitychange`——hidden 时记时间戳；visible 且离开 **≥10 秒**（防误触电源键/下拉通知栏扰动）时：重读 localStorage 已读记录刷新 `seenSnapshotRef` → 桌面端稳定排序刷新 seen/unseen 分组（组内相对顺序不变）→ bump `reorderTick` 触发移动端加权流按新快照重排（看过的 ×0.35 沉底）。**阅读中页面持续可见不会触发**，不破坏 R12「阅读中卡片不跳动」设计。

**运维事件**：本次部署首次 build 因服务器磁盘 99% 满（86G/88G，历史 58 个镜像 tag 61.6GB + build cache 15.1GB）失败 `no space left on device`。清理：删旧 puer-hub-app 版本 tag（仅保留当前 + rollback 各一）+ `docker builder prune -a` + dangling → 释放 48GB（99%→43%），旧 release 目录只留最近 2 个。**经验：以后每 2-3 个 release 清一次旧镜像**（`docker images | grep puer-hub-app` 手动 rmi，保留当前 + 上一版）。

**部署**：commit `ba5753b`；无 migration；重建 build #26 DONE 100.3s；activate 正常。线上验证：forum/classics 200、容器 R16 镜像、磁盘 48% ✓。

## R17 · 已读追踪根因修复：排序从未生效的真 Bug（2026-09-11 已上线，release 20260910T012439Z-9b5cd29）

**用户实测反馈**：关闭浏览器重开后内容无变化、看过多次的帖子仍排第一、「新」徽章不消失——怀疑 R16 没部署。排查确认 R16 已部署，但**R12 的已读机制本身从未真正工作过**，两个叠加 Bug：

1. **致命 Bug（根因）**：卡片容器 `<div>` 从未设置 `data-article-id` 属性，而 IntersectionObserver 回调靠 `entry.target.getAttribute("data-article-id")` 取 id——恒为 null → **`markSeen()` 一次都没执行过** → localStorage 已读记录为空 → 降权无数据可用、「新」徽章（条件 `!seen.has(id)`）永不消失。
2. **观察链路断死 Bug**：observer 的 useEffect 依赖 `[seen]`——每次标记已读都触发 disconnect 旧 observer + 创建新 observer，但已渲染卡片不会自动挂上新 observer（ref 回调仅在 DOM 挂载时执行）→ 标记一次后观察链路即断，直到其他 state 变化引起重渲染才偶然恢复。
3. **降权力度不足**：×0.35 柔性降权下，超热帖（推荐分 0.8+）降权后仍压过多数未读帖，用户感知"排序没变"。
4. **追加页盲区**：懒加载追加的 extraArticles 按服务端顺序 append，从不参与已读降权。

**修复**（`forum-feed.tsx`）：
- 卡片容器补 `data-article-id={article.id}`（根因修复）；
- observer 改永生单例（`[]` 依赖）+ 函数式 `setSeen`（引用相等时 React bail out，不触发多余渲染）；
- 移动端排序改**两级分组**：未读组在前（按推荐分）、已读组整组沉底（组内按分）——看过的帖子绝不排在未读之前，效果肉眼可见（替代 ×0.35）；
- 会话恢复重排（R16 的 visibilitychange）时把 extraArticles 并入首屏统一重排（id 去重），追加页已读同样沉底。

**部署**：commit `9b5cd29`；无 migration；build 因上次清了缓存全量重建较慢（#26 DONE 约 22 分钟）；activate 正常。线上验证：forum/classics 200、容器 R17 镜像、镜像内 chunk `0cnxeb073vejy.js` 含 `data-article-id` ✓。

**注意**：修复上线前的历史浏览不会补录（从未记录过）；上线后新浏览才开始累积已读记录。

## R18 · 刷新后旧帖回前的解释与冷启动兜底 + 茶品品牌全量重匹配（2026-09-11 已上线，release 20260911T020645Z-e424176）

**用户反馈**：R17 生效（已读沉底 ✓），但刷新后"旧的帖子又回到前几位"，怀疑程序回退旧版。排查：容器一直跑 R17 镜像（无回退、cron 仅 auto-reply）。**真相是数据冷启动**：R17 之前的历史浏览从未被记录（data-article-id bug 时期），用户认知中的"旧帖"在系统里是"未读"，按热榜分回到前排；且刷新后首屏卡虽被 observer 立即标记，但 mount 快照已拍，要等下次会话才沉底。

**修复**：mount 后 1.5s 兜底——重拍已读快照并重排一次（bump reorderTick）：首屏刚被标记的旧帖在本次会话内即沉底，"旧帖霸前"随浏览记录积累逐次消失。

**茶品品牌全量重匹配**（用户指令：茶名含品牌名的归对应品牌，识别不了的全归未知，确保品牌下无杂茶）：
- 备份：`teas_brand_backup_20260911`（id+brand，可回滚）；
- SQL：茶名 LIKE 品牌名（排除"未知"），**最长命中优先**（如"老班章"优先于"班章"），同长度按名称排序保证确定性；未命中 → 未知；
- 结果（2763 款全覆盖）：未知 1257→**1065**、大益→**744**、下关→**208**、福今→**120**、班章→**111**、观自在→**75**、宝和祥→**72**、今大福→**58**、昌泰→**52**、兴海→**43**、老班章→**40**…；"健身茶厂"0 命中成空品牌（可在品牌管理删除）；
- 校验：`teas.brand NOT IN brands.name` = 0 ✓（品牌实体完整）；线上 API 抽查归属正确。

**部署**：commit `e424176`；无 migration；build #26 DONE 90.9s（exporting layers 阶段因无缓存较慢约 10 分钟属正常）；activate 正常；forum/classics 200 ✓。

## R18b · 品牌数据修正：删除班章/老班章（产地非品牌）+ 黎明八角亭合并归档（2026-09-11，纯数据操作）

**用户指令**：① 班章、老班章是普洱产地名不是品牌，删掉这两个品牌行，旗下茶品按茶名重新归档到真实品牌（识别不了归未知）；② "黎明八角亭"涵盖黎明、八角亭两个牌号，茶名含"黎明"或"八角亭"的统一归该品牌。

**执行**（生产 SQL，沿用 `teas_brand_backup_20260911` 备份基线）：
1. 班章(111)+老班章(40)=151 款重匹配（剩余品牌最长命中优先）：陈升号 +14（如"2023-陈升号老班章"）、福今 +12（"2004-福今班章乔木生态"）、天弘 +4、观自在 +4、酽净 +4、其余 113 款纯"班章"茶名（如"班章六星孔雀"）→ 未知；
2. 茶名含"黎明"或"八角亭"的 58 款 → 黎明八角亭（黎明吧 brands={黎明八角亭} 原本就指向它）；
3. `DELETE FROM brands WHERE name IN ('班章','老班章')`；brand_bars 无班章引用无需清理。

**结果**：brands 表 34→**32** 个；福今 132、黎明八角亭 58、陈升号 31、未知 1122；校验 orphan（teas.brand ∉ brands）= 0 ✓、班章残留 0 ✓。

## R19 · 「每次进来还是那几个老帖」真根因：首屏窗口无未读可换 + 窗口不足自动归档补满（2026-09-12 已上线，release 20260912T030651Z-c2cb89e）

**用户反馈**：R17/R18 后仍"每次进入页面还是那几个老帖子"。

**排查**（三轮纸上推演无果后改用 Playwright 无头浏览器对线上实测，三轮逐步逼近）：
1. 复现脚本：手机 viewport 进入 → 滚动标记 → 刷新 → 前 10 位全是已读帖、位置 0-7 连续原序——确凿复现；
2. 加 console/pageerror 监听 + 预置 12 条已读再刷新：无任何 JS 报错，DOM 纹丝不动，localStorage 记录在；
3. **读 React fiber 内部 hooks 状态**（`__reactFiber$` 树遍历找 hook 最多的组件实例）逐项解码：`seen=Set(10)` 快照已拍 ✓、`isMobile=true` ✓、items useMemo deps 尾部 `,true,1` 证明 **1.5s 兜底已执行（reorderTick=1）且重排已跑** ✓——**已读机制全链路正常**；
4. 但 `orderedBase` 只有 **3 条**：`/forum` 默认 `tab=week`（周热榜窗口），本周仅 3 帖达标质量门槛 → SSR 首屏 3 张卡 → loadMore 归档续读 7 条（3 条与首屏重复被客户端去重）。

**真根因**：不是已读降权失灵，而是**首屏数据窗口太小**——3 张 week 帖全部读过时，已读组里没有未读帖可以顶上来（两级分组正确执行但结果不变）；append-only 的 7 条归档老帖不参与分组。用户每次进来看到的就是同样的 3+7 张老脸。week 窗口帖量随发帖量波动，此前窗口内帖子多所以"以前正常"。

**修复**（三处）：
- `forum-feed-server.ts`：热榜窗口不足一页时**自动归档续读填满 limit**（归档查询提取为 `fetchArchive` 公共函数；服务端按 id 去重窗口/归档交集，避免 SSR 重复 key；`hasMore = archive.length > need`）；
- `forum/page.tsx`：SSR 首屏显式 `limit: 24`（此前默认 60 但窗口只有 3 条时实际返回 3 条）；
- `forum-feed.tsx`：1.5s 冷启动兜底重排时把已加载的 extraArticles 并入首屏统一分组（与 R17 visibilitychange 同逻辑，覆盖"首屏加载快、兜底时追加页已到达"的场景）。

**部署波折**：rsync 首次传输被抢跑的 docker build 打断（prisma/schema.prisma 未到致 `prisma generate` 失败）；第二次 exclude 模式传了 1.1G 全 repo（上一 release 仅 3.7M）终止；第三次 `--files-from` 白名单但**该模式下 `-a` 不隐含递归**只建了空目录；最终 `rsync -a --recursive --files-from` 白名单（src/prisma/public/根配置文件，排除 src/generated 与 public/uploads）传 3.0M ✓。build 缓存命中较快；activate 正常。

**线上验证**（Playwright 端到端）：
- 首屏卡片 10 → **22 张**；
- 预置首屏前 12 条为已读 → 刷新 3.2s 后：前 10 位全为未读，12 条已读位置 `[10..21]` 连续沉底 ✓ 两级分组完美生效；
- 连续滚动加载 39 张卡**零重复** ✓ 分页游标一致；
- 守卫：forum 200、forum/classics 200、admin 307、API admin 403 ✓。

**运维**：清理旧镜像（保留 current + rollback + 上一版），磁盘 55%。Playwright 已加入 devDependencies，本次排查的浏览器级验证方法可复用（localStorage 预置已读 → 刷新 → 断言 DOM 顺序，及 fiber hooks dump）。

**教训**：
- 「排序没生效」类 bug，先 dump 框架内部状态（React fiber hooks）确认逻辑是否执行，再判断是逻辑 bug 还是**数据窗口问题**——本次机制三天前就是好的，缺的是可换的未读内容；
- rsync 部署改用 `--files-from` 白名单时必须显式 `--recursive`（`-a` 在该模式下不含递归）；
- 不要在 rsync 未结束时启动 docker build（验证 RSYNC_OK 后再 build）。

## R20 · 后台分页与品牌茶品管理重构（2026-09-12 已上线，release 20260912T064451Z-6c80b88）

**用户反馈**：① 经典审核台无论按待审核还是品牌筛选，只能看到第一页少量内容，剩余无分页（如品牌下 136 款只见到 21 个）；② 品牌管理同样问题（未知 1051 款只展示 100 款，没法处理）；③ 品牌内「移入」操作容易搞乱归属，应只保留「移出到其他品牌」；④ 搜索应改为**搜索本品牌**（而非全部茶品），搜索结果支持全选/取消全选。

**排查**：数据层 API 均正常（`/api/teas?limit=9999` 线上实测返回全量 2301 条）；截断全在前端——classics 页 `filtered.slice(0, 300)` 无分页 + 品牌下拉 `slice(0, 20)`；brands 页茶品列表 `slice(0, 100)` 硬截断。

**修复**：
- `admin/classics/page.tsx`：列表真分页（每页 50，上一页/下一页 + 跳页下拉；筛选条件变化自动回第 1 页；显示总数与页码）；品牌下拉展示**全部**品牌；datalist 茶品候选放开 slice(0,2000)。批量改品牌的「全选」仍作用于全部筛选结果（跨页）；
- `admin/brands/page.tsx` 茶品管理重构：
  - **移除跨品牌「移入」入口**（搜索候选区/批量移入/单项移入按钮及 addTeas 全部删除）——归属调整统一在茶品现属品牌侧「移出到其他品牌」完成，避免双向入口搞乱；
  - 搜索改为**本品牌内茶品过滤**（茶名/年份），搜索结果支持**全选/取消全选**（作用于全部结果，跨页保持勾选）；
  - 茶品列表**分页**（每页 100，上/下一页导航）——未知 1051 款可翻 11 页处理完；
  - 操作条保留：目标品牌下拉 + 批量移出 + 清空勾选；移出后自动清勾选。
- API 无改动（`/api/admin/brands/teas` 的 addTeaIds 分支保留但 UI 不再调用）。

**部署**：commit `6c80b88`；rsync 白名单（R19 流程）3.0M；build #26 DONE 99.5s；activate 正常。守卫：forum/classics 200、admin/brands 与 admin/classics 307、API 403 ✓。清理旧镜像（保留 current+rollback+上一版）。

**验收提示**：经典审核选品牌（如大益）→ 已发布经典 tab，可翻页看完 136 款；品牌管理 → 未知 → 茶品管理，1051 款分 11 页，搜索"班章"等关键词 → 全选结果 → 移出到目标品牌。

## R21 · 品牌茶品管理删除箱：软删除 + 还原 + 彻底删除（2026-09-12 已上线，release 20260912T085707Z-f5e9996）

**需求**：茶品管理批量操作旁增加「删除」；删除不直接物理删，先进**删除箱**；删除箱内可**还原**（回原品牌）与**彻底删除**（不可恢复）。

**实现**：
- **数据模型**：`Tea.deletedAt DateTime?`（migration `0007_tea_deleted_at.sql`：加列 + 索引，生产已执行 ✓）。NULL=正常；非空=在删除箱。软删不动 `brand` 字段——还原即回原品牌；软删时同步 `isClassic=false` 摘出经典模块。
- **API**：
  - `POST /api/admin/brands/teas` 新增 `{brandId, deleteTeaIds[]}` 分支：批量置 `deletedAt=now`（只作用于未在删除箱中的）；
  - 新端点 `/api/admin/brands/trash`：GET 列出删除箱（含 `_count` 笔记/帖子/茶会关联计数）；POST `{action:"restore"|"purge", teaIds[]}`——restore 置空 deletedAt；purge **物理删除但先查关联**，有品鉴笔记/帖子/茶会内容的茶品**拒删跳过**并返回明细（保护用户内容，需先在合并工具转移），无关联的直接删。
- **全站过滤**（软删茶品不再出现）：`/api/teas` 列表与计数、`/api/teas/[id]` GET、茶品详情页 SSR（findFirst，软删 404）、茶品百科 `/tea` 列表、`/forum/classics`（分组计数+热门池+主查询）、`sitemap.xml`、`admin/brands` 品牌茶数 groupBy。feed 内帖子关联茶品卡片未过滤（帖子本身仍有效，边缘 case 可接受）。
- **UI（admin/brands）**：勾选操作条新增「🗑 移入删除箱 (n)」（红色，confirm 二次确认）；页面顶部新增「🗑 删除箱（N）」按钮 → 红框面板：全选/批量还原/批量彻底删除 + 逐条还原/彻底删除；有关联内容的条目显示 ⚠ 计数警示（笔记/帖子/茶会，不可彻底删）；purge 后提示被跳过数量。

**部署**：commit `f5e9996`；**migration 先行**（加列前向安全，旧镜像不感知）；rsync 白名单（R19 流程）3.6M；build DONE；activate 一次成功（curl 健康检查遇容器启动窗口 reset 一次，不影响）。守卫：forum/classics/tea 200、admin/brands 307、新 trash API 403、brands/teas API 403 ✓。DB 验证：`deletedAt IS NOT NULL` 计数 0（初始空箱）、teas 总数 1973。清理旧镜像（保留 current+rollback+上一版），磁盘 59%。

**运维教训**：ssh 远程后台 nohup 构建时，`bash -c '...$RID...'` 单引号内的变量在后台 bash 中无值（且 `VAR=x` 尾参只是 `$0`）——正确姿势：本地写好脚本（变量写死字面量）→ scp → nohup 执行。

**验收提示**：品牌管理 → 打开某品牌 → 茶品管理 → 勾选若干 → 「移入删除箱」→ 顶部「删除箱（N）」→ 可见刚删的茶（含原品牌）→ 「还原」回到原品牌列表 / 「彻底删除」物理删除（有关联内容的会被跳过并提示）。

## R22 · 转化档案与图片墙付费会员预览锁定（2026-09-13 已上线，release 20260912T151315Z-d0a4e4b）

**需求（安全）**：茶品详情页「转化档案 · 历年品鉴」与「图片墙」存在内容被复制/不当利用风险；付费会员体系另行系统规划，先上**预览锁定**：非付费会员每条转化档案仅见前两行预览（后折叠）、图片墙仅两行渐变虚化且不可点击查看大图，点击查看详情提示「你暂时没有查看权限」。

**实现（核心原则：受保护内容不进 SSR HTML，view-source 拿不到）**：
- **权限预埋**：`src/app/(main)/tea/[id]/page.tsx` 中 `isPaidMember = false`（TODO 接付费体系）+ `canViewFullArchive = isAdmin || isPaidMember`（admin 豁免）——付费上线后改此一处即可。
- **转化档案**（非付费）：summary 服务端截断 64 字（约两行，尾部「……」）+ line-clamp-2；**时间线不再输出笔记首图**（cover=null）；条目尾部「完整品鉴内容仅付费会员可见」+ 🔒「查看完整品鉴 →」锁定按钮。
- **图片墙**（非付费）：仅前 10 张（桌面 5 列×2 行）图 URL 进 HTML；`<a target=_blank>` 改为纯 `<div>`（无链接、`pointer-events-none`、`draggable=false`）；容器底部白渐变锁定遮罩（`LockedWallOverlay`）：「🔒 会员专享 · 完整图片库仅付费会员可见 + 还有 N 张图」；标题计数显示 `10/107`。
- **hero 三级链**：非付费不再用笔记图兜底（仅茶品自身 cover/gallery），避免笔记大图全尺寸暴露。
- 新组件 `src/components/tea/locked-tip.tsx`（client）：`LockedTip`（行内锁定按钮+气泡）与 `LockedWallOverlay`（图片墙遮罩）；点击均提示「你暂时没有查看权限」，气泡 2.5s 自动消失。

**部署**：commit `d0a4e4b`；无 migration；rsync 白名单 3.6M；build DONE；activate 正常（容器跑新镜像，health 200）。守卫：forum/classics/tea 200、api/teas 200 ✓。清理旧镜像（保留 current+rollback+上一版）。

**线上实测**（测试对象 `2001-黎明7540`：9 条品鉴、107 张图，未登录视角）：
- 图片 URL：HTML 中恰好 10 张 `/uploads/evernote/*`，其余 97 张 URL **零泄漏**；
- 摘要：两条 500 字长笔记，前 64 字在 HTML、**第 64 字后全文片段 grep 不到**；
- 时间线笔记图 0 张；`target=_blank` 大图链接 0 个；锁定按钮/会员专享遮罩文案均在位。
- （注：grep 计数×2/×3 为 Next SSR HTML + flight payload 重复序列化，正常。）

**遗留（付费会员体系规划时统一处理）**：/tasting 品鉴 feed 的公开性、图片服务端水印、受保护内容 API 化（点击后鉴权拉取）、会员字段与支付接入、classics 列表缩略图策略。

**验收提示**：未登录/普通用户打开 https://puer.im/tea/04792cf7-3929-4d34-877e-59809c0e8b54 —— 转化档案每条仅两行预览+🔒按钮（点击提示无权限）；图片墙 10/107 张、底部渐变锁定（点击提示无权限）；右键查看源代码搜不到其余图 URL 与摘要全文。admin 登录后完整可见。





