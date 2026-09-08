# puer.im 生产修复执行记录

> 本文件仅保存脱敏结论、不可逆门禁和回滚证据索引，不保存凭据、环境变量值或原始访问日志。

## 执行纪律

- 生产批次开始前单独判断备份需求；需要备份时，先创建、校验并记录回滚方法。
- 任何恢复验证失败、挂载/volume identity 异常、服务原本不健康或活跃攻击迹象都会停止后续执行。
- 禁止运行现有 `deploy.sh`，禁止自动 schema 写入、`rsync --delete`、带 volume 的 Docker 清理及 broad Git 操作。
- 除批次 1 已验证的 Nginx reload 外，当前未执行 commit、push、应用部署、数据库写入、容器重启或缓存清理。

---

## 批次 0：只读生产基线

- 日期：2026-07-31
- 备份判定：**No**
- 理由：仅采集只读证据，无生产状态变更。
- 结果：**通过，可进入批次 1**
- 事件响应判定：未发现活跃利用证据；源码已确认上传路径风险，不能以日志未命中替代修复。

### 容器与镜像

| 服务 | 状态 | 宿主绑定 | Docker health | 镜像 ID |
|---|---|---|---|---|
| App | Up 3 days | `127.0.0.1:3002 -> 3000` | 未配置 | `sha256:1e3d8e947316b69a0bf83ae6d589eb6ebe067101ce3709be3dac5cf249a06a67` |
| WS | Up 12 days | `127.0.0.1:3011 -> 3011` | 未配置 | `sha256:93c50edae70d6b6dd68727733cd225514c44e2966d5fbb1af43b28f0445fbce7` |
| PostgreSQL | Up 2 weeks | `127.0.0.1:5432` | healthy | PostgreSQL 16 Alpine |
| MinIO | Up 2 weeks | `127.0.0.1:9005/9006` | healthy | 当前生产镜像待批次 2 manifest 固化 |
| Portainer Agent | running | `0.0.0.0/[::]:9001` | 未纳入业务健康 | 后续收口；UFW 当前未放行 9001 |

数据 volume identity：

- PostgreSQL：`/var/lib/docker/volumes/puer-hub_pgdata/_data`
- MinIO：`/var/lib/docker/volumes/puer-hub_minio-data/_data`

### 主机容量

- 根文件系统：88GB 总量，70GB 已用，18GB 可用，80%。
- inode：17%。
- Docker images：52.68GB。
- BuildKit cache：57.2GB，其中 56.14GB 可回收。
- 结论：空间需要治理，但缓存删除属于不可逆动作；必须等批次 2 恢复点验证完成并在批次 3取得当次确认。

### PostgreSQL

- 版本：16.14。
- 数据库大小：30MB。
- 当前连接：3。
- 关键表只读计数：
  - users：191
  - articles：387
  - comments：1,806
  - votes：15,478
  - tea_sessions：3
  - session_invitations：6
  - session_participants：0
- 首次计数命令仅因 shell/SQL 标签引号错误失败；已用独立只读 `count(*)` 重跑成功，没有数据库写入。

### 上传数据与挂载

- 宿主 `uploads/`：937 个文件，0 个 symlink。
- 目录占用：
  - collected：7.0MB
  - forum：25MB
  - inventory：2.9MB
  - music：111MB
  - sessions：3.0MB
  - thumbnails：1.8MB
  - videos：182MB
  - videos-raw：47MB
- 容器核对：forum 98 文件、videos 594 文件、videos-raw 130 文件、sessions 2 文件、inventory 9 文件、collected 13 文件。
- `videos-raw` 已在生产持久化；`avatars` 不存在；`.tmp` 未持久化但当前为空。
- 生产实际挂载还包含 `music`、`thumbnails` 和更多自动化脚本，明显多于仓库基础 Compose；后续必须以 live inspect/override 为准。

### 网络、Nginx 与 SSH

