#!/usr/bin/env bash
# fix-env-keys.sh —— 用**运行中容器**的现行值，修正生产 .env 里的若干键。
#
# ## 为什么需要它（2026-11-03 事故的后续）
#
# 一次 rsync 漏了 --files-from，把本地那份 5 键的 .env 覆盖到了生产 .env。
# 用 .env.bak 恢复之后又发现：**备份里的 LLM key 已经是旧的**（402/429），
# 现行的那把在**运行中容器的 env** 里 —— 容器是在
# 覆盖之前 compose up 起来的，它烤进去的就是覆盖前 .env 的真值。
#
# 另有 5 个键在备份里也已过期（AUTH_SECRET / AUTH_URL / NEXT_PUBLIC_APP_URL /
# NEXT_PUBLIC_APP_NAME），6 个键在备份里根本没有（FEATURE_CELLAR / CELLAR_UIDS /
# FEATURE_ANTI_ABUSE_* / RAG_SERVICE_URL / NEXT_PUBLIC_WS_URL）。
#
# ## 用法
#
#   ssh -J hk-jump puer-hk 'bash /opt/puer-hub/scripts/fix-env-keys.sh'
#
# 幂等：只改上面列出的键，其余行原样保留（含 DATABASE_URL —— 容器里那个指向
# docker 网络的 postgres:5432，宿主机跑 cron 脚本时用不了）。
# 不打印任何凭据值，只输出改了哪些键。
set -uo pipefail

cd /opt/puer-hub || { echo "找不到 /opt/puer-hub"; exit 1; }

KEYS="DEEPSEEK_API_KEY AUTH_SECRET AUTH_URL NEXT_PUBLIC_APP_URL NEXT_PUBLIC_APP_NAME \
FEATURE_CELLAR CELLAR_UIDS FEATURE_ANTI_ABUSE_PAGINATION_CAP FEATURE_ANTI_ABUSE_RATE_LIMIT \
RAG_SERVICE_URL NEXT_PUBLIC_WS_URL"

[ -f .env ] || { echo "/opt/puer-hub/.env 不存在"; exit 1; }
[ -f .env.bak ] || echo "提示：.env.bak 不存在（非致命，只是少一个对照源）"

# 备份当前版本（不打印内容）
cp -p .env ".env.before-fix-$(date -u +%Y%m%dT%H%M%SZ)"

# 取容器里的现行值 → 环境变量（bash 3.2 兼容：不用关联数组）
for k in $KEYS; do
  v="$(docker exec puer-hub-app printenv "$k" 2>/dev/null || true)"
  export "CUR_$k=$v"
done

# 逐行替换 + 追加缺失的键
awk '
BEGIN { n=split(ENVIRON["KEYS"],a," "); for(i=1;i<=n;i++) K[a[i]]=1 }
{
  eq=index($0,"=");
  if (eq>0) {
    k=substr($0,1,eq-1);
    if ((k in K) && ENVIRON["CUR_" k] != "") { print k "=" ENVIRON["CUR_" k]; next }
  }
  print $0
}' .env > .env.fixed

changed=""
for k in $KEYS; do
  v="$(printenv "CUR_$k" || true)"
  [ -z "$v" ] && continue
  if grep -q "^$k=" .env.fixed; then
    changed="$changed $k"
  else
    printf '%s=%s\n' "$k" "$v" >> .env.fixed
    changed="$changed $k(新增)"
  fi
done

mv .env.fixed .env
chmod 600 .env 2>/dev/null || true

echo "已更新这些键：$changed"
echo "现在 .env 共 $(grep -cE '^[A-Z_]+=' .env) 个键"

# 独立验证（不看值）
echo -n "LLM 探针: "; bash scripts/cron-task.sh llm-health 2>&1 | tail -1
