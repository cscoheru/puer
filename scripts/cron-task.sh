#!/bin/bash
# cron-task.sh — run content-pipeline scripts on the HOST (2026-09-09)
#
# Background: the 20260901 app image lacks `pg` in node_modules and
# auto-boost-new.mjs was never bind-mounted into the container, so the
# container-side crons for auto-reply / auto-vote / auto-boost-new all failed
# with MODULE_NOT_FOUND (0 comments in the 7 days prior to the fix). The host
# /opt/puer-hub/node_modules has pg + tsx, and the postgres container is only
# reachable via its docker-network IP (no host port published), which we
# resolve dynamically here — replacing the fragile hardcoded 172.18.0.2 in
# auto-post-cron.sh.
#
# Usage: cron-task.sh <auto-reply|auto-vote|auto-boost-new|auto-post|minimax-health|ai-news-draft|rag-post|baseline-report|cellar-reminders>
# On failure an [ALERT] line is appended to backups/health-alerts.log
# (same file the site-down check writes to).

set -uo pipefail
cd /opt/puer-hub

TASK="${1:?usage: cron-task.sh <auto-reply|auto-vote|auto-boost-new|auto-post|minimax-health|ai-news-draft|rag-post|baseline-report|cellar-reminders>}"

log_alert() {
  echo "[ALERT] $(date -Is) cron-task($TASK): $1" >> /opt/puer-hub/backups/health-alerts.log
}

# ── env from .env ────────────────────────────────────────────────────
DB_PWD=$(grep -E "^DB_PASSWORD=" .env | head -1 | cut -d= -f2- | tr -d '"')
# R27:AI 自动任务由 DeepSeek 切换到 MiniMax(与容器内 src/lib 同一 key)
MINIMAX=$(grep -E "^MINIMAX_API_KEY=" .env | head -1 | cut -d= -f2- | tr -d '"')
# 茶仓可见性(与容器内同一份口径)。cellar-reminders 要用 cellarVisibleTo 判定
# 「这个人能不能看见茶仓」—— 少了这三个变量,脚本会以为谁都看不见而一条不发。
FEATURE_CELLAR=$(grep -E "^FEATURE_CELLAR=" .env | head -1 | cut -d= -f2- | tr -d '"')
CELLAR_UIDS=$(grep -E "^CELLAR_UIDS=" .env | head -1 | cut -d= -f2- | tr -d '"')
EDITOR_AUTHOR_UIDS=$(grep -E "^EDITOR_AUTHOR_UIDS=" .env | head -1 | cut -d= -f2- | tr -d '"')

# ── resolve postgres container IP (docker network) ───────────────────
PG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' puer-hub-postgres 2>/dev/null)