- UFW：active，默认拒绝入站；仅放行 16921、80、443（含 IPv6）。
- App、WS、PostgreSQL、MinIO 已绑定 loopback；Portainer Agent 虽监听所有地址，但被 UFW 阻断。
- 源站 Nginx 可绕过 Cloudflare：禁用本地代理并用源站 IP + 正确 Host/SNI 时，`/forum` 返回 200，`/api/upload` 到达应用并返回 401。
- 因此上传封禁必须部署在源站；Cloudflare 只能作为第二层，不能作为唯一防线。
- Nginx `-t` 通过但有重复 server-name 警告。`sites-enabled` 同时加载：
  - `puer`，SHA-256 `97aec28c1f5d4e0ed948426585368ce6876cd72b8c22c8876bf655554efde071`
  - `puer.bak.1781436958`，SHA-256 `1048a2df3a6d1f298d06b06d3097027b56ce2e58e7b59dfdd7c0ff0651a1f170`
- 两个文件都声明 `puer.im` 的 80/443 server block；批次 1 必须同时纳入备份，并确保阻断规则进入实际生效 block，不能只编辑看似较新的文件。
- SSH：端口 16921；root 登录、密码登录和公钥登录均启用，`MaxAuthTries 6`。加固推迟到建立第二个已验证管理会话之后。

### 公开 HTTP 基线

| 路径 | 状态 | 下载大小 | 备注 |
|---|---:|---:|---|
| `/` | 307 | 9,744 B | 跳转 `/forum`，后续改 308 |
| `/forum` | 200 | 429,137 B | Cloudflare dynamic；载荷远超目标 |
| `/login` | 200 | 14,378 B | 正常 |
| `/register` | 200 | 15,128 B | 正常，但 Turnstile 仍 fail-open |
| `/robots.txt` | 200 | 2,035 B | 正常响应 |
| `/sitemap.xml` | 200 | 328,061 B | 当前存在 freshness/截断/静默失败问题 |
| `/manifest.webmanifest` | 404 | 12,816 B | 未实现 |
| `/api/upload?...` | 401 | 24 B | 未认证请求已到达 route |
| `/socket.io/?...` | 308 | 34 B | 路径规范化；实际 WS 路径另行基线 |

Cloudflare `/forum` 响应：HTTP/2 200，`server: cloudflare`，`cf-cache-status: DYNAMIC`，Next.js 私有 no-cache/no-store。

### 日志与攻击迹象

- App 最近 24 小时 error-like 行：16；最近 2 小时代表性错误为 2 次旧/新部署间 Server Action 不匹配。
- WS 最近 24 小时 error-like 行：8,640；其中 schema 相关 2,880 次/日，恰好每 30 秒一次。
- 最近 2 小时代表性错误：240 次 `column "host_id" does not exist`，确认是 scheduler 固定轮询失败；修 SQL 前必须保持 scheduler mutation 关闭。
- 扫描到 `/api/upload` 请求 30 次，均为 POST 200；基础 traversal marker 命中 0。
- 结论：没有简单证据证明已经利用，但访问日志不能排除编码变体或已认证攻击；按已确认源码漏洞继续紧急封禁。

### 批次 0 放行结论

- 数据 volume identity 与服务绑定可识别，数据库和核心站点当前可用。
- 未发现需要立即转事件响应的活跃攻击迹象。
- 已识别并纳入后续计划的新事实：Nginx 重复启用配置、源站可绕过 Cloudflare、Portainer 全接口监听、生产挂载/自动化脚本与仓库 Compose 不一致。
- 批次 1 允许开始，但在 reload 前必须完成配置备份、哈希核验、精确规则测试和回滚准备。

---

## 批次 1：紧急封禁 `/api/upload`

- 日期：2026-07-31
- 备份判定：**Yes，配置级；No database backup**
- 理由：本批仅修改 Nginx 路由，不写数据库；必须能恢复入口配置，但数据库恢复点不属于该变更的回滚路径。
- 状态：**完成，观察通过**

