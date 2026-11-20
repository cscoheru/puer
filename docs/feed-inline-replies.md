# 首页内联回复 P0：行为、验证与发布手册

范围只有 `/forum` 与 `/tw/forum` 的轻量讨论预览和逐条回复。作者推荐、关注流、个性化排序、首页根评论框、完整评论树、富文本、图片、投票、编辑/删除与私信均不在本 P0 内。

## 用户行为

- 有可见讨论的卡片默认展开预览；用户可收起，刷新后重新默认展开，不保存偏好。
- 最多显示两条最新真人顶层评论，按时间正序展示。AI 评论**默认不出现**，只有后台把站点开关
  `feed.aiReplies` 打开、且该帖零条可见真人顶层评论时，才最多显示一条带来源标注的 AI 评论。
- 关闭 `feed.aiReplies`（默认）时，`visibleReplyCount` 也**只算真人**：预览与计数必须同一口径，
  否则卡片会出现「查看全部 5 条回复」+「当前没有可预览的顶层回复」的自相矛盾。
- 每条初始预览评论和本次新创建的子评论都有“回复”，目标始终是它自己的真实评论 ID。
- “查看全部”进入帖子详情 `#comments`。首页不是完整评论树，但计数覆盖当前 GET 可见的整棵树。
- 本人待审评论只对自己可见并明确标注；匿名读者看到“登录后回复”。
- 确定失败保留草稿且不自动重试；结果未知时同样保留草稿，要求先到详情核对，只能由用户显式确认后手动重试。

### 读取契约

每张卡片只在 flag 开启时携带：

```ts
commentPreview: FeedCommentPreviewItem[] | null;
visibleReplyCount: number | null;
commentLoadId: string;
```

`[]` 是成功读到的空预览，`null` 是读取失败，绝不能把失败渲染成“没有评论”。预览与计数分别通过 `Promise.allSettled` 降级。每个非空页面只有候选预览与分组计数两次数据读取，没有逐卡片 HTTP 或逐卡片 SQL。

### 站点级开关：`feed.aiReplies`

首页要不要露 AI 评论是运营决策，不是部署决策，所以放在数据库而不是 `.env`：

| 项 | 值 |
|---|---|
| 存储 | `site_settings` 表，`key = 'feed.aiReplies'`，`value` 取 `'1'` / `'0'` |
| 后台入口 | `/admin/settings` → 功能开关 →「首页内联回复 · 展示 AI 评论」 |
| 接口 | `GET/PUT /api/admin/settings/feed-ai-replies`（`admin:settings` 权限） |
| 生效 | 保存后本进程立即失效缓存；只影响 `/forum`、`/tw/forum` 的预览与计数 |
| 默认 | 关闭。表里没有这行、值为 `'0'`、读取失败，一律按关闭处理 |

读路径在 `src/lib/site-settings.ts`：30 秒进程内缓存 + 失败不缓存（一次数据库抖动不会把错误
状态锁半分钟），后台保存时主动失效并带版本号防回写（在途查询不会把刚关掉的旧值重新钉回缓存）。
关闭时 AI 分支**根本不进 SQL**（不是读完再丢），计数也同步收窄。详情页的评论树
不受该开关影响——那里本来就带来源标注。

不在后台改也行（应急，裸 psql 即可；`updatedAt` 有 DB 默认值）：

