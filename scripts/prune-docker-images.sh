#!/usr/bin/env bash
# prune-docker-images.sh — 清理服务器上的旧镜像与构建缓存。
#
# 为什么需要它（2026-10-21 事故）：
#   服务器磁盘 88G，被 25 个镜像（61.6G）+ 构建缓存（35.2G）压到 100%，
#   表现为 docker build 卡在 `COPY --from=deps` —— 实际是 ENOSPC，
#   很容易被误判成网络或 SSH 断连。
#   根因是流程缺一步：每次失败的构建都留下一个 2.43G 的镜像 tag，没人删。
#
# 保留规则（保护优先级从高到低）：
#   1. **正在运行的容器**所用的镜像 —— 永不删
#   2. **`:latest` 指向的镜像** —— 永不删。备机链路依赖它：
#      scripts/sync-images-to-standby.sh（每 6 小时同步备机）、
#      scripts/failover.sh（故障切换）、scripts/deploy-standby.sh 都用它。
#      删了 latest 会静默断掉备机同步与故障切换。
#   3. 最近 N 个发布镜像（默认 2）—— 留作回滚点
#   4. 其余发布镜像 tag 删除（连带释放其独占的层）
#
# 幂等：反复跑结果一致，不会误删在用镜像或备机依赖的镜像。
#
# 用法：
#   scripts/prune-docker-images.sh                 # 清理旧镜像
#   scripts/prune-docker-images.sh --keep 3        # 留 3 个回滚点
#   scripts/prune-docker-images.sh --with-cache    # 连构建缓存一起清
#   scripts/prune-docker-images.sh --dry-run       # 只看会删什么
#
# 注意：这是**宿主脚本**，不在 compose 挂载里，也不在 deploy.sh 的
# APP_CONTEXT 白名单里 —— 改完必须 rsync 到服务器的
# /opt/puer-hub/scripts/ 才生效。

set -Eeuo pipefail

KEEP=2
WITH_CACHE=0
DRY_RUN=0
REPOS=("puer-hub-app" "puer-hub-ws-server")

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep) KEEP="${2:?--keep 需要一个数字}"; shift 2 ;;
    --with-cache) WITH_CACHE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) echo "未知参数: $1" >&2; exit 64 ;;
  esac
done
[[ "$KEEP" =~ ^[0-9]+$ ]] || { echo "--keep 需要非负整数" >&2; exit 64; }

log() { printf '[prune-images] %s\n' "$*"; }

# ── 1. 受保护的镜像 ID ───────────────────────────────────────────
# 用「镜像 ID」而不是 tag 来保护 —— 决定磁盘占用的是镜像本身。
protected_ids=""

# 1a. 正在运行的容器
running_ids="$(docker ps -q | xargs -r docker inspect --format '{{.Image}}' 2>/dev/null | sort -u || true)"
protected_ids="$protected_ids$running_ids"

# 1b. :latest 指向的镜像（备机同步与故障切换依赖它）
for repo in "${REPOS[@]}"; do
  latest_id="$(docker image inspect --format '{{.Id}}' "$repo:latest" 2>/dev/null || true)"
  [[ -n "$latest_id" ]] && protected_ids="$protected_ids$latest_id"
done

protected_ids="$(printf '%s\n' "$protected_ids" | grep . | sort -u || true)"
log "受保护镜像（运行中 + :latest）: $(printf '%s\n' "$protected_ids" | grep -c . || true) 个"

# ── 2. 回滚点保留集（按 tag）────────────────────────────────────
keep_tags=()
for repo in "${REPOS[@]}"; do
  mapfile -t tags < <(
    docker images "$repo" --format '{{.Repository}}:{{.Tag}}\t{{.CreatedAt}}' \
      | grep -v ':<none>' \
      | grep -vE ':(latest|rollback-.*)$' \
      | sort -k2 -r \
      | awk -F'\t' '{print $1}' \
      | head -n "$KEEP" || true
  )
  for t in "${tags[@]:-}"; do
    [[ -n "$t" ]] && keep_tags+=("$t")
  done
done
log "回滚点保留集（${#keep_tags[@]} 个）: ${keep_tags[*]:-}"

# ── 3. 删除其余发布镜像 ─────────────────────────────────────────
removed=0
for repo in "${REPOS[@]}"; do
  mapfile -t all < <(docker images "$repo" --format '{{.Repository}}:{{.Tag}}' | grep -v ':<none>' || true)
  for t in "${all[@]:-}"; do
    [[ -n "$t" ]] || continue

    # :latest 永远保留（备机链路）
    [[ "$t" == *":latest" ]] && continue

    # 回滚点保留集直接点名 → 留
    keep=0
    for k in "${keep_tags[@]:-}"; do
      [[ "$t" == "$k" ]] && { keep=1; break; }
    done
    [[ "$keep" == "1" ]] && continue

    # rollback-<id>：对应的发布镜像还在保留集里就留
    if [[ "$t" == *":rollback-"* ]]; then
      base="${t%:*}:${t##*:rollback-}"
      for k in "${keep_tags[@]:-}"; do
        [[ "$k" == "$base" ]] && { keep=1; break; }
      done
      [[ "$keep" == "1" ]] && continue
    fi

    # 镜像正被运行中容器或 :latest 使用 → 留
    img_id="$(docker image inspect --format '{{.Id}}' "$t" 2>/dev/null || true)"
    if [[ -n "$img_id" ]] && printf '%s\n' "$protected_ids" | grep -qx "$img_id"; then
      log "跳过（受保护）: $t"
      continue
    fi

    if [[ "$DRY_RUN" == "1" ]]; then
      log "[dry-run] 将删除: $t"
    else
      if docker rmi -f "$t" >/dev/null 2>&1; then
        log "已删除: $t"
        removed=$((removed + 1))
      fi
    fi
  done
done

# ── 4. 悬空镜像与构建缓存 ───────────────────────────────────────
dangling="$(docker images -f dangling=true -q | sort -u | grep -c . || true)"
if [[ "$DRY_RUN" == "1" ]]; then
  log "[dry-run] 悬空镜像 ${dangling} 个会被清理"
else
  docker image prune -f >/dev/null 2>&1 || true
  log "悬空镜像已清理（${dangling} 个）"
fi

if [[ "$WITH_CACHE" == "1" ]]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    log "[dry-run] 将清理构建缓存"
  else
    docker builder prune -f >/dev/null 2>&1 || true
    log "构建缓存已清理"
  fi
fi

log "完成：删除 ${removed} 个镜像 tag"
df -h / | tail -1 | sed 's/^/[prune-images] 磁盘: /'