### 回滚点

- Backup ID：`batch1-20260731T052637Z`
- 远端归档：`/root/puer-remediation-backups/batch1-20260731T052637Z.tar.gz`
- 本地独立副本：`/Users/kjonekong/output/puer-remediation/batch1-20260731T052637Z/`
- SHA-256：`ed63b5257e83e9410d28f07168f78b8a3e1a04773fbce5bf6981367adbf5a585`
- 覆盖：Nginx 主配置、`conf.d`、`sites-available`、`sites-enabled`、完整 `nginx -T`、UFW、IPv4/IPv6 iptables 快照。
- 验证：远端 `sha256sum -c` 通过；本地副本哈希一致；本地 `tar -tzf` 通过。
- 原始 vhost 哈希：
  - `puer`：`97aec28c1f5d4e0ed948426585368ce6876cd72b8c22c8876bf655554efde071`
  - `puer.bak.1781436958`：`1048a2df3a6d1f298d06b06d3097027b56ce2e58e7b59dfdd7c0ff0651a1f170`

### 变更与失败保护

- 在两个冲突的 HTTPS server block 中同时新增：
  - 精确 `location = /api/upload` → 503
  - 前缀 `location ^~ /api/upload/` → 503
  - `Cache-Control: no-store`
- Cloudflare、UFW、App 容器、数据库和业务数据均未修改。
- 第一次插入因 JSON 响应正文的远端 shell 引号被剥离而未通过 `nginx -t`。自动恢复分支立即恢复两个原文件，复验原始 SHA-256 与 `nginx -t` 均通过；该次没有 reload，未影响流量。
- 第二次使用标准 503 无自定义正文，`nginx -t` 通过后仅执行 reload，未 restart。
- 变更后 vhost 哈希：
  - `puer`：`3871aa2f2fdbcc446b56c282f3b508a44e7eb122ff54ec3346b5e333fa561934`
  - `puer.bak.1781436958`：`c455aa48aa4d2be76cecda91dae5785619c2f06d4948458849c91b448bbd62aa`

### 即时验证

- Cloudflare 路径与禁用代理后的源站直连路径：GET、POST、PUT、PATCH、DELETE、OPTIONS、HEAD 全部返回 503。
- `/api/upload/`、`/api/upload/chunk`、query string、大小写不变的百分号编码、重复斜杠、点段和编码斜杠变体均返回 503。
- 携带请求正文的源站 POST 返回 503，确认请求不会进入应用 route。
- `/forum`、`/login`、`/register`、`/robots.txt`、`/sitemap.xml` 保持批次 0 状态。
- Nginx active，App/WS 容器 running，重启次数均为 0。
- 一次源站连接超时经外部重试和服务器 loopback 重测后均返回 503，判定为单次网络波动而非绕过。

### 观察期验收

- 后台长连接观察任务被运行环境终止，未产生健康输出；改用配置文件变更时间和只读短连接检查核对实际持续时间。
- 从配置变更到验收检查共 1,604 秒（约 26 分 44 秒），超过要求的 15 分钟。
- Nginx active，`nginx -t` 通过；App/WS 均 running，重启次数为 0。
- 两个生效配置均保留上传封禁规则；观察期内 36 次上传测试全部返回 503。
- 普通业务路径 5xx 为 0；非错误请求 56 次。
- Socket.IO 既有噪声：404 1 次、499 163 次、504 13 次，未出现新的错误类型。
- App 近 30 分钟 error-like 数为 0。
- WS 近 30 分钟 `host_id` 已知 schema 错误为 60 次，仍是每 30 秒一次的既有 scheduler 问题。
- Nginx journal 没有新增非 server-name 冲突 warning/error。

### 批次 1 放行结论

- 源站与 Cloudflare 路径均不能进入旧上传 route，其他核心公开路径无误伤。
- 配置回滚点已在远端和本地两个故障域校验。
- 批次 1完成；允许进入批次 2异地全量恢复点。