```sql
INSERT INTO site_settings(key, value) VALUES ('feed.aiReplies', '0')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

psql 改完最多 30 秒生效（进程内缓存 TTL）。注意：`20261120_site_settings` 之前的旧镜像
**不读这张表**，回滚镜像 = AI 预览回来。

候选上限为 `3N`，最终预览上限为 `2N`，评论正文最多 1024 个 Unicode code point。读取使用局部 `statement_timeout=1500ms`。懒加载 `/api/forum/feed` 返回 `Cache-Control: private, no-store`、`Vary: Cookie` 和同一个 `X-Comment-Load-ID`；它是关联 ID，不是幂等键。

## 一键隔离 QA

### 支持的前置状态

- macOS，Node 与仓库依赖已安装（`npm install`）。
- Prisma Client 已生成（`npx prisma generate`）。
- PostgreSQL 16 的 `initdb`、`pg_ctl`、`psql`、`createdb` 在 `PATH` 中。
- Playwright Chromium 已安装（`npx playwright install chromium`）。

不需要已有数据库、schema、seed、dev server、登录会话或任何真实 AI key。

```bash
npm run qa:feed:inline
```

这是唯一需要执行的命令。它会：

1. 复制运行所需源码到临时 staging，断言根目录没有 `.env*`；只软链 `node_modules` 与已生成的 Prisma Client。
2. 在随机 loopback 端口初始化 UTF-8 PostgreSQL 16，按当前 Prisma schema 建表并生成确定性的用户、帖子与评论。
3. 启动仅监听 `127.0.0.1` 的 OpenAI 兼容审核替身。默认文本发布，`[qa:pending]` 进入待审；隔离库另外播种 `[qa:reject]` 本地敏感词，走真实硬拒绝分支。
4. 用明确 env allowlist 启动 Next dev。不会继承本机 `DATABASE_URL`、DeepSeek/Ark/GLM/Kimi/MiniMax key 或其他 secret。
5. 通过 `NODE_OPTIONS=--require` 加载 socket egress guard；guard 未确认加载时结果为 **BLOCKED**，不会用 mock 结果冒充浏览器通过。
6. 真实 Chromium 先跑 flag-off，再跑 flag-on 的桌面、移动、繁体、登录、发布、待审、拒绝、未知结果、重复点击、草稿隔离、键盘焦点、懒加载与触摸目标矩阵。
7. 将截图、dev/PostgreSQL/浏览器日志、`browser-*-results.json` 与 `summary.json` 写入 `.gstack/qa-reports/feed-inline-<timestamp>/`，最后只清理本次拥有的进程组、数据库和临时目录。

Next webpack dev server 会无条件尝试读取 npm dist-tags 用于版本提示；guard 会阻止它，日志中只把这个确切的 `registry.npmjs.org` 记为开发器版本探针。任何其他非 loopback 主机都使运行失败。浏览器 context 也独立阻断所有非 loopback 请求。

退出码：`0` 通过，`1` 有检查失败，`2` 前置条件或隔离能力缺失（BLOCKED）。不要根据进程消失猜测结果，看 `summary.json` 和命令退出码。

### 真实 PostgreSQL 集成测试

需要本机 PostgreSQL 16。两个变量必须指向同一个一次性 loopback 库：`DATABASE_URL` 决定产品读取层在 import 时绑定的库，缺它或指向别处脚本会直接拒绝运行，不会静默读错库。

```bash
FEED_INLINE_TEST_DATABASE_URL='postgresql://user@127.0.0.1:5432/qa' \
DATABASE_URL='postgresql://user@127.0.0.1:5432/qa' \
npm run test:feed:integration
```

不要用 `npm run test:unit` 跑这份文件：其中两个路由测试需要 `--experimental-test-module-mocks`，普通 `node --test` 下它们会带提示跳过，而不是冒充通过。

`npm run test:feed:integration` 自带 `FEED_INLINE_REQUIRE_DB=1`：两个变量没配对时套件直接失败，而不是静默跳过报绿。「全部跳过」永远不算通过。

### 性能证据

显式提供一个 loopback 测试库后运行：

```bash
DATABASE_URL='postgresql://user@127.0.0.1:5432/qa' \
FEED_INLINE_TEST_DATABASE_URL='postgresql://user@127.0.0.1:5432/qa' \
node --import tsx scripts/qa-feed-inline-perf.mjs
```

脚本只清理自己创建的 `qa-perf-*` fixture。baseline 是同等功能的逐帖 `2N` 次读取，不是声称旧首页已有评论预览；branch 执行生产代码导出的同一组 SQL builder。输出包括机器/PostgreSQL/fixture 元数据、交错 baseline/branch p50/p95、新连接与 warm 样本、真实 `EXPLAIN (ANALYZE, BUFFERS)`、候选/正文/分组边界以及锁表造成的真实 statement-timeout 双路降级。新连接不等于清空 OS page cache，报告明确保留这个区别。

### 本次隔离验收记录

2026-11-20 终验（代码审查修复后重跑）：在 Apple M1 Pro（8 核）、Node `v24.13.0`、PostgreSQL `16.14` 上，`npm run qa:feed:inline` 一条命令实测 **58 秒**，flag-off **2/2**、flag-on **21/21** 通过，意外外联主机为 0。证据保存在 `.gstack/qa-reports/feed-inline-2026-11-20T10-22-12-127Z/`。同一天更早的复测记录为 `.gstack/qa-reports/feed-inline-2026-11-20T10-03-37-077Z/`（58 秒，同矩阵）与 `.gstack/qa-reports/feed-inline-2026-11-20T09-38-42-291Z/`（57 秒，同矩阵），首次验收为 2026-11-18（58 秒）`.gstack/qa-reports/feed-inline-2026-11-18T13-26-34-851Z/`；其中 `summary.json.tthw` 只表示自动化的 wall-clock 时间，不代表人的阅读或理解时间。

性能报告 `.gstack/qa-reports/feed-inline-perf-2026-11-20T10-21-59-120Z.json` 使用 300 帖、50,080 条评论（含 29 个千评论帖和一个两万评论帖）：N=24/30/300 的查询数分别从 48/60/600 降为 2；warm branch p95 分别为 **1.154ms / 1.078ms / 19.787ms**（同轮 baseline 为 14.931ms / 17.467ms / 173.232ms），新连接 branch p95 为 2.571ms / 2.274ms / 20.664ms。`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` 已覆盖 N=24 和 N=300 的两种生产 SQL。锁表触发真实 statement timeout 后，两路均在约 **1.52s** 降级为 `null`，且脚本断言两路的失败类别确实都是 `statement_timeout`——不是任意数据库错误造成的空结果。这些数字只属于上述本机与数据集，不是生产延迟承诺。

## 可观测性

- 每次 feed 写请求有 `X-Request-ID`；problem JSON 中返回同一个 `requestId`。
- 每次 feed 批量读取有 `commentLoadId`，SSR DTO 与懒加载响应头都可关联。
- 读取失败只记录 load ID、preview/count、卡片数和错误类别，不记录正文或凭据。
- 写入日志只记录 request ID、路由、surface、状态、目标类型、gate、是否嵌套、稳定错误类别，以及已创建评论 ID/父作者是否合成账号（存在时）。AI-only 预览量可由发布后的单独效果切片观察；不能拿真人互动指标替代。

## 发布顺序

功能开关是 `FEED_INLINE_REPLIES=1`，默认关闭。

2026-11-20 起还有第二个开关 `feed.aiReplies`（见上节），默认关闭，存在数据库里、后台可改。
带上它的版本需要先跑迁移 `20261120_site_settings`（只建 `site_settings` 一张空表，幂等），
否则读开关会走失败分支 → 按关闭处理（功能不坏，但后台改不动它）。

1. **关闭开关部署新代码**。旧卡片行为不变，`surface="feed"` 返回 404 `comment.feed_disabled`。
2. **逐实例验证**：SSR/lazy 不含 comment 字段，旧详情 POST 的媒体、内容阈值和成功响应不变；匿名与登录态都确认 feed surface 404。
3. 确认所有实例都是新代码后，才逐实例开启开关。检查匿名/登录/本人待审、繁体、懒加载 `private, no-store`、错误日志与 AI-only 切片。
4. 若需要回滚，**先在所有新实例关闭开关**，再回滚代码。不要让新客户端的 feed 写请求落到不理解该 surface 的旧二进制上。

### 2026-11-20 生产发布记录（puer.im，单实例）

镜像 `puer-hub-app:20261120T1045Z-feedinline` 在服务器上构建（`next build` 含类型检查），容器按
`docker-compose.yml + docker-compose.override.yml + /tmp/app.switch.override.yml` 三件套重建。
发布时只同步了本功能的 19 个源码文件，未同步 R31（Ark Agent Plan）相关文件——镜像内
`/api/plan/v3` 命中数为 0，GLM/DeepSeek 兜底链保持 R30 原样。

- 关闭态实测：`/forum`、`/tw/forum` 均 200；`/api/forum/feed?offset=0` 返回 10 条且不含
  `commentPreview`/`visibleReplyCount`/`commentLoadId`；匿名 `surface="feed"` POST 返回
  404 `application/problem+json` + `comment.feed_disabled` + requestId；legacy 详情 POST 仍 401。
- 开启态实测（`.env` 追加 `FEED_INLINE_REPLIES=1` 后重建）：上述三字段齐全，10 张卡 9 张有预览、
  单卡 ≤2 条、整页共用一个 `commentLoadId`、无 `null`（无读取失败）；懒加载响应头为
  `Cache-Control: private, no-store`、`Vary: Cookie`、`X-Comment-Load-ID`；匿名 feed POST 转为
  401 `comment.unauthenticated`；legacy 详情 POST 仍 401；容器日志无错误。
- 回滚：把 `/tmp/app.switch.override.yml` 的 image 指回 `20261106T0748Z-aicompose`
  再 `up -d --no-build --no-deps app`；若要连功能一起停，先 `FEED_INLINE_REPLIES=0` 重建。
  **回滚镜像会同时撤销 `feed.aiReplies`**：旧镜像不读 `site_settings`，想保留「不展示 AI
  评论」这个决定就不能回滚镜像，只能停 `FEED_INLINE_REPLIES`。
- 隔离 QA 的种子数据会写入 `feed.aiReplies = '1'`（`scripts/qa-feed-inline-seed.mjs`），
  好让浏览器矩阵继续覆盖 AI 兜底与含 AI 的整树计数；关闭态由 unit 与 integration 测试覆盖。

#### 2026-11-20 `feed.aiReplies` 上线（镜像 `puer-hub-app:20261120T1158Z-feedflag`）

- 迁移 `20261120_site_settings` 用裸 psql + `ON_ERROR_STOP=1` 执行，随后用
  `information_schema` 独立确认 4 列与 `updatedAt` 的 `CURRENT_TIMESTAMP` 默认值，
  表内 0 行 → 开关默认关闭。
- 只同步本次提交的 12 个文件（`rsync --files-from`，清单由 `git show --name-only` 生成）；
  同步前后生产 `.env` sha256 一致（`307f46fa…c44f`）。
- 镜像在服务器 `docker build --no-cache` 构建（schema 变了，必须重烤 Prisma client），
  构建后 `docker builder prune -f` 把磁盘从 80% 降到 65%。
- 线上验证：`/forum`、`/tw/forum`、帖子详情均 200；匿名 `GET /api/admin/settings/feed-ai-replies`
  返回 403「无权执行此操作」；feed 10 张卡中 0 张含 AI 预览，真人预览保留（2 张卡）。
  最能说明口径的一条：帖子 `ce968828…` 库里是 **3 条 AI 顶层评论 + 1 条真人嵌套评论**，
  线上显示 `visibleReplyCount=1`、`commentPreview=[]` —— AI 既不进预览也不进计数，
  真人嵌套仍计入整树。
- 回滚：把 `/tmp/app.switch.override.yml` 指回 `20261120T1045Z-feedinline` 再
  `up -d --no-build --no-deps app`。**回滚等于恢复 AI 预览**（旧镜像不读 `site_settings`）。


## 失败语义速查

| code | HTTP | 用户恢复 |
|---|---:|---|
| `comment.invalid_input` / `invalid_json` | 400 | 修改输入；草稿保留 |
| `comment.invalid_input`（请求体过大） | 413 | 请求体上限 16 KiB；problem 的 `context` 给出 `field`/`unit`/`limit`，裁短后重发（同样保留草稿，不自动重试） |
| `comment.unauthenticated` | 401 | 新标签页登录，回来手动发布 |
| `comment.forbidden` | 403 | 到详情查看账号状态 |
| `comment.rate_limited` | 429 | 按 `Retry-After` 等待，手动重试 |
| `comment.parent_conflict` | 409 | 打开详情核对父评论后允许一次手动重试 |
| `comment.moderation_rejected` | 400 | 修改内容；不自动重试 |
| `comment.feed_disabled` | 404 | 改走详情 |
| `comment.outcome_unknown` | 500 | 可能已写入；先核对详情，显式确认后才允许手动重试 |

problem 响应使用 `application/problem+json; charset=utf-8`、`private, no-store`，不泄露 stack。
