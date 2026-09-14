<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 运维 / 远程操作纪律（2026-09-13 R26b 事故教训）

**背景**：一次部署收尾时服务器 SSH 端口突然不通（网站/ping 均正常），Agent 反复用
`sleep N; ssh ... 查日志` 循环重试十几轮——每条挂起的 shell 命令都会把控制权交还用户、
弹出一次手动确认，用户体验极差。此类行为绝对禁止。

## 规则

1. **挂起命令 = 立即止损**：同一类远程检查命令连续挂起/超时 **2 次**，就必须停止重试该路径，
   换替代方案。绝不第三次尝试同构命令（`sleep+cat`、`sleep+ssh` 循环尤其禁止）。
2. **优先公网验证**：puer-hub 部署是否生效大多可用公网 HTTP 判断（`curl https://puer.im/...`
   看状态码/HTML/API JSON），不依赖 SSH。SSH 不通 ≠ 部署失败。
3. **长等待任务一律后台化 + 日志落地**：
   - 服务器 docker build：`nohup bash 脚本 > /tmp/xx.log 2>&1 &`（脚本内部各步已重定向），
     之后**低频、一次性**读取结果，不要 sleep 轮询；
   - 本地 build：`(npm run build > /tmp/x.log 2>&1; echo "EXIT=$?" >> /tmp/x.log) &`，
     读日志判断 `EXIT=`，不靠进程消失猜结果。
4. **终端 shell 集成不可靠时的信号**：命令频繁落入 "proceed-while-running" pending 状态且日志
   读不回来，说明终端已卡死或连接已断——此时唯一正确动作是停下，向用户说明状态与剩余步骤，
   把收尾留给下次，而不是继续发命令。
5. **服务器 SSH 偶发断连**（端口 16921 超时但 ping/网站正常）通常是 sshd/防火墙临时问题：
   先做公网验证确认服务健康，SSH 收尾（docker ps 确认镜像、清旧镜像）留待恢复后补做。


# 数据双轨 / 管线环境漂移纪律（2026-09-13 R26 根因复盘）

**背景**：用户报障「新帖编辑时有很多图片，发布后无图/无轮播/无视频」。排查发现图片数据
从未丢失（DB 里 7~29 张/篇都在），而是四层叠加的链路断裂，且多数静默潜伏近一个月：

1. **数据双轨，读取端只认一条**：帖子图片有两条写入路径——普通发帖 API 同时写
   `content` 内联 `<img>` + `images` 字段；茶记自动帖管线只写 `images` 字段（content 纯文字，
   设计如此）。而 feed `toDTO` 和详情页只从 `content` 正则提取 `<img>` → 管线产出的帖子
   全部无图。热榜 `hasMedia` 判定同样只看 content。
2. **执行环境漂移**：auto-post cron 09-09 起改在宿主机跑（R19，因旧镜像缺 pg），而
   `generateSlideshowVideo` 依赖 `process.cwd()/public/uploads`——该路径只在容器内存在
   → 视频生成全部失败。
3. **静默失败无观测**：`attachVideos` 失败只写进返回值，cron 日志不打印 videos 结果，
   无告警 → 坏了一个月没人知道。
4. **Next standalone 静态缓存陷阱**：容器启动后新写入 `public/` 的文件静态 serve 404
   直到下次重启——不仅 cron 视频，**每次部署后用户新上传的图片同样立即 404**。
   （已用 `src/app/uploads/[...path]/route.ts` 兜底路由根治。）

## 规则

1. **同一资源禁止双轨存储，若历史原因必须双轨，读取端必须合并读取**：任何「列表页/详情页/
   SEO」提取帖子图片的地方，一律走 `extractFeedImages()`（content ∪ images 字段）这类统一
   helper，不许再新写「只从 content 正则提图」的逻辑。新增展示位（卡片/分享卡/搜索页）时
   先查 `forum-feed-server.ts` 是否已有该 helper。
2. **改变任何脚本/cron 的执行环境（容器↔宿主机）前，先审计它 touch 的所有文件系统路径与
   env**：cwd 相对路径（`process.cwd()/public/...`）、数据库地址、node_modules 依赖。
   环境变了 ≠ 代码兼容；跑通了≠产出正确（本案 runner status=ok 但视频全灭）。
3. **后台管线（cron/runner）的跳过与失败必须落到日志**，成功/失败计数随 report 打印；
   禁止「吞掉错误保留 prose-only 降级」却不在日志留痕——静默降级 = 延迟爆炸。
4. **上传/生成类功能验收必须包含「写完立即可访问」**：静态资源 404 只在「运行时新写」时
   暴露（重启后清单已含旧文件，回归测试测不出来）。上传 → 立即 curl 该 URL 应为 200。
5. **改渲染层 select 时核对数据模型全字段**：Prisma select 是白名单——管线写入的专有字段
   （如 `images`/`videoUrl`）若不在 select 里，页面静默丢内容且不报错。新增展示字段时
   同步加 select + DTO + 类型三处。

## R27 追加：AI 供应商切换与「服务器侧改动回滚」事故

**事故**（2026-09-14 发现）：R26 曾在服务器上手动改 `cron-task.sh`（auto-post 改 docker exec
容器内跑），但改动**只存在服务器、未回传 git**；R26b 部署按 git 白名单 rsync 时用仓库旧版
覆盖了服务器修复 → auto-post 退回宿主机直跑、视频链路再次断裂，且无人发现（服务器上的
`.bak-r26` 备份也已丢失）。同类问题：R25 切 MiniMax 只切了 `src/lib` 三处，`scripts/` 下
auto-reply/auto-boost-new/publish 管线仍走 DeepSeek，402 欠费后 AI 回复静默归零近一月。

## 规则（R27）

1. **凡是「先改服务器、后补提交」的热修复，当场必须回传 git**（scp 拉回本地 → commit →
   push），否则下一次 rsync/cd 部署必然静默回滚。验收清单加一条：`ssh diff` 服务器关键
   配置文件（cron-task.sh、compose）与 git HEAD 是否一致。
2. **切 AI 供应商（或任何外部依赖）必须全局 grep 供应商痕迹**（endpoint/模型名/API key
   env 名），逐个调用点确认；「src/ 切了、scripts/ 没切」的半切换等于没切。
3. **同一供应商的调用参数模式统一沉淀为一个参考实现**（本案 `src/lib/moderation.ts` 的
   MiniMax 模式：`api.minimax.cn` + `MiniMax-M3` + `max_completion_tokens`（非 max_tokens）
   + `thinking:{type:"disabled"}`（默认 adaptive 太慢）+ AbortSignal.timeout），新调用点
   照抄，不许自创参数组合。
4. 本仓库单测跑法是 `npm run test:unit`（node:test），**不是 vitest**——`npx vitest run`
   会把 node:test 文件全数报错，勿被误导。


