# Release Checklist — puer-hub

> Puer-hub 任何对 `frontend` / `main` 分支的部署,**必须**按本清单走完。
> 任何遗漏项都是上次 `https://puer.im` 502 事故的潜在来源。

---

## 🔴 Schema / Prisma 改动:必须重 build 镜像

**这条规则是 2026-09-01 `https://puer.im` 502 事故的根因总结,不能妥协。**

- [ ] **改了 `prisma/schema.prisma`?** → 必须 `docker build --no-cache`
- [ ] **改了 Prisma client 调用方式?** → 必须 `docker build --no-cache`

### 为什么?

`Dockerfile` 在 `builder` 阶段执行 `RUN npx prisma generate` 然后
`COPY --from=builder /app/src/generated ./src/generated` —— 生成的 Prisma client
**被烤进镜像**。只 `docker compose restart app` 会重载同一个**旧镜像**,client
元数据与运行时 DB 仍然漂移 → `PrismaClientKnownRequestError P2022 ColumnNotFound`
→ nginx 500 → Cloudflare 502 → 用户看到 "host error"。

### 临时止血(不能替代重 build)

```bash
ssh puer-hk 'docker exec -w /app puer-hub-app \
  npx --no-install prisma generate && \
  cd /opt/puer-hub && docker compose restart app'
```

`prisma generate` + restart 在 Next.js 16 + Turbopack + Prisma 7 这套栈下能
**临时**修通(client 运行时动态加载),但 build-time 客户端仍是旧的,下次
schema 再动仍会复发。**这条只用于紧急止血,生产发布必须重 build。**

### 迁移是**裸 psql** 跑的(不是 `prisma migrate deploy`)

生产库**没有 `_prisma_migrations` 表** → `prisma migrate deploy` 用不了。
迁移一律手工 psql 执行:

```bash
# 1. 先在服务器上跑迁移(带幂等,重复执行安全)
docker cp prisma/migrations/20261025_cellar_reminders/migration.sql \
  puer-hub-postgres:/tmp/m.sql
# ⚠️ ON_ERROR_STOP=1 不能省:没有它,psql 遇到错误会**继续往下跑并返回 0**,
# 运维以为迁移成功了,其实约束/回填都没生效。
docker exec puer-hub-postgres psql -U puerhub -d puerhub -v ON_ERROR_STOP=1 -f /tmp/m.sql

# 2. **直接查库确认** —— 别信「脚本执行了」
docker exec puer-hub-postgres psql -U puerhub -d puerhub -c \
  "SELECT column_name FROM information_schema.columns
    WHERE table_name='cellar_items' AND column_name='lastRemindedAt'"
# 约束真的放宽了吗?(zod 放行 0 而 DB 还是 1..60 → 用户关提醒就是 500)
docker exec puer-hub-postgres psql -U puerhub -d puerhub -c \
  "SELECT pg_get_constraintdef(oid) FROM pg_constraint
    WHERE conname='cellar_items_remindEveryMonths_check'"
# 回填真的跑了吗?(nextRemindAt 全是 NULL → 跑批永远挑不到行,功能静默失效)
docker exec puer-hub-postgres psql -U puerhub -d puerhub -c \
  "SELECT count(*) FROM cellar_items WHERE \"nextRemindAt\" IS NOT NULL"
```

**顺序固定:先 psql 跑迁移 → 再 rsync → 再 `docker build --no-cache` → 再切镜像。**
迁移必须在**旧镜像还在跑**的时候跑(它带 `SET lock_timeout='3s'`,不重写表)。

⚠️ **一次改动可能有多个新增迁移文件** —— 要把每一个都在服务器上应用。

---

## 🔴 新增定时任务(cron)

- [ ] 任务写进 `scripts/cron-task.sh`(宿主跑)或 `scripts/*.mjs`(容器跑)
- [ ] **正本写进 `scripts/crontab.txt`** —— 服务器的 crontab 只存在于服务器上,
      仓库里没有文件记录它,下次换机就会静默消失(R27 的教训)
- [ ] 服务器 crontab **也要改**,改完 `crontab -l | diff - scripts/crontab.txt` 核对
- [ ] 有暂停开关的脚本,加进 `scripts/pause-switch.test.mjs` 的 `CASES`
- [ ] 脚本的 env 依赖在 `cron-task.sh` 里 **export 出来**(容器里有的变量,
      宿主上不一定有 —— 少了就静默走不通)
- [ ] 跑批的**跳过与失败必须落到日志**,成功/失败计数随 report 打印
      (「静默降级 = 延迟爆炸」)

---

## 部署流程

通过 `./deploy.sh` 五阶段框架,自带 ERR-trap 自动回滚(`rollback-$release_id` tag)。