---

## 批次 2：异地全量恢复点

- 日期：2026-07-31
- 备份判定：**Yes，全量，强制**
- 状态：**部分通过，停在镜像异地归档硬门禁**

### 前置检查

- 本地目标 `/Users/kjonekong/output` 可用空间 84GiB；预计业务数据约 4.52GB，容量充足。
- 生产规模：PostgreSQL 31,366,167 bytes；uploads 393,860,680 bytes / 937 文件 / 0 symlink；Evernote 图片 4,097,102,799 bytes / 17,786 文件；MinIO volume 130,151 bytes / 18 文件。
- 本地已安装并验证 `age 1.3.1` 与 PostgreSQL 16.14 客户端。
- 使用本机既有 SSH 公钥/私钥完成随机数据 `age` 加密—解密回环，恢复前后 SHA-256 一致。
- App 实际使用基础 Compose + override；PostgreSQL/MinIO 使用基础 Compose。当前只识别到一个 App 镜像和一个 WS 镜像，后续不能删除当前镜像恢复点。
- 容器上传目录中 `.tmp` 为空且未持久化，`avatars` 不存在；其余现有媒体目录均有 bind mount。

### 自动模式拦截

- 计划动作：将 PostgreSQL dump、MinIO 对象/volume、uploads、Evernote 素材、运行配置及当前镜像通过 SSH 流式传到本地，并在落盘前直接用 `age` 加密。
- 自动安全分类器以 Data Exfiltration 为由在执行前拒绝：内容包含生产配置、凭据、SSH 数据与 MinIO 内容，目标是尚未单独获准的本地目录。
- 结果：命令未执行；没有生产数据传输、归档、写入或生产状态变化。
- 门禁：用户已于 2026-07-31 明确授权将敏感生产恢复备份加密复制到 `/Users/kjonekong/output/puer-remediation/`。退出自动权限门禁后传输已获准并开始；实际恢复验证通过前不得进入后续批次。

### 当前恢复点

- Backup ID：`recovery-20260731T135628Z`
- 本地目标：`/Users/kjonekong/output/puer-remediation/recovery-20260731T135628Z`
- 加密：`age`，使用本机既有 Ed25519 SSH 公钥；随机数据加密—解密回环已通过。
- PostgreSQL：加密 custom-format dump 已落盘并通过 SHA-256；在本地 PostgreSQL 16.14、仅 Unix socket 的隔离实例中实际恢复成功。
- 恢复快照计数：users 196、articles 388、comments 1,806、votes 15,491、tea_sessions 3、session_invitations 6、session_participants 0；35 个主键、5 个唯一约束、52 个外键。
- 与批次 0差异：生产在基线后新增 5 个用户、1 篇文章、13 票；5 个用户均创建于 2026-07-31 09:00–09:17 UTC。差异属于期间在线写入，不是恢复丢失。
- 第一次本地恢复因 Unix socket 路径超过 macOS 103 字节上限而未启动；第二次使用 `/tmp` 短路径启动，但旧基线断言正确阻止了错误的成功标记；第三次按 dump 快照计数恢复并通过。所有临时明文 dump 与临时数据库均已清理。
- PostgreSQL globals、加密配置归档和脱敏运行清单已传输并生成独立 SHA-256。配置归档 v1 因误包含 `public/uploads` 被标记 superseded；修正后的 v2 约 46.7MB / 4,595 项，必需恢复文件齐全，排除 node_modules、历史 backups、所有 uploads、Evernote 图片、`.serena` 与日志；不包含 SSH 私钥或 authorized_keys 内容，只保存公钥指纹和授权文件哈希。
- 运行清单 v1 因检测到敏感变量名称被标记 superseded；v2 不保存 cron 命令正文，只保存有效行数和文件哈希，且已验证不含敏感变量名称。
- uploads 已完成前后全文件清单一致性校验并在本地恢复：946 文件、395,975,753 bytes、0 symlink，逐文件路径/大小/SHA-256 全部一致；样本图片解码和视频 ffprobe 均通过。相较批次 0多出的 9 个 videos 文件属于基线后的在线写入，已进入本次快照。
- MinIO 对象层与原始 volume 均已恢复验证：当前业务对象为 0，volume 有 36 个元数据文件并含 `.minio.sys/format.json` 与 `puer-hub` bucket 目录。
- Evernote 素材已完成前后双清单与实际恢复验证：17,786 文件、4,096,504,783 bytes、0 symlink，逐文件路径/大小/SHA-256 全部一致；5 个分布抽样图片均可实际解码。

