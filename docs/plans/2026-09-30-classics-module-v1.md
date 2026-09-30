# 经典普洱模块改版 V1

> 目标：经典普洱从「隔离栏目」变成「质量信号」——好帖自然进首页热榜，/forum/classics 降级为档案目录。
> 范围：纯渲染层 + feed 收录逻辑。**不动** schema、auto-post 管线、import 脚本、followed_teas。

## 现状诊断

### 首页热榜（/forum）
R5 规则把 classics 吧 + teaId 非空的帖子全部排除（除非手动升级 promotedHomeAt）。
结果：152 款经典茶、42 个跟进帖、N 篇品鉴帖——**首页用户完全看不到**。
侧边栏有「热点茶品·动态更新」入口，但点进去是茶品档案页，不是帖子。

### 经典普洱页（/forum/classics）
首屏同时展示 **5 个 tea list 入口**，其中 3 个内容几乎相同：

| # | 位置 | 内容 | 与主列表重复？ |
|---|---|---|---|
| 1 | 左侧 widget「热门茶品」 | 热度 top 10 | ✅ 同一批 |
| 2 | 移动端横滑「热门茶品」 | 热度 top 10 | ✅ 同一批 |
| 3 | 主区茶品列表 | 热度 top 120 | — 本体 |
| 4 | 吧导航 pills | 品牌筛选 | 有用，保留 |
| 5 | 右侧 LatestPosts | 全站最新帖 | 通用，保留 |

加上 header 大 banner + 「如何在吧里跟进」说明框——用户进来先看到一堆导航和说明，**看不到任何帖子内容**。

### 茶品页（/tea/[id]）
品鉴笔记 + 转化档案 timeline + 跟进帖——结构合理，但与主站割裂（跟进帖不进热榜，没人看）。

---

## V1 改动（4 刀）

### 刀 1：解除 R5 隔离，classics 帖进首页热榜

**文件**：`src/lib/forum-feed-server.ts`

现在：
```typescript
OR: [
  { teaId: null },
  { board: { slug: { not: "classics" } } },
  { promotedHomeAt: { not: null } },
]
```

具体规则：
| 帖子类型 | 进 feed 条件 | 说明 |
|---|---|---|
| 品鉴帖（auto-post 茶记，images 字段有图） | 无条件 | R26 后图片渲染已修复 |
| 跟进帖（discussion，无图） | replyCount ≥ 1 | 没人回复是自言自语，不值得推 |
| promotedHomeAt | 无条件 | 保留管理员手动升级通道 |
| 非 classics 帖 | 无条件 | 不变 |

实现策略：SQL 层移除 R5 OR 子句 → 全量抓取；JS 层 post-filter 排除「classics + teaId + replyCount=0 + 无图」孤儿跟进帖。

多样性保护：fetchForumFeed 返回前，classics 帖占比 ≤ 30% 截断（超出移至末尾，但仍出现在本页内）。

### 刀 1.5：分层轮转 — 每次刷新看到不一样的排序

**文件**：`src/lib/forum-feed-server.ts`

现状：v4 hot ranking 的 personalization seed = `${userId}:${dayBucket}` — 同一用户一天内看到相同排序。

目标：用户在信息站规模下，希望每次进来（哪怕刷新屏幕）都能看到不一样的内容。

实现：
1. **seed 改为 hourBucket**（`Math.floor(Date.now() / 3600000)`）— 排序每小时变一次
2. **保留现有 tierFactor 三层**：top 5 tierFactor=1.0（小时稳定） / mid 5-15 tierFactor=0.6（小时抖动） / tail tierFactor=0.3（小时重排）
3. **opportunity boost 保留**：从 rank 15-50 随机抽 2 条顶到 top 10（已有 seed-mod 随机）

效果：
- 用户 A 第一次进 feed：top 5 按质量 + hour 排序
- 用户 A 1 小时后再进：top 5 顺序微调，mid 10-15 可能换几个新帖顶上
- 用户 B 同一时刻进：top 5 顺序与 A 不同（userId 进 seed）
- 已读降权（localStorage seen）仍然有效：看过的帖子沉底，下次 hour 切回时再浮上来

**不动**：essence / latest tab 按时间倒序直查，不参与轮转（用户明确进入"最新/精华"语义）。

