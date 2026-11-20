# 首页内联回复 P0：行为、验证与发布手册

范围只有 `/forum` 与 `/tw/forum` 的轻量讨论预览和逐条回复。作者推荐、关注流、个性化排序、首页根评论框、完整评论树、富文本、图片、投票、编辑/删除与私信均不在本 P0 内。

## 用户行为

- 有可见讨论的卡片默认展开预览；用户可收起，刷新后重新默认展开，不保存偏好。
- 最多显示两条最新真人顶层评论，按时间正序展示。只有零条可见真人顶层评论时，才最多显示一条带来源标注的 AI 评论。
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

## 发布顺序（本任务不执行部署）

功能开关是 `FEED_INLINE_REPLIES=1`，默认关闭。

1. **关闭开关部署新代码**。旧卡片行为不变，`surface="feed"` 返回 404 `comment.feed_disabled`。
2. **逐实例验证**：SSR/lazy 不含 comment 字段，旧详情 POST 的媒体、内容阈值和成功响应不变；匿名与登录态都确认 feed surface 404。
3. 确认所有实例都是新代码后，才逐实例开启开关。检查匿名/登录/本人待审、繁体、懒加载 `private, no-store`、错误日志与 AI-only 切片。
4. 若需要回滚，**先在所有新实例关闭开关**，再回滚代码。不要让新客户端的 feed 写请求落到不理解该 surface 的旧二进制上。

这里只提供手册；不得在本 P0 验证中修改生产 env、执行 cron/迁移、写生产业务数据或做生产盘点查询。

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