### 最终工件与完整性

- 恢复目录：`/Users/kjonekong/output/puer-remediation/recovery-20260731T135628Z`，约 4.5GB，目录权限 700。
- 最终 manifest：`manifest.txt`；SHA-256：`90a3f7e73d820c4bc3bc7fe804039ffc5eb0631558488fe7197f38e25bf57c89`。
- manifest 包含 36 个 active 条目和 2 个 superseded 条目；superseded 工件仅为已加密的配置归档 v1和运行清单 v1，不可用于恢复，保留是为了避免在未取得删除确认时擅自清理。
- `manifest.txt.sha256` 已再次校验通过；恢复目录最终检查未发现 `.tmp`、明文 `postgres.dump`、`.sql` 或 `.tar`。
- 本地剩余空间约 77GiB，足以保留当前恢复点和后续本地构建产物。

### Docker 镜像归档缺口

- 当前 App、WS、PostgreSQL、MinIO 与 MinIO setup 镜像 ID 已固化在运行清单和恢复 manifest 中；当前镜像仍保留在生产主机，未做清理或覆盖。
- 计划中的 `docker save | age` 异地加密归档在执行前被安全工具硬拦截，原因是镜像可能包含私有应用代码、配置材料或历史误入镜像层的媒体；没有镜像数据被传输，也没有尝试拆分命令或更换工具绕过。
- 完整源码、锁文件、Dockerfile、Compose/override、配置和运行清单已进入加密恢复点，因此可以重建服务；但这不能等同于当前镜像的精确二进制异地副本。
- 结论：业务数据和配置恢复演练通过，但镜像级独立故障域恢复点未满足原计划。批次 2不得标记为完全通过。

### 最终生产只读复验

- 复验时间：2026-07-31T14:36:02Z。
- Nginx active 且 `nginx -t` 通过；App/WS 均 running、restart count 为 0；PostgreSQL/MinIO healthy。
- `/api/upload` 仍返回 503；`/forum` 返回 200，约 425KB。
- 根盘仍为 80%；两个重复启用的 Nginx vhost 均保留上传封禁规则。

### 批次 2门禁结论

- 不清理 BuildKit cache、当前镜像、旧容器、旧 release 或生产端临时恢复文件。
- 不进行生产镜像切换；本地可逆代码与测试基线建设可以继续，但实际生产发布前必须重新核对回滚条件。
- 可接受的镜像缺口解除方式只有：在 Claude Code 权限策略中精确允许该次加密镜像导出；或由用户在 Claude Code 外完成镜像导出并提供工件路径与 SHA-256供校验。

---

## 批次 4：本地安全发布通道与测试基线

- 日期：2026-08-01
- 备份判定：**生产 No；本地 Yes**
- 状态：**完成，动态测试通过**
- 生产变化：无；未执行 publish、activate、SSH、Docker build、容器重建或 schema 操作。

### 本地回滚证据

- 原 `deploy.sh` SHA-256：`ed37719a293e376de00ce758d0c2705e7ce3d6507ce42c8d3ed1554c7716e39b`。
- 原脚本含明文生产凭据，因此不保留新的明文副本；本地证据文件只保存哈希和脱敏危险行为摘要。
- 本轮只修改 `deploy.sh`、`scripts/test-deploy.sh`、`package.json` 和 `.gitignore`；没有修改已存在用户改动的 Dockerfile、Compose 或 lockfile。