**改动量**：forum-feed-server.ts seedStr 改 1 行 + 注释（~5 行）

### 刀 2：/forum/classics 页面减肥

**文件**：`src/app/(main)/forum/classics/page.tsx`

砍掉：
- ❌ 移动端横滑条（和主列表内容重复）
- ❌ 左侧 HotTeasWidget（和主列表内容重复）
- ❌ 「如何在吧里跟进」说明框（信息放到茶品页跟进帖区域，那里才是用户发帖的地方）
- ❌ header banner 缩减为 1 行：标题 + 「发布新经典」按钮 + 一句话描述

改为两栏布局：

```
┌─────────────────────────────────────────────────────┐
│ 🏵️ 经典普洱（152 款）  [发布新经典]                    │  ← 1 行 header
├──────────────────────┬──────────────────────────────┤
│ [全部] [大益吧] [下关吧] │                              │  ← 品牌 pills（保留）
│ ┌──────────────────┐ │  📌 最近活动                   │
│ │ 茶品列表          │ │  ┌────────────────────────┐  │
│ │ （按热度排序）      │ │  │ 品鉴帖/跟进帖卡片流      │  │
│ │                  │ │  │ （最近 20 条，倒序）      │  │
│ │                  │ │  └────────────────────────┘  │
│ │                  │ │                              │
│ └──────────────────┘ │                              │
│ 茶品目录（静态导航）    │  活动流（动态内容）            │
└──────────────────────┴──────────────────────────────┘
                                    ┌──────────────────┐
                                    │ LatestPosts      │
                                    └──────────────────┘
```

左栏：茶品目录——用户来查「有哪些经典茶」。
右栏：最近活动——用户来看「最近在发生什么」。每条卡片链接到帖子（不是茶品页），用户能直接参与讨论。

**改动量**：page.tsx 重构（~200 行变更）+ 新增「最近活动」查询（~30 行）

### 刀 3：侧边栏 + 跟进帖联动

**文件**：`src/components/forum-sidebar.tsx` + `src/app/(main)/tea/[id]/page.tsx`

侧边栏 classics 入口：
- 保留「热点茶品·动态更新」12 款（不变）
- 底部加一行「最近经典帖」：显示最新 2 条 classics 帖标题 → 点击直接进帖子
  ```
  🏵️ 经典普洱 · 热点茶品·动态更新
  1. 601-大益班章有机
  2. 2003-黄大益
  ...
  ─────────────────
  💬 「2004-大益401-7532 转化跟进」3 回复
  💬 「2003-黄大益 开汤记录」1 回复
  ```

茶品页跟进帖区域：
- 每条跟进帖加「查看完整转化档案 →」链接回茶品页（闭环）

**改动量**：forum-sidebar.tsx +15 行 + tea/[id]/page.tsx +5 行

---

## 改动范围总结

| 文件 | 改动类型 | 预估行数 |
|---|---|---|
| `src/lib/forum-feed-server.ts` | 查询条件改 + 多样性截断 | ~40 |
| `src/components/forum-feed.tsx` | classics 徽章 | ~5 |
| `src/app/(main)/forum/classics/page.tsx` | 页面重构 | ~200 |
| `src/components/forum-sidebar.tsx` | 最近经典帖 | ~15 |
| `src/app/(main)/tea/[id]/page.tsx` | 跟进帖回链 | ~5 |

**总计**：5 文件 / ~265 行变更。不改 schema、不改管线、不改 import 脚本。

---

## 不做的事（明确排除）

- ❌ 新增 followed_teas 表（Step 1 关注流的事）
- ❌ 扩 SKU 到 200（用户决定手动新增）
- ❌ 茶样购买模块
- ❌ 改 auto-post / import-classic-teas.mjs
- ❌ 改 promotedHomeAt 升级机制（保留作为管理员工具，只是不再是唯一入口）

---

## 验收标准

1. 首页 /forum 热榜中出现 classics 帖（品鉴帖无条件、跟进帖 ≥1 回复）
2. 单页 feed 中 classics 帖占比 ≤ 30%
3. classics 帖卡片显示 🏵️ 徽章
4. /forum/classics 首屏：1 行 header + 品牌 pills + 两栏（茶品目录 + 最近活动流）
5. 不再出现同一批茶在首屏展示 3 次的情况
6. 侧边栏 classics 入口底部有最近经典帖标题