```bash
# 1. plan — 计划这次发布(列出哪些文件要带)
./deploy.sh plan app <release-id> <baseline-dir> <overlay-manifest>

# 2. build — 服务器端 build 镜像
./deploy.sh build app <release-id> <baseline-dir> <overlay-manifest>

# 3. publish — 上传镜像到服务器
./deploy.sh publish app <release-id> --confirm-publish

# 4. activate — 切换到新镜像,带健康检查 + 自动回滚
#
#    compose 链必须传【两个】文件,少一个就是生产事故:线上 puer-hub-app 容器
#    由 docker-compose.yml + docker-compose.override.yml 共同创建,9 个 bind mount
#    (/opt/puer-hub/uploads/* → /app/public/uploads/*、scripts/*.mjs、
#    src/lib/tea-drafts) 写在主 compose 里。只传主文件时 compose up 会重创容器并
#    丢掉全部挂载 —— 用户图片与视频立刻从站点消失。
#
#    注意 docker compose 的 -f 会**关闭** docker-compose.override.yml 的自动加载,
#    所以「只传主文件」并不等于「主文件 + 默认 override」,而是另一份更小的配置。
#    详见 docs/plans/2026-09-24-seo-geo-optimization.md(已用 docker compose config
#    从 3 个 cwd 验证相对路径恒解析为 /opt/puer-hub/uploads/...)。
PUER_REMOTE_COMPOSE_FILES=/opt/puer-hub/docker-compose.yml:/opt/puer-hub/docker-compose.override.yml \
  ./deploy.sh activate app <release-id> --confirm-activate

# 5. (可选) render-activate — 单独看服务器执行脚本
./deploy.sh render-activate app <release-id>
```

`<release-id>` 格式: `YYYYMMDDTHHMMSSZ-<7-12 hex>` (脚本会从 git short SHA 自动派生)

---

## 🚫 禁止手动覆盖服务器(由 deploy.sh PROTECTED_PATTERNS 强制)

以下路径**绝对不会**被 rsync / scp / cp 覆盖:

- `.env` / `.env.*` — 服务器有独立配置,绝不被本地覆盖
- `uploads/` — 用户上传,**绝不被覆盖**
- `backups/` — 服务器独立备份
- `src/generated/` — build 时生成,deploy.sh 绝不碰
- `.serena/` / `.git/` / `.next/` / `node_modules/` / `evernote_export/` / `.releases/`

**例外**:你要明确知道自己要做什么,且不通过 deploy.sh(比如:debug 时手动 sync 一个
非保护路径)。否则一律走 deploy.sh。

---

## 操作前检查(强制)

- [ ] `git status` 干净,所有改动已 commit
- [ ] `git branch` 是 `frontend` 或 `main`,**不是**临时分支
- [ ] 服务器 `.env` 已 grep 确认 `RAG_SERVICE_TOKEN` 等关键变量已设
  ```bash
  ssh puer-hk 'grep -E "RAG_SERVICE_TOKEN|GLM_API_KEY|KIMI_API_KEY|DEEPSEEK_API_KEY" /opt/puer-hub/.env'
  ```
- [ ] 容器清单预期:**不要意外重启 puer-hub-rag-service**
  ```bash
  ssh puer-hk 'docker ps --format "table {{.Names}}\t{{.Status}}" | grep -E "puer-hub|rag"'
  ```
- [ ] `puer-hub-rag-service` **Up** 且不重启(2026-08-19 历史坑:别名 + token
  遗失;后续 W4 重建恢复,本次部署绝不允许再踩)

---

## 操作后验证(强制)

- [ ] 容器状态:全部 Up
  ```bash
  ssh puer-hk 'docker ps --format "table {{.Names}}\t{{.Status}}"'
  ```
- [ ] 应用日志无新 `P2022 / P2021 / ColumnNotFound / Connection refused`
  ```bash
  ssh puer-hk 'cd /opt/puer-hub && docker compose logs --since 30s app 2>&1 | grep -iE "P2022|P2021|columnnotfound|connection refused" || echo "OK no errors"'
  ```
- [ ] 业务路径全部 200(每改一个路由都得测)
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://puer.im/forum
  curl -s -o /dev/null -w "%{http_code}\n" https://puer.im/forum/new
  curl -s -o /dev/null -w "%{http_code}\n" https://puer.im/api/boards
  curl -s -o /dev/null -w "%{http_code}\n" https://puer.im/api/articles
  ```
- [ ] `/ask` RAG 仍能调用(验证 RAG_SERVICE_TOKEN 没掉)
  ```bash
  curl -s -o /dev/null -w "%{http_code}\n" https://puer.im/ask
  ```

---

## 回滚

```bash
# 查看回滚镜像
ssh puer-hk 'docker images "puer-hub-app:rollback-*"'

# 用某个 rollback tag 拉起
ssh puer-hk "cd /opt/puer-hub/releases/<release-id> && \
  docker compose -f app.rollback.override.yml up -d --no-deps --no-build app"
```

`deploy.sh` 在 ERR 时会自动写 `app.rollback.override.yml`,**不要删**它,直到
确认本次发布稳定。

---

## 事故记录

- **2026-09-01**: `https://puer.im/forum` 502 → build-time Prisma client 漂移 → 临时 `prisma generate` + restart 修通,无数据丢失。本清单诞生。
- **2026-08-19 (W4)**: 部署时 `puer-hub-rag-service` 别名 + RAG token 遗失,重建恢复。
- **2026-05-26**: docker volume 迁移导致 `uploads/` 全部丢失 + 后续 SQL 操作损坏 81 帖子内容。从 DB 备份恢复内容,29 个视频重新生成,9 个帖子用户上传图片**永久丢失**。