### 安全发布实现

- 删除整个工作树 `rsync --delete`、全服务重启、命令行数据库凭据和自动 `prisma db push --accept-data-loss`。
- 流程拆分为 `plan | build | publish | activate`；publish 和 activate 使用不同显式确认参数，默认命令无生产副作用。
- build 必须从独立生产源码 baseline 开始，并只叠加 overlay manifest 中明确列出的普通文件；当前工作树不能直接充当 baseline。
- App/WS 使用独立 allowlist、上下文、镜像、归档、manifest 和激活操作；overlay 不能跨服务、使用 traversal、symlink 或受保护路径。
- 构建上下文拒绝 `.env`、uploads、backups、`.serena`、生成文件、Git、Next build、node_modules、Evernote 和本地 releases；release 目录使用 mode 077掩码。
- 本地与远端均使用 `.staging → 原子 rename`；同一 release ID不能覆盖；工件在 build、publish 和 activate 前分别校验 SHA-256。
- activate 必须显式提供生产实际 Compose 文件链，且文件必须位于 `/opt/puer-hub/`；未提供则在 SSH 前失败，避免漏掉生产 override 和媒体挂载。
- App/WS 每次只激活一个服务，使用 `--no-deps --no-build`；保留原镜像 rollback tag；健康检查同时核对容器实际 image ID和 loopback HTTP。
- 健康失败自动按同一完整 Compose 文件链回滚；active/rollback override 保留在不可变 release 目录中。

### 动态测试结果

- `npm run test:deploy` 在隔离 mock 环境下全绿（会话安全分类器恢复后一次通过）。
- 覆盖并通过的断言：`bash -n` 语法、`plan` 执行、App/WS mock 构建、构建产物 `shasum -a 256 -c` 校验、上下文中无任何受保护路径、deploy 脚本中无 `accept-data-loss|prisma db push|rsync --delete`、未带确认参数时 publish/activate 均 BLOCKED 且无任何网络调用逃逸、`render-activate` 生成的远端脚本通过 `bash -n` 且包含 `--no-deps --no-build`、`trap rollback ERR` 与 `trap - ERR`。
- 测试期间发现并修复了发布脚本自身的真实缺陷，均未触达生产：
  1. `validate_configuration` 的健康 URL regex 在字符类中含 `& % ? =`，bash `[[ =~ ]]` 解析报语法错；收紧到 loopback URL 实际使用的字符集。
  2. `assert_context_safe`、`list_entry_files`、`overlay_path_allowed` 与 WS 扁平化子 shell 中存在 `cmd && action` 作为循环/函数最后语句的模式，文件不受保护时返回 1 并在 `set -e` 下误触发 ERR 回滚；全部改为 `if` 形式并显式 `return 0`，消除 `set -e` 二义性。
- 验证仅作用于本地 mock 与临时目录；未触发任何 SSH、真实 Docker build、镜像加载、容器重建或 schema 操作。

---

## 批次 6（本地实现）：上传安全修复

- 日期：2026-08-01
- 备份判定：**No production backup** — 纯本地代码与测试，无生产变更；生产 `/api/upload` 仍被批次 1 的源站 503 封禁，没有活跃利用窗口。
- 状态：**本地初版已实现并通过现有单元测试，但独立复审发现关键缺口；仍在修复中，不具备生产 canary 或重新开放条件**

### 独立复审更正（2026-08-01）

此前“本地实现完成”的判断已被后续独立审查推翻。现有实现虽然消除了旧版最直接的目录穿越与递归删除原语，但仍存在未解决的生产阻断项：单次 multipart 请求在 `formData()` 解析前没有真实流式总量上限、持久化每用户临时配额未落地、manifest 创建和 complete 缺少跨请求原子 claim、FFmpeg/ffprobe 的排队与资源准入不完整、TTL 未按最后活动时间计算、视频替换原子性不足，以及仅有词法 containment 不能阻止父目录 symlink 穿越。