case "$TASK" in
  minimax-health)
    # R28e: MiniMax 余额/API 健康探针 — 不需要 DB,只调 API 一次
    if [ -z "${MINIMAX}" ]; then
      log_alert "missing MINIMAX_API_KEY"
      exit 1
    fi
    export MINIMAX_API_KEY="${MINIMAX}"
    # minimax-health-check 自己处理 ok/alert 状态;非零退出码视为探针异常
    node scripts/minimax-health-check.mjs || log_alert "minimax-health probe exited $?"
    ;;
  *)
    if [ -z "${PG_IP}" ] || [ -z "${DB_PWD}" ]; then
      log_alert "missing postgres IP or DB_PASSWORD"
      exit 1
    fi
    export DATABASE_URL="postgresql://puerhub:${DB_PWD}@${PG_IP}:5432/puerhub"
    export MINIMAX_API_KEY="${MINIMAX}"

    run() {
      "$@" || { log_alert "command failed: $*"; exit 1; }
    }

    case "$TASK" in
      auto-post)
        # R26/R27:必须容器内跑 — slideshow 视频依赖容器 /app/public/uploads(宿主机无此路径)。
        # AI(茶记 adapt)R25 起走 MiniMax,经 -e 透传 MINIMAX_API_KEY。
        # AUTO_TEA_DRAFT_ADAPT=1 打开 Phase D 的 grounded 改写 —— 这个开关曾漏传,
        # 密钥透传了但 adaptOn 恒 false,于是每日草稿全是 assemble.ts 的逐字拼装,
        # 从未经模型改写。两个 env 必须成对出现,少一个改写路径就整条不跑。
        run docker exec -e DATABASE_URL -e MINIMAX_API_KEY \
          -e AUTO_TEA_DRAFT_ADAPT="1" \
          -e AUTO_TEA_DRAFT_AUTHOR_ID="cmpb7net1000001ocrss0o4de" \
          -e AUTO_TEA_DRAFT_BOARD_ID="169748e7-123e-40f5-b283-b016c83f9c32" \
          puer-hub-app ./node_modules/.bin/tsx scripts/auto-post.mjs --apply
        ;;
      auto-reply|auto-boost-new|rag-post)
        # 宿主机直跑(仅 DB+AI 调用,无 /app 文件路径依赖;pg 模块在宿主机 node_modules)
        # rag-post 额外读宿主机 rag-data 语料(茶问 /ask 同一份知识库)
        run node "scripts/${TASK}.mjs"
        ;;
      baseline-report)
        # 每日真实读者/指标基线（PRD v0.3 §12 第 2/4 步）。两个报表都是只读的
        # 统计脚本，输出落到按日期命名的文件里，便于看趋势。
        # 保留最近 90 天的报表（够覆盖 PRD 的 90 天窗口）。
        OUT_DIR="/opt/puer-hub/backups/baselines"
        mkdir -p "$OUT_DIR"
        STAMP=$(date -u +%Y%m%d)
        {
          echo "===== 真实读者基线 ====="
          node --import tsx scripts/reader-baseline.mjs 2>&1
          echo
          echo "===== 真实用户指标基线 ====="
          node --import tsx scripts/real-metrics-baseline.mjs 2>&1
        } > "$OUT_DIR/$STAMP.txt" 2>&1 || log_alert "baseline-report failed"
        find "$OUT_DIR" -name "*.txt" -mtime +90 -delete 2>/dev/null || true
        log_msg="baseline report written: $OUT_DIR/$STAMP.txt"
        echo "$log_msg"
        ;;
      ai-news-draft)
        # R29:PentAGI 每周检索成果 → AI 忠实改写 → 草稿箱(不直接发布)。
        # 宿主机直跑:脚本从 pentagi-vps 经 ssh+rsync 拉成果包到 rag-data/news-artifacts,
        # 再查库+调 MiniMax 改写+写 status=draft。需要能免密 ssh 到 pentagi-vps
        # (authorized_keys 一次性配置)。拉不到远端不致命:本地已有目录照常处理。
        # --apply 才写库;脚本默认 dry-run。
        export PENTAGI_ARTIFACT_HOST="${PENTAGI_ARTIFACT_HOST:-pentagi-vps}"
        run node --import tsx scripts/ai-news-draft.mjs --apply
        ;;
      cellar-reminders)
        # F4 复饮提醒(PRD v0.3 §7 Phase 4):给到期的茶仓条目发一条站内通知。
        # 宿主机直跑(裸 pg + tsx 加载 src/lib/cellar-reminder.ts 的纯逻辑)。
        # 可见性要用**与前台同一份**口径(cellarVisibleTo)→ 茶仓开关与两个
        # 白名单必须在这里 export,否则脚本会以为谁都看不见茶仓而一条不发。
        export FEATURE_CELLAR="${FEATURE_CELLAR:-}"
        export CELLAR_UIDS="${CELLAR_UIDS:-}"
        export EDITOR_AUTHOR_UIDS="${EDITOR_AUTHOR_UIDS:-}"
        run node --import tsx scripts/cellar-reminders.mjs --apply
        ;;
      *)
        echo "unknown task: $TASK" >&2
        exit 64
        ;;
    esac
    ;;
esac
