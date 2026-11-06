#!/usr/bin/env bash
# PreToolUse hook（Bash）—— 部署守卫 + 必读清单注入。
#
# 挂载方式：.claude/settings.json 的 hooks.PreToolUse（matcher: Bash）指向本脚本。
# 本仓库的 .claude/settings.json 是**提交进仓库**的那个，所以所有会话都生效。
#
# ## 为什么有它
#
# 2026-11-03 事故：一次 rsync **漏了 `--files-from`**，把整个本地仓库推到了生产机
# `/opt/puer-hub/`，其中本地那份 .env（只有 5 个键）**覆盖掉了生产 .env**
#（26 个键）→ 定时发布、茶问草稿、MiniMax 探针、自动回复全部拿不到 key；
# 恢复时又发现 .env.bak 里的 MiniMax key 已是旧的（402），现行的那把在
# **运行中容器的 env** 里。教训写进了 AGENTS.md 的 R29 与 docs/release-checklist.md，
# 但**光写文档靠不住** —— 这个 hook 把「必读」变成机制。
#
# ## 两种行为
#
# 1. **守卫（exit 2 阻断）**：命中下面两条「事故同款」的命令形状时**直接拦下**，
#    stderr 说明原因，Claude 看到后会改成正确写法重试：
#      · rsync 到服务器但**没有 `--files-from`**（= 会把整个仓库推过去）
#      · rsync / scp 传输 .env（= 会覆盖生产凭据）
# 2. **提醒（exit 0 + additionalContext）**：其它部署类命令（docker build /
#    compose / psql / crontab / prisma migrate…）执行后，把清单正文注入上下文，
#    让 Claude **立刻**按清单核对刚做完的事（尤其第 5 条：写操作后独立查询证实）。
#
# ## 只看命令本体，不看 heredoc 正文
#
# 2026-11-03 第一次启用本守卫时，它把一条「提交信息里提到 .env 与 rsync」的
# git commit 给拦了 —— 那是**描述**事故，不是事故本身。所以匹配前先：
#   · 截掉第一个 `<<` 之后的 heredoc 正文；
#   · git commit / add / push 直接放行（它们不会把文件同步到生产机）。
#
# ## 时序说明（别被「PreToolUse」这个名字骗了）
#
# Claude Code 的 PreToolUse hook 在命令**执行前**触发，但 additionalContext
# 是包成 system-reminder **随工具结果一起**送到模型的 —— PreToolUse 与工具调用
# 之间没有模型的回合。所以：
#   · 「执行前就看到清单」靠 **AGENTS.md**（会话启动即加载）+ 下面的**阻断守卫**；
#   · 本 hook 注入的清单实际到达时点是**部署刚跑完** —— 正好用来做部署后核对。
#
# 永不阻断非部署命令；stdout 只输出一个 JSON 对象；必须显式 exit 0。
set -uo pipefail

REPO_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
CHECKLIST_FILE="$REPO_ROOT/docs/release-checklist.md"

payload="$(cat)"
cmd="$(jq -r '.tool_input.command // empty' <<<"$payload" 2>/dev/null)"
[ -n "$cmd" ] || exit 0

# 只看命令本体（去掉 heredoc 正文）
scan="${cmd%%<<*}"
if printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_])git[[:space:]]+(commit|add|push)([^[:alnum:]_]|$)'; then
  exit 0
fi

# ── 守卫 1：rsync 到服务器却没带 --files-from ──────────────────────────
if printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_])rsync([^[:alnum:]_]|$)' \
   && ! printf '%s' "$scan" | grep -q -- '--files-from'; then
  cat >&2 <<'MSG'
被部署守卫拦下：rsync 没有 --files-from。

不带 --files-from 的 rsync 会把**整个仓库根目录**推过去 —— 2026-11-03 就是这么
把本地那份 .env 覆盖到生产 .env 的（丢了 DB_PASSWORD / MINIMAX_API_KEY 等 20 个键，
定时发布与所有 AI 任务当场断掉）。

正确写法（清单每次重新生成）：
  { find src -type f -not -path "src/generated/*"; find prisma -type f;
    for f in package.json package-lock.json tsconfig.json tsconfig.typecheck.json \
             next.config.ts postcss.config.mjs eslint.config.mjs components.json \
             prisma.config.ts Dockerfile; do [ -f "$f" ] && echo "$f"; done; } \
    > /tmp/puer-sync-list.txt
  rsync -az --checksum --relative --files-from=/tmp/puer-sync-list.txt ./ <server>:/opt/puer-hub/

清单里**不要**出现 .env / .env.* / node_modules / .next / .git / public/uploads /
uploads / backups / private / rag-data。
MSG
  exit 2
fi

# ── 守卫 2：rsync / scp 碰 .env ───────────────────────────────────────
if printf '%s' "$scan" | grep -qE '(^|[^[:alnum:]_])(rsync|scp)([^[:alnum:]_]|$)' \
   && printf '%s' "$scan" | grep -qE '(^|[/[:space:]])\.env([^[:alnum:]_]|$)'; then
  cat >&2 <<'MSG'
被部署守卫拦下：同步命令里出现了 .env。

生产 /opt/puer-hub/.env 是**唯一**的凭据来源（DB 密码、MiniMax key、AI 管线配置）。
2026-11-03 同步本地仓库时把本地那份 5 键的 .env 覆盖了上去，20 个键当场丢失，
定时发布/茶问草稿/MiniMax 探针/自动回复全部拿不到 key —— 而且 .env.bak 里的 key
还可能是过期的（MiniMax 那把就是 402），**现行值在运行中容器的 env 里**。

要改生产 .env 请单独、显式地做，不要混在源码同步里。
MSG
  exit 2
fi

# ── 其它部署类命令：把清单注入上下文（不阻断）──────────────────────────
DEPLOY_RE='(^|[^[:alnum:]_])(docker[[:space:]]+(build|compose|image|exec|tag|inspect)|crontab|prisma[[:space:]]+(migrate|generate)|psql[^|]*puerhub|app\.switch\.override|llm-health)([^[:alnum:]_]|$)'
printf '%s' "$scan" | grep -qE "$DEPLOY_RE" || exit 0

[ -f "$CHECKLIST_FILE" ] || exit 0
CHECKLIST="$(awk '
  /^## 🔴 部署前必读/ { grab=1 }
  grab && /^---$/ && seen { exit }
  grab { print; seen=1 }
' "$CHECKLIST_FILE")"
[ -n "$CHECKLIST" ] || exit 0

CONTEXT="⛔ 本仓库的部署必读清单（2026-11-03 事故教训：rsync 漏 --files-from 会把
整个仓库推上生产、覆盖生产 .env，害得定时任务全断）。刚执行完上面这条部署命令，
请**立刻**逐条核对并补做验证（尤其第 5 条：写操作后用独立查询证实结果）：

${CHECKLIST}"

jq -n --arg ctx "$CONTEXT" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",additionalContext:$ctx}}'
exit 0
