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
# Usage: cron-task.sh <auto-reply|auto-vote|auto-boost-new|auto-post>
# On failure an [ALERT] line is appended to backups/health-alerts.log
# (same file the site-down check writes to).

set -uo pipefail
cd /opt/puer-hub

TASK="${1:?usage: cron-task.sh <auto-reply|auto-vote|auto-boost-new|auto-post>}"

log_alert() {
  echo "[ALERT] $(date -Is) cron-task($TASK): $1" >> /opt/puer-hub/backups/health-alerts.log
}

# ── env from .env ────────────────────────────────────────────────────
DB_PWD=$(grep -E "^DB_PASSWORD=" .env | head -1 | cut -d= -f2- | tr -d '"')
DEEPSEEK=$(grep -E "^DEEPSEEK_API_KEY=" .env | head -1 | cut -d= -f2- | tr -d '"')

# ── resolve postgres container IP (docker network) ───────────────────
PG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' puer-hub-postgres 2>/dev/null)
if [ -z "${PG_IP}" ] || [ -z "${DB_PWD}" ]; then
  log_alert "missing postgres IP or DB_PASSWORD"
  exit 1
fi

export DATABASE_URL="postgresql://puerhub:${DB_PWD}@${PG_IP}:5432/puerhub"
export DEEPSEEK_API_KEY="${DEEPSEEK}"

run() {
  "$@" || { log_alert "command failed: $*"; exit 1; }
}

case "$TASK" in
  auto-post)
    export AUTO_TEA_DRAFT_AUTHOR_ID="cmpb7net1000001ocrss0o4de"
    export AUTO_TEA_DRAFT_BOARD_ID="169748e7-123e-40f5-b283-b016c83f9c32"
    run ./node_modules/.bin/tsx scripts/auto-post.mjs --apply
    ;;
  auto-reply|auto-vote|auto-boost-new)
    run node "scripts/${TASK}.mjs"
    ;;
  *)
    echo "unknown task: $TASK" >&2
    exit 64
    ;;
esac
