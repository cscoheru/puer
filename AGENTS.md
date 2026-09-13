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

