# 服务器-本地同步记录（2026-09-08）

puer.im 长期采用「直接同步服务器」开发模式，本地与服务器文件脱节。本次同步以
「内容较新/较完整」为准逐文件裁定，恢复「本地 → commit/git → deploy 服务器」流程，
并将本地目录初始化为独立仓库推送 GitHub（cscoheru/puer）。

## 判定基准

- 服务器（puer-hk, /opt/puer-hub）为 UTC 时区；本地 macOS 为 CST（UTC+8）。
- 2026-09-01 曾通过 deploy.sh 镜像部署（puer-hub-app:20260901T132920Z-8a1a821d，
  基线 commit 8a1a821d），因此本地 9/1 的 prisma 6 降级与论坛修复为最新部署状态。
- 服务器上 8/21–8/23 直接开发的「茶问」功能（W1–W4 迭代）比本地新。

## 从服务器拉取（服务器较新 / 本地缺失）

- `src/app/(main)/ask/page.tsx` — W3-1 结构化拒答（refusal）、W1-4 前端 2 分钟超时
- `src/app/api/upload/route.ts` + `src/lib/upload-policy.ts` — W1-5 HEIC/AVIF → JPEG 入库转码
- `src/app/api/views/route.ts` + `src/components/view-beacon.tsx` — 浏览量统计（本地原缺）
- `Dockerfile` — font-noto-cjk 字体 + tea-draft runner 全量 node_modules overlay
- `.dockerignore` — T8：uploads/backups 不作为构建输入
- `tsconfig.json` — exclude 增加 backups
- `rag-service.yml`、`docker-compose.override.yml` — 茶问 RAG 服务编排
- `scripts/auto-*`、`fetch-jamendo-music`、`regenerate-videos`、`snapshot-views.sql` 等 — 内容自动化
- `check_dedup.py`、`diff_cy.py`、`gen_manifest_run.py`、`rebuild_dedup_embeddings.py` — RAG 维护脚本
- `rag-src/` 整目录 — 茶问 RAG 后端（v1→v20 演进；活跃版 v20-w1-base；含服务器 git 历史
  备份 `rag-src/.git-history.bundle`，未提交的工作区状态以文件形式完整保留）

## 保留本地（本地较新，多为 9/1 prisma 6 降级修复）

- `package-lock.json`、`src/lib/prisma.ts` — prisma 7.8.0 → 6.19.3 降级
- `src/lib/article-publish.ts` — 绕过 adapter-pg P2022 + 发布重置 createdAt
- `src/app/(main)/forum/page.tsx`、`src/components/forum-feed.tsx` — ⏰ 最新 tab（updatedAt 排序）
- `src/lib/tea-drafts/assemble.test.ts` — 附件占位符测试
- `.gitignore` — 追加 /public/uploads/ 及本文件所列大数据排除

## 不纳入版本库（.gitignore）

`.env*`、`public/uploads/`（运行时上传）、`evernote_export/`（原始导出 3k+ 文件）、
`w1-staging/`（服务器暂存，内容已并入 src）、`backups/`、`node_modules/`、
`ws-server/dist/`、`*.npy`（预计算嵌入）、`rag-src/v20-w1/out/`、
`puer-ai` 中的数据集/模型检查点/图片缓存（dataset_v*、img-cache、m2-artifacts/v*、
*.safetensors、m2-upload.tar.gz、rag-data、donghe-images、extracted-media、ocr-render）、
`rag-src/.git-history.bundle`。

## 备注

- 服务器 rag-src 自身的 .gitignore（忽略 v1–v19 历史快照与 stale 顶层文件）继续生效。
- puer-ai/ 为「茶问」AI 工作区（eval 题库、M1 数据引擎、M2 蒸馏实验），8 月中旬开发，
  功能尚不完备；其大数据资产不入库，仅追踪代码与小型数据文件。
- 服务器 `/opt/puer-hub` 目录今后仅作部署目标，不再直接编辑。
