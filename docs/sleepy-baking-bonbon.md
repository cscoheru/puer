# 品鉴 → 品茶论坛改造方案

## Context

目前"品鉴"功能定位为品鉴笔记工具（创建评分 → 查看文章 → 评论互动），用户希望将其改造为经典 BBS 论坛模式，复刻"茶语清心""三醉"等早期茶论坛的体验。核心转变：从"写笔记"到"发帖讨论"。

现有基础设施可复用：
- `Article` 模型已支持 `type: "article" | "tasting" | "discussion"`，可作为帖子基座
- `Comment` 已支持嵌套回复（`parentId` 自引用）
- Like 模型已支持多态点赞（文章/评论）
- Favorite 模型已支持收藏
- 用户等级/经验系统已就位

## 架构设计

### 核心新增模型

**Board（版块）** — 论坛分类目录
```
id          String @id @default(cuid())
name        String @db.VarChar(50)       // 版块名称：普洱醇香、茶器雅韵...
slug        String @unique @db.VarChar(50) // URL 标识符
description String? @db.VarChar(200)      // 版块简介
icon        String?                       // 图标 emoji 或 URL
sortOrder   Int     @default(0)           // 排序
postCount   Int     @default(0)           // 帖子数（非规范化计数）
threadCount Int     @default(0)           // 主题数
lastPostedAt DateTime?                    // 最后发帖时间
createdAt   DateTime @default(now())
@@map("boards")
```

**Article 扩展字段** — 直接在现有模型上加
```
boardId    String?    // 可选 FK→Board（品鉴笔记可以不归属版块，保持向后兼容）
board      Board?     @relation

isPinned   Boolean @default(false)  // 置顶帖（版主/管理员）
isEssence  Boolean @default(false)  // 精华帖（版主/管理员标记）

lastRepliedAt DateTime?              // 最后回复时间（用于排序）
replyCount    Int     @default(0)    // 回复计数（非规范化）
```

### 数据关系

```
Board ──1:N──> Article (作为帖子归属版块)
Board ──1:N──> BoardModerator (版主关联)
User  ──1:N──> BoardModerator (用户担任版主)

Article ──1:N──> Comment (作为回帖，现有结构不变)
```

### 旧数据兼容

已有 75 篇 type="tasting" 的笔记保持原样访问：`/tasting/[id]` 路由不变。它们没有 boardId，在论坛不显示，但通过首页"品鉴"区块仍可访问。新发的论坛帖子 type="discussion"。

---

## 实施步骤

### 步骤 1：Schema 更新 + 数据迁移

**文件**: `prisma/schema.prisma`

- 新增 `Board` 模型
- 新增 `BoardModerator` 模型（可选，初期可先不加）
- Article 新增字段：`boardId`, `isPinned`, `isEssence`, `lastRepliedAt`, `replyCount`
- 运行 `prisma db push` 推送到数据库
- 编写种子脚本 `scripts/seed_boards.py` 创建初始版块：

| 版块 slug | 名称 | 说明 |
|-----------|------|------|
| puer | 普洱醇香 | 普洱茶品鉴讨论 |
| heicha | 黑茶雅韵 | 黑茶交流 |
| teacup | 茶器清心 | 茶器、紫砂、建盏 |
| water | 茶水人生 | 茶人茶事、以茶会友 |
| knowledge | 习茶问道 | 茶知识、茶文化 |
| trade | 茶市风云 | 茶品交流、求购转让 |

### 步骤 2：API 端点

**文件**: `src/app/api/boards/route.ts`（新建）
- `GET /api/boards` — 版块列表，含帖子计数和最后帖子信息
- 公开访问，无需登录

**文件**: `src/app/api/boards/[slug]/route.ts`（新建）
- `GET /api/boards/[slug]` — 版块详情，含帖子列表（分页）
  - 支持参数：`page`, `sort`（`latest` | `essence` | `pinned`）
  - 置顶帖优先显示
- `POST /api/boards/[slug]` — 在该版块发帖（需登录）
  - 创建 type="discussion" 的 Article

**文件**: `src/app/api/articles/[id]/route.ts`（新建）
- `GET /api/articles/[id]` — 单帖详情（现有功能已在页面端实现）
- `PUT /api/articles/[id]` — 编辑帖子（仅作者或管理员）
- `DELETE /api/articles/[id]` — 删除帖子（仅作者或管理员）

**已有 API 无需变更**：
- `POST /api/comments` — 回帖功能不变
- `POST /api/likes` — 点赞功能不变
- `POST /api/favorites` — 收藏功能不变

### 步骤 3：论坛首页

