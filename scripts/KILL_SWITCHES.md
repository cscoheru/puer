# 自动化内容脚本 · 停用开关

PRD v0.3 §12 第 3 条与 F0 要求：自动投票一律停止；AI 回复必须先带可见的自动化
标注（F0 标注上线前不发）。所有自动化脚本默认关闭，必须显式设置对应环境变量
才会运行 —— 开关是**默认关**，不是默认开。

| 脚本 | 环境变量 | 关闭原因 | 恢复前置条件 |
|---|---|---|---|
| `auto-vote.mjs` | `AUTO_VOTE_ENABLED=1` | F0：自动投票一律停止 | F0 标注上线，且投票对象有可见的自动化标注 |
| `auto-boost-new.mjs` | `AUTO_BOOST_NEW_ENABLED=1` | 灌票 + AI 回复，标注未上线 | 同上 |
| `boost-essence.mjs` | `BOOST_ESSENCE_ENABLED=1` | 同样往 `votes` 表灌票 | 同上 |
| `auto-reply.mjs` | `AUTO_REPLY_ENABLED=1` | prompt 要求「绝对不要暴露你是AI」，读者无法区分 AI 回复 | F0 标注上线 |
| `auto-register.mjs` | `AUTO_REGISTER_ENABLED=1` | §12 决策 7：暂停建号 | 站长明确恢复 |

## 为什么开关在脚本里而不是只在 crontab 里

crontab 停用只解决「不调度」，解决不了「有人手动跑」或「有人把它挂回去」。
脚本内的开关是最后一道闸：没有显式环境变量，脚本连数据库都不会碰，退出码 0
（主动停用，不是故障，不该触发 cron 的 ALERT 告警）。

## 不在此列的脚本

- `auto-post.mjs` —— AI 生成品鉴帖，**保持运行**。它走站长线草稿流程，产物是
  `status=draft`，由人工审核后才发布；F0 要给它加的是来源标注（`origin` /
  `disclosure_label`），不是停用。
- `ai-news-draft.mjs` —— PentAGI 每周资讯 → 草稿箱，**保持运行**。同样只写草稿。
- `cellar-reminders.mjs` —— F4 复饮提醒（给到期��茶仓条目发站内通知），
  **保持运行**。它不是内容生产，是用户自己的提醒；开关是 `CELLAR_REMINDERS_PAUSED=1`
  （一键暂停，与上面两个「暂停开关」同一套写法，暂停时退出码 0）。

## 验证

```bash
npm run test:unit          # 含 scripts/kill-switches.test.mjs
node scripts/auto-vote.mjs # 打印「已停用」并以 0 退出
```