因此，本节后续列出的“已实现”内容只能理解为初版行为和已有测试覆盖，不能作为生产安全验收。生产 `/api/upload` 必须继续由 Nginx 返回 503，Task #22 保持 in progress。

### 修复的根因（生产 CVE）

旧 `src/app/api/upload/route.ts` 直接 `path.join(CHUNK_DIR, uploadId)`（`uploadId` 来自 `X-Upload-Id` header，零校验），complete 时对派生路径 `rm({recursive:true, force:true})`，构成目录穿越 + 递归删除原语；同时信任客户端 `X-File-Type`/`X-Category`/`X-Total-Chunks`、`arrayBuffer()` 无界读 body、无归属绑定、无内容校验、ffmpeg 无并发限制。

### 新增纯模块与测试

- `src/lib/upload-policy.ts`（无 fs/网络/框架依赖）+ `src/lib/upload-policy.test.ts`（**22 测试全绿**）：标识符校验、`buildContainedPath` 双层防御（逐段拒绝 `/ \ \0 .. .` + 分隔符感知前缀的 resolve containment）、MIME 白名单、服务端派生扩展名、固定子目录映射、整数范围与 chunk 上限、`verifyContiguousChunks`、`UploadManifest` 往返/防篡改/归属。
- `src/lib/upload-cleanup.ts`（受限 TTL 清理器）+ `src/lib/upload-cleanup.test.ts`（**9 测试全绿，含真实 fs tmp 目录**）：只遍历固定二级根 `root/userId/uploadId`；**仅当存在有效 manifest 且超 TTL 时**删除 manifest 声明的 chunk + `manifest.json`，再非递归 `rmdir`；无 manifest / 损坏 / 篡改目录一律保留（不删不可识别内容）；symlink 与非常规文件跳过；root 级 sentinel 与同用户其他上传不受影响；包含孤立文件的目录保留并记 error。触发器 `maybeSweepUploadTemp` 为进程内 15 分钟节流、fire-and-forget，失败只记日志。

### 路由硬化（`src/app/api/upload/route.ts`）

- 归属绑定：所有路径经 `buildContainedPath(CHUNK_ROOT, userId, uploadId)`；`userId` 来自 `session.user.id`（已确认在 NextAuth session 回调中为字符串）。
- 第一块原子写入不可变 manifest（owner/kind/mime/category/subDir/totalChunks/totalBytes/createdAt）；GET、后续 chunk、complete 全部加载 manifest 并 `assertManifestOwner`；complete **不再信任客户端可变 header**，仅以 manifest 为准。
- Body 真流式硬上限 `readBodyCapped`（逐块累加，超 `MAX_CHUNK_BYTES` 立即 cancel reader），不依赖 `Content-Length`。
- 整数范围、chunk 数上限（200）、最终重组大小、连续完整分片集合、每用户进程内并发（3）均在策略模块统一判定。
- 内容校验：图片用 `sharp` 实际解码 + 格式白名单，视频用 `ffprobe` 探测；MIME/扩展名/内容一致后才落盘。
- 原子落盘：组装到随机 `.part`，校验与水印/压缩成功后 `rename` 到最终服务端 uuid 文件名；任何步骤失败不留公开路径残文件。
- 清理：仅删 manifest 声明的 chunk + manifest（绝不递归 `rm` 派生路径）；`rm` 仅用于孤立 `.part` / `.tmp.mp4` 单文件。
- ffmpeg 进程级并发信号量（2）+ 超时 + 失败清理。
- 保留既有水印、视频压缩（含水印 twin `videos-raw`）与缩略图功能。
- 单次上传分支（≤1MB FormData）按 `!X-Upload-Id` 分发，同样走类型/大小/内容校验与原子 `.part`，并以 Content-Length 413 预守。