**文件**: `src/app/(main)/forum/page.tsx`（新建）
- 版块网格布局（Board 列表）
- 每个版块显示：名称、简介、帖子数、最后帖子信息
- 顶部可放"最新帖子"列表（跨版块混排）
- `force-dynamic`，服务端渲染

### 步骤 4：版块帖子列表页

**文件**: `src/app/(main)/forum/[slug]/page.tsx`（新建）
- 帖子列表（分页，每页 20 条）
- 排序：置顶帖固定在前 → 按最后回复时间降序
- 每行显示：标题（精华/置顶标记）、作者、回复数、最后回复时间
- 右侧显示版块信息栏（版主、版规等）

### 步骤 5：帖子详情页（论坛版）

**文件**: `src/app/(main)/forum/thread/[id]/page.tsx`（新建）
- 与现有 `/tasting/[id]` 类似，但面向讨论场景：
  - 顶楼显示帖子正文（支持 HTML 内容）
  - 下方为回帖列表（树形嵌套，使用现有 Comment 模型）
  - 每个回帖显示：作者信息、发表时间、点赞按钮
  - 底部回帖表单（无需登录也可浏览，但需登录才能回帖）
- 保留 LikeButton、FavoriteButton、ShareButton
- 版主/作者可见"精华/置顶"操作按钮

### 步骤 6：发帖页面

**文件**: `src/app/(main)/forum/new/page.tsx`（新建）
- 选择版块（下拉框）
- 标题输入
- 内容编辑器（支持 HTML/富文本，或 Markdown）
- 发布按钮 → 提交到 `POST /api/boards/[slug]`
- 需要登录才能访问

### 步骤 7：导航改造

**文件**: `src/components/layout/header.tsx`
- 将"品鉴"改为"论坛"，链接到 `/forum`
- 保留"品鉴"入口：可在论坛导航中或首页保留入口

### 步骤 8：精华 + 置顶管理

**文件**: `src/app/api/boards/[slug]/pin/route.ts`（新建）
- `POST /api/boards/[slug]/pin` — 置顶/取消置顶（版主或管理员）

**文件**: `src/app/api/boards/[slug]/essence/route.ts`（新建）
- `POST /api/boards/[slug]/essence` — 精华/取消精华（版主或管理员）

**精华帖视图**：论坛首页和版块页面均可筛选精华帖

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 帖子模型 | 复用 Article + type="discussion" | 避免数据迁移，复用现有评论/点赞/收藏系统 |
| 旧品鉴数据 | 保留原样，不迁移到论坛 | 兼容性，避免破坏已有数据 |
| 回帖结构 | 复用 Comment 嵌套模型 | 已支持树形回复，无需修改 |
| 非规范化计数 | 存 replyCount / postCount | 避免频繁 COUNT 查询 |
| Markdown vs HTML | 保持 HTML（同现有 content 字段） | 一致性和向后兼容 |

## 关键文件清单

### 新增文件
| 文件 | 用途 |
|------|------|
| `prisma/schema.prisma` | 更新（Board + Article 扩展字段） |
| `scripts/seed_boards.py` | 初始化版块数据 |
| `src/app/(main)/forum/page.tsx` | 论坛首页 |
| `src/app/(main)/forum/new/page.tsx` | 发帖页面 |
| `src/app/(main)/forum/[slug]/page.tsx` | 版块帖子列表 |
| `src/app/(main)/forum/thread/[id]/page.tsx` | 帖子详情 |
| `src/app/api/boards/route.ts` | 版块列表 API |
| `src/app/api/boards/[slug]/route.ts` | 版块详情/发帖 API |
| `src/app/api/boards/[slug]/pin/route.ts` | 置顶管理 API |
| `src/app/api/boards/[slug]/essence/route.ts` | 精华管理 API |
| `src/app/api/articles/[id]/route.ts` | 帖子编辑/删除 API |

### 修改文件
| 文件 | 变更 |
|------|------|
| `src/components/layout/header.tsx` | "品鉴"→"论坛"导航 |
| `prisma/schema.prisma` | 新增 Board 模型，Article 扩展字段 |

---

## 验证方案

1. **Schema 验证**: `prisma db push` 执行成功，表结构正确
2. **种子数据**: 运行 seed_boards.py 后数据库 boards 表有 6 条记录
3. **API 测试**:
   - `GET /api/boards` 返回版块列表
   - `POST /api/boards/puer` 创建帖子成功
   - `GET /api/boards/puer` 返回帖子列表含新帖
4. **页面访问**:
   - `/forum` 显示版块网格
   - `/forum/puer` 显示帖子列表
   - `/forum/thread/[id]` 显示帖子内容和回帖
5. **部署**: `bash deploy.sh` 构建成功，生产环境验证以上页面 200
