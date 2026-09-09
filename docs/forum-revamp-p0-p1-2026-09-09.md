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

## 环境备忘

- 本地 build 需先 `npx prisma generate`（同步来的 src/generated 曾被新版 prisma
  污染，引用 `query_compiler_fast_bg` 而 6.19.3 runtime 无此文件；删除重生成即可）
- 服务器 postgres 未发布宿主端口，宿主脚本走容器网络 IP（cron-task.sh 动态解析）
