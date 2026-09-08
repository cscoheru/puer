# Puêr 开发总结

> **puer.im** — 中老期普洱茶爱好者社区
> 域名寓意：Puer（普洱拼音）+ I am = "我是普洱"

---

## 项目定位

一个专注于中老期普洱茶的中文社区，提供：
- **品茶论坛** — 类似贴吧/论坛的帖子系统，支持多版块、图文、视频
- **茶品百科** — 普洱茶品数据库，品牌、年份、规格等结构化管理
- **品鉴笔记** — 用户记录每泡茶的外形、汤色、香气、滋味、余韵评分
- **茶品互换** — 茶版/心愿单系统，支持用户间茶品互换和交易
- **百科词条** — 普洱茶知识库，涵盖工艺、山头、仓储等

---

## 技术栈

| 层 | 技术 | 说明 |
|---|------|------|
| 框架 | Next.js 16.2.6 (App Router) | 全栈 React 框架，SSR/SSG 混合渲染 |
| 语言 | TypeScript 5.x | 全栈类型安全 |
| 数据库 | PostgreSQL 16 | 主数据库 |
| ORM | Prisma 7.8.0 | 类型安全的数据库访问 |
| 认证 | NextAuth.js (Auth.js) | 邮箱 + 凭证登录 |
| 容器化 | Docker + Compose | Nginx + App + Postgres + Minio |
| 反向代理 | Nginx | SSL 终结、静态文件服务、WebSocket 代理 |
| 对象存储 | MinIO | 图片/视频文件存储 |
| 样式 | Tailwind CSS | 实用优先的 CSS 框架 |
| SSL | Let's Encrypt + Certbot | 自动续期 |
| 定时任务 | System Cron + Docker Exec | 内容生成、自动回复 |
| AI 生成 | DeepSeek API | 帖子/回复内容生成 |
| 视频处理 | FFmpeg 8.x | 图片轮播视频合成 |

---

## 架构概览

```
用户 → Cloudflare DNS → Nginx(:443) → Next.js App(:3002)
                                     → WS Server(:3011)
                                     → Postgres(:5432)
                                     → MinIO(:9000)
```

- **Nginx** 负责 SSL 卸载、静态文件直接服务（/uploads/）、WebSocket 代理
- **Next.js** 运行在 standalone 模式，处理 SSR 页面和 API 路由
- **WS Server** 独立 WebSocket 服务，用于实时通知
- **MinIO** S3 兼容对象存储，用于图片上传
- **PostgreSQL** 主数据库

---

## 核心功能模块

### 1. 用户系统
- 注册/登录（邮箱+密码）
- 等级体系（lv0-lv9）+ 经验值/karma
- 个人主页（帖子、茶版、心愿单、交易记录）
- 头像、签名、关注

### 2. 论坛系统
- 多版块（生茶、熟茶、茶具、闲谈等）
- 帖子：图文、视频、投票
- 评论：多级嵌套、富文本
- Like / 收藏 / 分享
- 搜索（标题+内容全文搜索）

### 3. 茶品百科
- 品牌、名称、年份、规格、工艺结构化管理
- 关联品鉴笔记和论坛帖子
- 封面图片

### 4. 品鉴笔记
- 五维评分（外形、汤色、香气、滋味、余韵）
- 冲泡参数记录（水温、投茶量、冲泡方式等）
- 多图上传
- 图片轮播视频自动生成

### 5. 茶品互换系统
- 茶版管理：添加/编辑/隐藏/删除（含有效期）
- 心愿单：求购茶品
- 交易请求：以茶换茶/购买，最多3轮还价
- 交易确认：自行交易 + 免责声明确认
- 大厅浏览：品牌/仓储/类型筛选，热门排序

### 6. 管理后台
- 用户管理（角色、封禁、等级）
- 内容管理（文章、评论审核）
- 茶品管理
- 举报处理
- 站点设置

### 7. AI 自动化
- **自动发帖**：从品鉴笔记生成轮播视频，以不同用户身份发布
- **自动回复**：12种人格（老茶客、暴躁老哥、杠精等），4回复/轮
- 通过系统 Cron 定时调度

---

## 部署架构

### 服务器配置
- **香港云服务器**：207.57.134.99
- **操作系统**：Ubuntu
- **Docker Compose** 编排所有服务
- **阿里云跳板机**：139.224.42.111（用于 SSH 代理）

### 容器列表
| 容器 | 镜像 | 端口 | 说明 |
|------|------|------|------|
| puer-hub-app | 自建 (Dockerfile) | 3002 | Next.js 应用 |
| puer-hub-postgres | postgres:16-alpine | 5432 | 数据库 |
| puer-hub-minio | minio/minio | 9000 | 对象存储 |
| puer-hub-ws | node:22-alpine | 3011 | WebSocket |

### 数据持久化
- **PostgreSQL**：Docker volume `pgdata`
- **MinIO**：Docker volume `minio-data`
- **上传文件**：bind mount `/opt/puer-hub/uploads/`
- **Evernote 图片**：bind mount `/opt/puer-hub/evernote_export/images/`

---

## 数据库核心模型

- **User** — 用户信息、等级、认证
- **Article** — 论坛帖子（图文/视频）
- **Comment** — 评论（多级嵌套）
- **Tea** — 茶品百科
- **TastingNote** — 品鉴笔记（五维评分）
- **TeaInventoryItem** — 茶版（含估价、有效期、隐藏）
- **TeaWishItem** — 心愿单
- **TradeRequest** — 交易请求（含还价、轮次、确认）
- **Board** — 论坛版块
- **Notification** — 通知系统

---

## 开发环境

```bash
# 启动
docker compose up -d

# 构建
docker compose build app

# 数据库迁移
docker compose exec app npx prisma db push

# 日志
docker compose logs -f app
```

---

## SEO 配置

- **robots.txt**: https://puer.im/robots.txt
- **Sitemap**: https://puer.im/sitemap.xml（动态生成，含帖子/茶品/版块）
- **JSON-LD**: WebSite + SearchAction 结构化数据
- **OG Tags**: 首页、帖子、茶品、用户页均支持
- **Google Search Console**: 可通过环境变量 `GOOGLE_VERIFICATION` 配置

---

## 已知问题和限制

1. **Prisma db push 在容器内不可用** — 因 `prisma.config.ts` 使用 dotenv 加载 .env 但容器无 .env 文件。需直接 SQL 修改数据库
2. **Next.js standalone 不提供运行时新增的静态文件** — 上传文件需通过 Nginx 直接服务
3. **自动发帖的 SSH 连接不稳定** — 香港服务器的 SSH 端口 16921 经常超时，需通过阿里云跳板机连接
4. **域名切换** — 从 `puer.rana.asia` 切换至 `puer.im`，Let's Encrypt SSL 已重新签发

---

## 国际化 (i18n)

- **简繁切换** — 基于 React Context + Cookie 的语言切换系统
- **翻译映射** — `src/i18n/translations.ts` 维护约 120 个高频 UI 词条的简繁对照
- **使用方式** — 组件中用 `useLocale()._("文本")` hook 实现自动翻译
- **持久化** — 用户选择通过 Cookie 存储，有效期 1 年

---

## 未来规划

- [ ] 繁简体中文切换
- [ ] 移动端 PWA
- [ ] 茶品交易在线支付
- [ ] 平台验货服务
- [ ] 全球普洱茶地图
- [ ] 多语言支持（英文/日文）
