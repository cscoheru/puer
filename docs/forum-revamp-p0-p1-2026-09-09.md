# 论坛改版 P0+P1 记录（2026-09-09）

背景：首页热榜长期不更新（top20 中 19/20 为 26-77 天老帖）、日均真人发帖 0.3、
近 7 天评论数为 0。诊断确认三大根因后按用户决策先做 P0+P1。

## P0 — 修复内容管道（当天完成）

**根因**：20260901 app 镜像 node_modules 缺 `pg`、auto-boost-new.mjs 未挂载，
容器侧 3 条 cron 全部 MODULE_NOT_FOUND；auto-post-cron.sh 硬编码 postgres IP。

**修复**：新增 `scripts/cron-task.sh`（统一 wrapper，宿主执行，动态解析
puer-hub-postgres 容器 IP，从 .env 注入 DB/DeepSeek 凭据，失败写
`backups/health-alerts.log`）。服务器 crontab 23 条管道任务全部切换到该 wrapper
（原表备份于 `backups/crontab-backup-20260909.txt`）。

**验证**：auto-vote 20票+7赞+20关注 ✅；auto-boost-new 2 帖 +9票+3回复 ✅；
auto-reply 依赖恢复（当日轮空属正常，每天 20 次）。

**遗留**：auto-post 每天报 draft_already_exists——草稿池耗尽（159 archived /
4 draft），属 P2 内容供给范畴。

## P1 — 热榜时间窗口改版（v4.0）

改动：`src/app/(main)/forum/page.tsx`、`src/components/forum-feed.tsx`。

- Tab：🔥今日(24h 自动扩窗) / 📅本周(7d+回复复活，默认) / 🏆月榜(30d) / 最新 / 精华
- 旧 `?tab=hot` → week；窗口内计分沿用 v3.0 质量优先公式
- pinned 置顶、jitter、冷门突围、作者多样性、已读降权全部保留
- 算法文档更新至 v4.0（docs/hot-ranking-algorithm.md）

本地验证：tsc 仅 2 个预存在错误（与本次无关）；next build 通过
（0 错误，69/69 静态页）。

### 部署记录（release 20260909T130320Z-fc9d479）

- 本地 Mac 为 arm64、服务器 x86_64 → 不能本地 docker build；按 deploy.sh
  语义手动执行：git worktree 基线(1098d09) + APP_CONTEXT 组装 context
  （排除 src/generated、public/uploads）+ overlay 2 个前端文件 →
  rsync 服务器 release 目录 → 服务器 docker build
- 顺手补齐 9-8 同步遗漏的 `prisma.config.ts`（生产有但本地仓库无）；
  其 `datasource.url` 在 prisma 6.19.3 类型下需 `?? ""` 兜底，否则
  镜像内 next build 类型检查失败（首次构建因此失败，修复后通过）
- 激活：旧镜像打 `rollback-20260909T130320Z-fc9d479` tag +
  `app.active.override.yml` + `docker compose -f docker-compose.yml -f <override>
  up -d --no-deps --no-build app`
- 验证：容器 Up 运行新镜像；外部 `/forum`、`?tab=day/week/month/hot` 全 200；
  页面含新 tab 栏；day/week/month 内容分化（2/2/5 threads，月榜已换血；
  今日/本周帖少是当前数据现状，随 P0 管道恢复与 P2 内容供给会充实）

### 回滚

```bash
cd /opt/puer-hub && docker compose -f docker-compose.yml \
  -f releases/20260909T130320Z-fc9d479/app.rollback.override.yml \
  up -d --no-deps --no-build app
# rollback.override.yml 指向 puer-hub-app:rollback-20260909T130320Z-fc9d479（需先创建该文件）
```


## 环境备忘

- 本地 build 需先 `npx prisma generate`（同步来的 src/generated 曾被新版 prisma
  污染，引用 `query_compiler_fast_bg` 而 6.19.3 runtime 无此文件；删除重生成即可）
- 服务器 postgres 未发布宿主端口，宿主脚本走容器网络 IP（cron-task.sh 动态解析）