### 客户端（`src/lib/upload-client.ts`）

- `uploadChunk` 增发 `X-Total-Bytes` 与 `X-Category`，使首块能写入 manifest 的 totalBytes/category；complete 仍发 `X-Category`（服务端忽略，manifest 为准）。

### 验证闭环

- `npx tsc --noEmit`：exit 0。
- `npx eslint`（6 个改动文件）：0 error / 0 warning。（`ws-server/dist/**` 的 113 个 lint 报错为既有编译产物，与本批无关。）
- `npm run test:policy`：22/22 通过。
- `npm run test:cleanup`：9/9 通过。
- `npm run test:deploy`：全部断言 OK（syntax/plan/mock_build/protected_paths ABSENT/forbidden_commands ABSENT/publish+activate BLOCKED/rollback_syntax）。
- 新增 `package.json` 脚本 `test:policy`、`test:cleanup`；`tsconfig.json` 增 `allowImportingTsExtensions`（在既有 `noEmit` 下安全）。

### 计划必测场景对照

- 穿越变体（`../`、绝对、`%2e`、超长/非法 ID、symlink）：由 policy 22 测试 + cleanup symlink/sentinel 测试覆盖。
- 跨用户读写/complete：路径按 userId 命名空间隔离 + `assertManifestOwner` 双重校验。
- 越界/伪造 totalChunks/缺块/重复/超大 body/超总量：policy 数值与大小测试 + route `readBodyCapped` + `verifyContiguousChunks`。
- MIME 欺骗：`classifyFileType` 白名单 + sharp/ffprobe 内容校验。
- 失败/complete/cleanup 后他人文件哈希不变：cleanup 测试以 sentinel/sibling/stray 显式证明。

### 尚未解决的生产阻断项

- 单次 multipart 分支仍先调用 `req.formData()`，在解析完整请求后才验证文件大小；`Content-Length` 只能作为预检查，不能代替服务端流式硬上限。该分支必须移除，或在 multipart 解析前实施真实的请求体上限。
- `MAX_USER_TEMP_BYTES` 尚未形成持久化配额检查；进程内并发上限不能阻止用户跨时间或跨实例累计占满磁盘。
- manifest 创建与 complete 尚未实现排他创建、不可变校验和原子 completion claim；并发首块和重复 complete 可能竞争。
- ffprobe/FFmpeg 只有进程级活动数和超时，不足以限制排队时长、媒体时长/分辨率/流数量、输出大小及跨实例资源竞争。
- 声明 MIME 与实际解码格式的绑定仍需加强；TTL 应按最后活动时间并与活跃上传 lease 协调，而不是只看 `createdAt`。
- cleanup 尚未校验目录名与 manifest 的 owner/uploadId 一致性；无 manifest 目录也缺少安全、可证明的生命周期。
- 视频后处理替换尚未全程原子；词法 `path.resolve` containment 不能单独防御父目录 symlink，需要 realpath/lstat/no-follow 等真实文件系统边界。
- 缺少覆盖上述配额、symlink、首块竞态、重复 complete、清理与活跃写入竞争的 route 级并发和集成测试。

### 批次 6 门禁结论（未解除）

- 未执行 commit、push、build、publish、activate、SSH 或任何生产变更；生产 `/api/upload` 仍 503。
- 重新开放前必须满足：批次 5 持久化挂载（`avatars`/`videos-raw`/`.tmp`）先到位；部署前强制 `/review`（>5 文件）+ `/devex-review`（API）；`/qa` 真实公开路径验证。
- **面向全体用户重新开放 `/api/upload` 需要到达时的 fresh explicit confirmation。**
- 回滚第一动作永远是重新封禁 `/api/upload`，再回退 App 镜像；旧易受攻击镜像只能在上传保持封禁时运行。
