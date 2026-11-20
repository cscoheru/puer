# PuerHub

普洱茶社区，基于 Next.js 16、React 19、Prisma 与 PostgreSQL。论坛入口是 `/forum`，繁体镜像是 `/tw/forum`；源码位于 `src/`。

## 本地检查

```bash
npm install
npx prisma generate
npm run typecheck
npm run test:unit
```

单测使用 `node:test`，不是 Vitest。真实 PostgreSQL 集成测试默认跳过，只有显式设置 loopback-only 的 `FEED_INLINE_TEST_DATABASE_URL` 才执行；不会回退到 `DATABASE_URL`。

## 首页内联回复：一键真实浏览器 QA

依赖已安装、Prisma Client 已生成后，只需：

```bash
npm run qa:feed:inline
```

它会创建临时 PostgreSQL 16、无 `.env*` 的隔离源码树、loopback 审核服务替身与随机端口 dev server，先用 Chromium 验证 flag-off，再验证 `/forum` 与 `/tw/forum` 的桌面/移动完整矩阵。截图、日志和结果写入 `.gstack/qa-reports/feed-inline-*`，退出时清理它拥有的进程与临时目录。

前置条件与缺失时的明确报错见 [docs/feed-inline-replies.md](docs/feed-inline-replies.md)。该命令不读取生产 `.env`，不连接非 loopback 数据库，也不会部署。

## 生产

生产镜像在服务器本机构建，不在 Mac 上构建。部署前必须阅读 `AGENTS.md` 与 `docs/release-checklist.md`；本仓库的部署同步必须带每次重新生成的 rsync `--files-from` 清单，严禁同步仓库根目录或生产 `.env`。
