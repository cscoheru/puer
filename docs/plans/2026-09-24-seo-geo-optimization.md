# puer.im SEO/GEO 优化方案 (2026-09-24)

数据源：GSC 导出 `seo/puer.im-Performance-on-Search-2026-09-24/` + `seo/puer.im-Coverage-2026-09-24/`，
PageSpeed Insights 报告（分析目标实际是 `https://puer.im/forum`），线上实测（curl / nginx 日志 / DB 查询）。

---

## 一、诊断结论：不是内容不够，是「入口断了 + 大词无承接页」

GSC 近 3 个月：**10 次点击 / 518 次展示**。收录 ~450 URL，但曝光几乎全部来自**长尾疑问句**，
核心大词（普洱 / 普洱茶 / 熟茶 / 生普）**展示数为 0** —— 说明 Google 根本没把站点和这些词建立关联。

### 1.1 致命项：高价值页面断了入口（自己造成的）

| 问题 | 证据 | 影响 |
|---|---|---|
| `/tea` 公开 404 | `curl -I https://puer.im/tea` → **404**；`tea/page.tsx:24` `if (role !== "admin") notFound()` | 152 个经典茶页的**总入口没了**，只靠 `/forum` 侧栏 12 条内链 + sitemap |
| `/encyclopedia` 307 → `/forum` | `encyclopedia/page.tsx` 全文只有 `redirect("/forum")` | 收录数据里这块**整个消失** |
| `/` 307 → `/forum` 但 sitemap 里是 priority 1.0 | **`src/app/page.tsx` 全文只有 `redirect("/forum")`**；`src/app/(main)/page.tsx`（有 H1/Hero/元数据的真首页）被它遮蔽成死代码 | canonical 信号冲突，首页展示 219 / 点击 1 |
| sitemap 收录 404 页 | `sitemap.ts:15,16` 仍列 `/tea`(404) + `/encyclopedia`(307) | 浪费抓取预算 |

### 1.2 覆盖报告 518 个 404 的真实构成

拆开看：nginx 日志里大量 404 是**扫描器噪音**（`/wp/`、`/wordpress/`、`/.env`、`/.git/config`、
`/docker-compose.yml`），这部分**不用管**。真正伤 SEO 的是：

- `/tea/{uuid}` 27 次（非经典 / 已删除茶品，`tea/[id]/page.tsx:73` `notFound()`）
  **更正**：`forum-sidebar.tsx:28,38,63` 的 `loadHotClassicTeas()` 已过滤 `isClassic: true`，侧栏内链**不会**产生这些 404。
  这些 404 来自站外旧链或曾被标记 classic 后取消的茶，属于自然衰减，**无需代码修复**
- `/tasting/{uuid}` 8 次（私人笔记页）
- 已删除的帖子 URL（软 404，全库 `grep` 无 `410`）

### 1.3 性能：Core Web Vitals 两项不合格

| 指标 | 移动 | 桌面 | 阈值 |
|---|---|---|---|
| LCP | 5.6 s | **15.0 s** | ≤2.5 s |
| CLS | 0.466 | **0.877** | ≤0.1 |
| Speed Index | 3.2 s | 11.2 s | |
| 总字节 | 19.3 MB | **22.6 MB** | |
| TBT / TTFB | 30 ms / 270 ms ✅ | 20 ms / 270 ms ✅ | |

关键审计（两者一致）：

- `image-delivery-insight`: 可省 **8.9 MB** —— `/uploads/evernote/*.jpg` 原图直出，实测单张 **335 KB**，**未走 `/_next/image`**（论坛页 `/_next/image` = 0 次）
- `cache-insight`: 可省 **8.9 MB** —— uploads 图片 `cache-control: public, max-age=86400`（**1 天**），而 `/_next/static` 是 1 年 immutable
- `layout-shifts`: 2 处，56 张图上 **0 张**有 `width`/`height`
- `unused-javascript` / `legacy-javascript`: 各 ~25 KB（小问题）
- SEO 100 / Best Practices 100 ✅，**accessibility 80–82**（`button-name`、`color-contrast`、`link-name`、`target-size` 失败）—— 影响 Rich Result 资格与 AI 抓取

### 1.4 缺失的 GEO / AI 检索友好度

- `/llms.txt` → **404**
- 结构化数据**已有**：站点级 `WebSite`+`SearchAction`（`layout.tsx:56-76`）、茶页 `Product`+`Brand`+**`aggregateRating`**（`tea/[id]/page.tsx:189-206`）、帖子页 `Article`+`VideoObject`+`BreadcrumbList`（`forum/thread/[id]/page.tsx:155-208`）
- **缺**：茶页 `BreadcrumbList`（有可见面包屑 nav 但无 JSON-LD）、帖子页 `DiscussionForumPosting`/`interactionStatistic`、`FAQPage`
- **sitemap 提图有 bug**：`sitemap.ts:32-48` 只从 `content` 正则提图，**未走 `extractFeedImages()`** —— 茶记管线帖的图在 `images` 字段、content 是纯文字，故这些帖子在 sitemap 里**全部无 `<image:image>`**（违反 AGENTS.md R26 规则 1）
- `/uploads/videos/` 用 `Accept-Ranges bytes`，但 `uploads/[...path]/route.ts:49` 设 `Accept-Ranges: none` —— 两套路径行为不一致

---

## 二、唯一大杠杆：152 个经典茶页

全库 `teas` = 1925（存活），其中 `isClassic` = **152**（对公众可见）。这 152 页的 title 已经很好：

```
大益 2003-大益302 7222 2003年 生茶普洱茶档案 | Puêr
```

H1 = `2003-大益302 7222`。**这是全站唯一能承接「品牌+年份+生熟+普洱茶」长尾词的资产。**

但：
1. 没有公开的**浏览入口**（`/tea` 被隐藏）
2. sitemap 只列 152 / 1925，其余 1773 个连 sitemap 都不进
3. 付费闸门（`tea/[id]/page.tsx:105` `isPaidMember = false`）让笔记正文不进 SSR —— 这个**设计是对的**（防内容泄露），但换来的公开内容偏薄：评分聚合、仓储信息、逐年时间线标题有，正文没有

**结论**：花力气做「内容创作」之前，先把这 152 页的入口和链接图谱修好，否则新内容也没人抓。

---

## 三、优化方案（按 ROI 排序）

### P0 —— 止血（1 天，纯增量，不碰数据结构）

| # | 改动 | 文件 | 验收 |
|---|---|---|---|
| P0-1 | sitemap 移除 `/tea`(404) 和 `/encyclopedia`(307)；补 `/forum/classics` | `src/app/sitemap.ts:15,16` | `curl /sitemap.xml` 不含这两条、含 classics |
| P0-2 | 删 `src/app/page.tsx`（3 行的 `redirect("/forum")`），让 `(main)/page.tsx` 接管 `/` | `src/app/page.tsx` | `curl -I https://puer.im/` → **200**（现为 307） |
| P0-3 | `/forum` 加 H1（现全子树零个 h1；「热点茶品」标题是 `<div>` 不是 heading） | `(main)/forum/page.tsx:53` 附近 | 爬虫视角有 h1 + 正确层级 |
| P0-4 | nginx uploads 4 个 location：`expires 30d` → `expires 30d; add_header Cache-Control "public, immutable";`，并**删除影子文件** `sites-enabled/puer.bak.1781436958` | `/etc/nginx/sites-enabled/puer` + 回写到 repo `deploy/nginx/` | `curl -I` 显示 `max-age=2592000` 且**无双 Cache-Control 头** |
| P0-5 | sitemap 提图改用 `extractFeedImages()`（现只从 content 正则提，茶记帖图全丢） | `src/app/sitemap.ts:32-48` | 茶记帖在 sitemap 里有 `<image:image>` |
| P0-6 | 新增 `/llms.txt` | `public/llms.txt` | 200 + 品牌/内容结构说明 |

### P1 —— 结构（3–5 天，SEO 主战场）

| # | 改动 | 文件 | 为什么 |
|---|---|---|---|
| P1-1 | **恢复 `/tea` 公开**：删 `:24-25` 的 admin 闸门，查询加 `isClassic: true`；同时处理 `:63-68` admin 专属按钮（公开后是死链）、补 `gallery`/`tastingNotes` 到查询 | `(main)/tea/page.tsx` | **单行数据过滤改动**（`:34`）；152 页获得聚合入口 + 内链图谱 |
| P1-2 | 新增 `/tea/brand/[brand]`、`/tea/type/[raw\|ripe]`、`/tea/year/[year]` 落地页 | 新建路由 | **直接承接「大益 普洱茶」「熟茶」「生普」大词**，各 300–600 字导语。品牌分布：大益 47 / 未知 28 / 下关 22 / 福今 21 / 黎明八角亭 7 / 今大福 6（≤6 的品牌页太薄，只给 top 5 建页）；生茶 135 / 熟茶 17 |
| P1-3 | 茶页补 `BreadcrumbList` JSON-LD（**`Product` + `aggregateRating` 已存在**，`:196-206`）；并在面包屑恢复 `/tea` 一级（`:210` 注释显示是 P2-R23 删掉的） | `tea/[id]/page.tsx:210` | 争取富摘要；所需数据（`avgScore`/`heroImgAbs`/`tea.*`）**全在作用域内，无需新查询** |
| P1-4 | 帖子页补 `interactionStatistic`/`commentCount`（`Article` + `BreadcrumbList` 已存在） | `forum/thread/[id]/page.tsx:155-208` | 互动数据 `_count.likes`/`_count.comments`/`viewCount` 已在作用域内 |
| P1-5 | 图片 `width`/`height`（56 张图上 0 张有尺寸，CLS 0.877 主因） | 图片组件 | CLS → ≤0.1 |
| P1-6 | 抽共享模块：`teas` 卡片/`firstTeaImage` 现散落在 `forum/classics/page.tsx:55-93,344-365` 未 export；`BRANDS` 常量在 `tea/page.tsx:20` 与 `tasting/page.tsx:8` 重复 | 新建 `src/lib/` 或 `src/components/tea/` | 消除重复，避免三处漂移 |

### P2 —— 内容与收录（1–2 周）

| # | 改动 | 为什么 |
|---|---|---|
| P2-1 | 写 4 篇 pillar 页（`/guide/puer` `/guide/ripe` `/guide/raw` `/guide/dayi`），2000+ 字，内链到茶页与帖子 | 大词无承接页是根本原因 |
| P2-2 | 「爱豆乔木之纯是熟普吗」这类疑问词的落地优化：wiki 式问答页 + FAQPage schema | 该词 **192 展示 / 排名 9.16 / 0 点击** —— 已在首末页，改摘要就能拿点击 |
| P2-3 | 底部加精选茶页内链模块（「热门档案」20 条，全站可见） | 55 页 URL 的点击分布极度不均，内链权重集中 |
| P2-4 | 已删帖 → 410 Gone；同时 sitemap 只收 `status=published` 且非 draft（现在含 `tasting-draft_*`） | 减少软 404 稀释信任 |
| P2-5 | URL slug 化 `/tea/大益-7542-2003`（需 301 迁移 + canonical 更新） | URL 含关键词的边际收益；**成本最高，放最后** |

---

## 四、要不要做（我的建议顺序）

1. **P0 全做**（1 天，纯增量，不碰数据结构）—— 其中 P0-2/P0-4 对性能分数的贡献最大，且立即可验证
2. **P1-1 + P1-2**（3 天）—— 这是「大词进前几页」的必要条件，不做的话 P2 写了也没人抓
3. **P1-3/4/5/6**（2 天）—— 富摘要 + CWV + 去重
4. **P2-2 优先于 P2-1** —— 已经有 192 展示的词，改标题/摘要的 ROI 高于从零写 pillar 页
5. P2-5（slug 化）**暂缓**（已决策）—— 152 页 301 迁移的复杂度与风险，收益不如前几项

---

## 五、风险与回滚

| 风险 | 说明 | 缓解 |
|---|---|---|
| **P0-2 换首页 = 产品行为变更** | 游客打开 `puer.im` 从「论坛 feed」变成「营销首页」，多一次点击才能到论坛。这是本项目**首次**让 route group 提供根路径 | 保留醒目「进入论坛」CTA（`:57-60` 现有按钮）；若数据变差可恢复 3 行 redirect |
| **P0-4 动 nginx = 可能整站 502** | 改的是**线上配置**；`nginx -t` 通过才 reload | 先 `cp -r /etc/nginx /opt/puer-hub/backups/nginx-rollback-<ts>/`；用 `nginx -t` 校验；失败立即还原 + reload |
| **`sites-enabled/puer.bak.1781436958` 影子配置** | 与 `puer` **同 listen + 同 server_name**，nginx 取先加载者。当前 `puer` 先生效（输出 `max-age=86400`）；`.bak` 里是 `public, immutable`。**两份冲突配置同时加载**，顺序一变行为就变 | P0-4 一并删除 `.bak`；并把正确配置回写 repo `deploy/nginx/`（AGENTS.md R27：服务器改动必须回传 git） |
| **`(main)/page.tsx` 是 `force-dynamic`** | 接管 `/` 后每请求打 3 次 count + 1 次 findMany，`revalidate = 300` 被 `force-dynamic` 覆盖（失效） | 观察 DB 负载。~~需要的话去掉 `force-dynamic` 让 300s ISR 生效~~ —— **此缓解措施不成立**：该页 `auth()` + `visibleArticleWhere(session?.user?.id)`，内容随访客变化，路由本质就是动态的，去掉指令也回不到 ISR。真要减负得用 `unstable_cache` 包住匿名分支（注意本仓已知的 unstable_cache/Date 坑）。见修正 5.3 |
| **Next 16 路由冲突地雷** | `src/app/page.tsx` 与 `(main)/page.tsx` 同时解析到 `/`，当前靠字典序侥幸不报错（`next-app-loader/index.js:542-588`）；顺序一变就 build 失败 | 删掉 `src/app/page.tsx` **正好消除**这个地雷 |

## 六、验证方式（每项）

- **sitemap**：`curl -s https://puer.im/sitemap.xml | grep -c '<loc>'`，抽样全 200，且 `grep -c 'image:image'` > 0
- **首页**：`curl -I https://puer.im/` → 期望 **200**（现 307）；HTML 里有那个 H1
- **/tea**：`curl -s https://puer.im/tea` → 200 且列出经典茶；`curl -s 'https://puer.im/tea?brand=大益'` 命中 47 条
- **/forum H1**：`curl -s https://puer.im/forum | grep -c '<h1'` ≥ 1
- **缓存**：`curl -I https://puer.im/uploads/evernote/28dfc50eda50.jpg` → `max-age=2592000` + `immutable`，且**只有一行 Cache-Control**
- **结构化数据**：Google Rich Results Test / `grep BreadcrumbList`
- **性能**：PageSpeed API 重跑（**今日配额已耗尽 429**，需等次日或加 key）；或本地 `lighthouse` CLI
- **收录**：GSC「覆盖率」+「查询」7 天后复查：404 数量、`普洱/熟茶/生普` 是否开始有展示

## 七、已决策事项

1. `/` → **渲染成真首页**（删 `src/app/page.tsx`）✅ 已选
2. `/tea` → **只列经典茶**（`isClassic: true`）✅ 已选
3. URL slug 化 → **暂缓，不列入本期** ✅ 已选

---

## 八、执行记录与修正（2026-09-24 实施 P0+P1 时发现）

实施过程中有三处**与上文初判不符**，此处按实证修正（上文保留原样以便对照）。

### 修正 1：P0-4 的「双 Cache-Control 头」是误判

原文称 nginx 同时使用 `expires 30d` 与 `add_header Cache-Control` 会产生**两个**
Cache-Control 头，需要删掉 `expires`。**实测不成立**：

```
$ curl -sD - -o /dev/null --http1.1 https://puer.im/uploads/evernote/28dfc50eda50.jpg | grep -icE "^cache-control"
1
```

nginx 的 `expires` 在已有自定义 `Cache-Control` 时不覆盖它，只额外输出 `Expires` 头。
因此只改 `add_header` 的值即可（4 行改动），无需删除 `expires`。

另：`sites-enabled/puer.bak.1781436958` **不在线上**（`ls` 只有 `puer` 与 `spike`
两个文件，那是一次 2026-07 备份 tar 里的残留快照），无需删除。

**附带发现（未修）**：nginx systemd 单元自 2026-09-16 起处于 `failed`，master 是手工
启动的（PID 1066704）。`systemctl reload nginx` 报 `nginx.service is not active`，
须用 `nginx -s reload`。单元仍是 `enabled`，重启后 systemd 会正常拉起 —— 不阻塞本次，
但属于待收敛的运维漂移。

### 修正 2：P1-5 的「56 张图 0 张有尺寸」是误读，CLS 另有主因

`unsized-images` 审计的实际得分是 **1.0（通过）** —— Lighthouse 只判定「尺寸不由 CSS
决定」的图片，而本站图片基本都在 `aspect-[4/3]` 或固定 `w-* h-*` 容器里，所以不算问题。

`layout-shifts` 审计给出了真正的元凶：

| 端 | 偏移元素 | 分数 | 审计给出的原因 |
|---|---|---|---|
| 桌面 | `div.flex-1 > div.space-y-1 > div > div.bg-white`（feed 卡片本体） | 0.877 | Media element lacking an explicit size |
| 桌面 | 同上（另一张卡片） | 0.547 | Media element lacking an explicit size |

即：**卡片被内部媒体元素撑高**，不是 `<img>` 缺属性。追到 `VideoPlayer`
（`src/components/video-player.tsx`）：feed 模式下 `src` 由 IntersectionObserver
延迟注入（`shouldLoad`）且 `preload="none"`，`<video>` 在元数据到达前没有固有宽高
→ 加载后卡片高度突变。

**已做的修复**：给 feed 卡片的媒体元素补显式尺寸（`<video>` 640×360、
轮播/封面图 400×300、头像 32×32、侧栏缩略图 28×28、最新帖子缩略图 48×48）。
`<img>` 的属性属于顺带补齐（审计本就通过），**真正被这条审计点名的 `<video>` 才是修复主体**。
CLS 是否真的降到 ≤0.1 需要重跑审计确认（PSI 配额当日耗尽）。

**仍待排查**：`forum-feed.tsx` 的 `setState`-in-effect、`Cannot call impure function
during render` 等 7 条 react-compiler 规则报错在 HEAD 上已存在（基线 6/2/2 条），
属于渲染期副作用，也可能是残余 CLS 的来源之一 —— 不在本期范围内。

### 修正 3：P0-1 移除 `/tea` 与 P1-1 公开 `/tea` 相互矛盾

原文 P0-1 要「移除 `/tea`(404)」，P1-1 又要把 `/tea` 做成公开页。两条一起做时，
末期状态应是 **保留 `/tea`**（它不再是 404）。最终 sitemap 静态页为：

```
/ (1.0) · /forum (0.9) · /forum/classics (0.8) · /tea (0.8) · /exchange (0.7)
```

`/encyclopedia` 按原计划移除（仍 307 至 `/forum`）。

### 修正 4：复盘发现的 4 处缺陷（均在提交前修复）

原方案没覆盖这些，是实施后自查 + DB 实测才暴露的，逐条记录以免后人重犯。

**4.1 `?year=abc` 会让公开的 `/tea` 500（Prisma `NaN` 校验）**

`where.year = parseInt(year, 10)`：`?year=abc` 得到 `NaN`，而 Prisma 对 `Int` 字段收到
`NaN` 会抛 `PrismaClientValidationError` → 500。同类问题还有 `?page=1e21` 让 `skip` 溢出
Int。原 `:24-25` 的 admin 闸门恰好把这两个输入面挡在外面，**公开后闸门没了，容错也必须补上**。
已加 `Number.isFinite` 守卫 + `page` 上限 500 + `q` 截断 64 字符。

**4.2 落地页把「DB 抖动」翻译成了 404 —— 比 500 更伤 SEO**

`loadFacets()` / `loadClassicTeas()` 原先都 `.catch(() => [])`。这两个函数只被
`force-dynamic` 的落地页调用（不在 build 期执行），所以那个 catch 在生产里**只做一件事**：
把瞬时 DB 故障吞成空分布 → `self` 缺失 → `notFound()` → **404**。
而 404 正是「请把这个 URL 移出索引」的信号；5xx 才会被视作暂时故障、保留 URL。
已移除两处 catch，让故障如实抛成 5xx。

**4.3 P0-5 修得不完整：`where` 仍要求 `content` 非空（线上实测命中 1 篇）**

`articleImages()` 改成走 `extractFeedImages()`（合并 content ∪ images）之后，
`where` 里那句 `content: { not: "" }` 就成了漏网的旧假设 —— 图只在 `images` 字段、
正文为空的帖子会被**整个排除在 sitemap 之外**，正是 P0-5 要修的那类静默丢内容。

DB 实测（`status='published' AND visibility<>'private'`）：

```
total_pub | empty_content | empty_content_WITH_images | has_images
      308 |             1 |                         1 |        184
```

即 308 篇里 184 篇有图、其中 1 篇正文为空但有图。已把条件改为
`OR: [{ content: { not: "" } }, { images: { isEmpty: false } }]`。

**4.4 聚合页 `lastModified: new Date()` 是无信息量时间戳**

sitemap 是 `force-dynamic`，`lastModified` 恒等于抓取时刻 → Google 会判定该字段无信息量，
并连带削弱文章页/茶品页上**真实** `updatedAt` 的可信度。已改为取该类目下最新一款茶的
`updatedAt`（`groupBy` 加 `_max`；生熟页从 `findMany` 的 `updatedAt` 里归并取最大）。

> 遗留（未改，属既有行为）：5 个静态页（`/`、`/forum`、`/forum/classics`、`/tea`、`/exchange`）
> 与板块页仍在用 `now`。它们没有天然的最新时间戳来源，需要另想（如取站内最新文章 `updatedAt`），
> 不在本期范围。

### 修正 5：提交前代码审查发现的缺陷与处置（2026-09-24）

按「>3 文件必须过审」规则做了一轮独立审查（只读，未改文件）。逐条处置如下。

| # | 问题 | 严重度 | 处置 |
|---|---|---|---|
| 5.1 | **`/tea/[id]` 品牌面包屑对 `未知` 生成 404**：闸门写成 `brandTeaCount >= LANDING_MIN_TEAS`，漏了 `loadFacets()` 里的 `未知` 排除。而 `未知` 有 **28 款**经典茶（≥6），故这 28 个公开茶页的面包屑（可见 nav 与 `BreadcrumbList` JSON-LD 同源）都指向 `/tea/brand/未知` → 404 | **高** | 改为直接由 `loadFacets()` 判断 hub 是否存在，与落地页的 `notFound` 闸门**同源**，不可能再漂移 |
| 5.2 | `/tea/[id]` 生熟面包屑**没有**阈值闸门（只判 `normalizeTeaType` 非空），与紧邻的品牌级规则不一致。今天 raw 135 / ripe 17 都过线所以未触发，一旦某类掉到 6 以下，152 个页面会同时挂 404 内链 | 中 | 同上，一并由 `facets.types` 判断 |
| 5.3 | 风险表里「去掉 `force-dynamic` 让 300s ISR 生效」**不成立**：该页 `auth()` + `visibleArticleWhere(session?.user?.id)`，内容随访客变化，路由本质动态 | 中（文档错误） | 已在风险表就地更正；真正减负需 `unstable_cache` 包匿名分支（本仓有 unstable_cache/Date 坑，未做） |
| 5.4 | **非经典（私有）茶品名/厂牌/年份从 404 响应体泄漏**：`generateMetadata` 只查 `{id, deletedAt:null}`，无 `isClassic` 判断；正文 `notFound()` 了，但 metadata 随 RSC payload 下发。线上实测：匿名 curl 一个非经典茶 id → 404，HTML 里能读到茶名与 og/canonical。与仓库「P2-R23 茶品库绝对隐藏」的声明直接冲突 | 中（既有，被本次公开化放大） | `generateMetadata` 加 `isClassic` 判断 + 非 admin 返回通用 metadata 与 `index:false` |
| 5.5 | **uploads 四个 location 丢掉全部 server 级安全头**：nginx 的 `add_header` 不叠加 —— location 里出现任意一条 `add_header`，server 级整块不再继承。故 `/uploads/*` 无 HSTS / XFO / nosniff / COOP / Referrer-Policy。`/uploads/forum/` 是用户上传内容且同源，缺 `nosniff` 是实际攻击面 | 中（既有安全缺口） | 四个 location 各自补齐这 5 条；`nginx -t` 通过后 reload，公网 cache-bust 实测 5 条全部到位。已回写 repo 并在 `deploy/nginx/README.md` 记录该陷阱 |
| 5.6 | sitemap 年份闸门 `year > 0` 比页面校验 `1900..2100` 宽，脏数据会「sitemap 收录但 404」 | 低 | 抽 `YEAR_RANGE` 常量，`loadFacets` / sitemap / 页面校验三处共用 |
| 5.7 | 聚合阈值逻辑被复制到 3 处（`loadFacets` / `sitemap` / `/tea`），5.1 正是漂移产物 | 中 | `sitemap.ts` 改为直接调 `loadFacets()`，重复实现删除 |
| 5.8 | `loadClassicTeas` 的 `{...CLASSIC, ...where}` 让调用方能静默覆盖 `isClassic` | 低 | 改为 `{...where, ...CLASSIC}`，公开过滤不可被调用方关闭 |
| 5.9 | `<video>` 占位 640×360（16:9）与 `slideshow-video.ts` 实际产出的 **720×720 正方形**不符 → 只是把一次跳变换成另一次更小的跳变，**不是消除 CLS** | 中（诚实性） | 代码注释与文档据实说明；**不得把本次当作 CLS 已达标上报**，须重跑审计 |
| 5.10 | `/tea` 未进全站导航（P1-1 的「聚合入口」只靠面包屑/sitemap 到达，内链图谱建不起来）；`/tea` 网格标题层级 h1→h3 跳级 | 中 / 低 | 桌面与移动导航都加「茶品库 → `/tea`」；`TeaList`/`TeaGrid` 的条目标题 h3→h2 |
| 5.11 | `LikeAction` 用的是 `article.upvotes`（与 downvotes 配对的投票分），而模型里另有 `_count.likes` | 低 | 改用 `_count.likes`，语义与 schema.org 对齐 |

**审查判定为无问题的部分**（未再改动）：安全/访问控制（`/tea` 与落地页全走 `{deletedAt:null, isClassic:true}`，DB 实测 raw135+ripe17=152 与 `isClassic` 总数吻合）、Next 16 路由遮蔽（静态段优先于 `[id]`，tea id 是 UUID 不可能撞）、Prisma 查询（无 N+1）、重构等价性（与 HEAD 中 `forum/classics` 的本地版本逐字相同）、JSON-LD XSS 转义。

**审查中的一条已是过期信息**：审查报告的 M4 称 `tea-landing-server.ts` 与 `tea/brand` 仍有 `.catch(() => [])` —— 那是我在本轮自查中**已经改掉**的（见修正 4.2），审查读到的应是改动前的快照。当前该文件里唯一的 `catch` 字样在注释里。

### 仍未做（明确留待后续）

- **`public/llms.txt` 是硬编码清单**，与 `LANDING_MIN_TEAS` 今天一致但没有生成器 —— 阈值或品牌分布变化后会静默腐化
- **`location /pikafish/` 同样丢掉 server 级安全头**（同一 add_header 机制），它是另一套应用、不服务用户上传内容，本次未动
- **5 个静态页与板块页的 `lastModified` 仍是 `now`**（见修正 4.4 的遗留说明）
- `forum-feed.tsx` 的 7 条 react-compiler 规则报错（HEAD 基线 6/2/2，本次未新增）—— 渲染期副作用，可能是残余 CLS 来源之一

### 实际落地的类目聚合页（P1-2，阈值 ≥6 款经典茶）

- 品牌 5 个：大益 47 / 下关 22 / 福今 21 / 黎明八角亭 7 / 今大福 6（`未知` 28 款排除）
- 生熟 2 个：生茶 135 / 熟茶 17
- 年份 9 个：2003 21 / 2004 18 / 1999 17 / 2005 15 / 2001 14 / 2006 11 / 1997 7 / 1998 6 / 2010 6

合计 16 个聚合页，全部进 sitemap，并从 `/tea` 与彼此之间互链。

### 新增共享模块（P1-6）

| 文件 | 内容 |
|---|---|
| `src/lib/tea-query.ts` | `teaListSelect` / `TeaListRow` / `firstTeaImage` / `heatScore` / `sortByHeat` / `normalizeTeaType` / `PREFERRED_BRANDS` / `LANDING_MIN_TEAS` |
| `src/lib/tea-landing-server.ts` | `loadFacets`（品牌/生熟/年份分布）/ `loadClassicTeas` |
| `src/components/tea/tea-thumb.tsx` | `TeaThumb`（原 `forum/classics` 内私有组件） |
| `src/components/tea/tea-list.tsx` | `TeaList`（行）/ `TeaGrid`（卡片网格） |
| `src/components/tea/tea-landing.tsx` | 三类聚合页共用外壳 + `BreadcrumbList` JSON-LD |

`forum/classics/page.tsx` 已改为引用共享模块，本地 `teaListSelect`/`firstTeaImage`/
`heatScore`/`TeaThumb`/`TeaList`/`ClassicTeaRow` 六处重复定义删除。
`BRANDS` 硬编码列表收敛为 `PREFERRED_BRANDS`（`tea/page.tsx` 与 `tasting/page.tsx`
仍各自持有同一份列表，未合并 —— `tasting` 是 admin 页，不在本期）。

### 本地验证证据（未部署前）

| 检查 | 命令 | 结果 |
|---|---|---|
| 类型检查 | `npx tsc --noEmit` | 我方 12 个文件 0 错；仅剩 3 条**既有**错误（`.next/types/validator.ts` 引用已删的 `src/app/page.js` 属生成物残留；`tests/tea-drafts/runner.integration.test.ts` 缺 `@prisma/adapter-pg`） |
| Lint | `npx eslint <改动文件>` | 7 条 error 全在**未改动行**（`forum-feed.tsx` 的 react-compiler 规则 5 条、`latest-posts.tsx:20` 的 `any`、`video-player.tsx:23` 的 setState-in-effect）；HEAD 基线同类计数为 6/2/2，即本次**未新增** |
| 构建 | `npm run build` | **EXIT=0**；路由表出现 `ƒ /`（根路径终于解析到真首页，无冲突）、`/tea`、`/tea/brand/[brand]`、`/tea/type/[type]`、`/tea/year/[year]`、`/sitemap.xml` |
| 单测 | `npm run test:unit` | **220 pass / 0 fail** |
| 阈值一致性 | DB 查询 | 经典茶年份范围 0–2023，≥6 款的年份无 <1900 者 → sitemap 与落地页 `notFound` 阈值不会打架；经典茶 `type` 全部为 `raw`/`ripe`，无值被 `normalizeTeaType` 丢弃 |

构建时 `PrismaClient can't reach database server at localhost:5432` 是预期的 ——
本地无 Postgres，所有 DB 查询都在 `try/catch` 或 `.catch()` 内，不影响构建产物。
线上真实渲染仍需部署后验证。

### 尚未验证（需部署后）

- `/` 是否真的返回 **200**（本地构建只能证明不再有 redirect stub）
- `/tea` 与其下 16 个聚合页是否 200、`isClassic` 过滤是否生效
- sitemap 实际 XML 内容（loc 数、`image:image` 数）
- `/llms.txt` 是否 200
- CLS 是否真的下降（需重跑 Lighthouse）

## 九、附带发现（本次未列入方案，待评估）

- **百度/中文搜索**：`robots.ts` 只针对 `*`，无 Baiduspider 专门配置；站点是中文站但只有 Google 数据。是否需要 百度站长平台 验证 + 主动推送，值得单独评估（可能比 Google 更容易拿到中文流量）
- **`/uploads/videos/` 用 `Accept-Ranges bytes` 但 `uploads/[...path]/route.ts:49` 设 `Accept-Ranges: none`** —— 两套路径行为不一致，视频拖动进度条在兜底路由下会失败


---

## 十、部署状态：回滚点已就绪，部署被 SSH 阻断（2026-09-24 19:25 CST）

**生产未发生任何变更，`puer.im` 仍运行 `ef5d8e8`（2026-09-13 镜像），站点健康**
（`/forum` 200，`/ask` 200/1.15s）。本次部署**尚未执行**。

### 回滚点（3 个，均已建立并验证）

| 回滚点 | 位置 | 验证 |
|---|---|---|
| git tag | `deployed-20260924-pre-seo` → `ef5d8e8`，已推 origin | ✓ |
| DB 全量转储 | `puer-hk:/opt/puer-hub/backups/puerhub-pre-seo-20260924T110920Z.dump` | `pg_restore -l` 38 表，含 articles(477 COPY 行)/teas/tasting_notes/users/site_daily_stats ✓ |
| 镜像 tag | `puer-hk`: `puer-hub-app:pre-deploy-20260924` → `sha256:1b45384c…` | ✓ |

uploads 另有每日 03:17 全量备份（最新 2026-09-24，465MB）；nginx 配置在
`/opt/puer-hub/backups/nginx-puer-1790247407.conf` 且已入库 `deploy/nginx/`。
deploy.sh 在 activate 失败时会自动写 `app.rollback.override.yml` 并回滚。

### 阻断原因：SSH 到 puer-hk 握手超时

- 现象：`ssh puer-hk` 超时；但 `nc -z 207.57.134.99 16921` **TCP 可连通**，ICMP 41ms 正常。
  即端口开放、SSH 协议握手卡住 —— 指向 sshd 侧（反向 DNS 卡顿 / sshd 过载 / fail2ban 软封）。
- 处置：按 AGENTS.md R26b 规则 1，同类命令超时 2 次即停止重试；站点健康故不动生产。
- 恢复后直接续做下面的步骤即可。

### 关键结论：**本地构建不可能成功**，必须服务器端 build

- 本机 colima 是 **aarch64**，产出 arm64 镜像；生产服务器是 **x86_64**，
  `puer-hub-app:latest` 是 **amd64/linux**。架构不匹配，本地镜像根本跑不起来。
- 本地 `.releases/` 里 9/1 的遗留镜像实测就是 `arm64/linux`。
- 且 colima 构建容器内 DNS 不通（`getaddrinfo EAI_AGAIN binaries.prisma.sh`），
  `npx prisma generate` 无法下载引擎。
- 这解释了 `releases/20260913T034500Z-ef5d8e8/` 为何是空目录 —— 上次线上部署走的
  就是既有的「服务器端 build 绕道」（见记忆 `puer-hub-deploy-fallback`）。

### 待执行步骤（SSH 恢复后）

构建上下文可由 HEAD 复现（= APP_CONTEXT 从工作树拷贝，排除 `public/uploads` 与
`src/generated`；deploy.sh 的 `copy_entry` 即为该语义）。已完成并核对：

- `/tmp/puer-ctx-app`：336 文件，与 `./deploy.sh plan` 的期望清单**逐条一致**
  （baseline 326 ∪ overlay 30 − 已删的 `src/app/page.tsx`）；已清掉 2 个 `.DS_Store`。
- `/tmp/puer-ctx-app.tar.gz` sha256 `143e164e20699e8355e7e74301a07bd04ac2421681724177872df3a62a3eda12`
- `/tmp/release-plan.txt`（含 336 行 context sha256 清单，格式与 `write_release_plan` 一致）

```bash
RID=20260924T110948Z-1d31783
# 1+2. 上传上下文（tar 与 release-plan.txt 已备好）
ssh puer-hk "mkdir -p /opt/puer-hub/releases/$RID/build-context"
scp /tmp/puer-ctx-app.tar.gz /tmp/release-plan.txt "puer-hk:/opt/puer-hub/releases/$RID/"
ssh puer-hk "cd /opt/puer-hub/releases/$RID && tar -xzf puer-ctx-app.tar.gz -C build-context && rm -f puer-ctx-app.tar.gz"

# 3. 服务器端 build（后台 + 日志落地，勿 sleep 轮询）
ssh puer-hk "cd /opt/puer-hub/releases/$RID/build-context && nohup bash -c 'docker build --tag puer-hub-app:$RID . > /tmp/build-$RID.log 2>&1; echo EXIT=\$? >> /tmp/build-$RID.log' >/dev/null 2>&1 &"

# 4. 生成发布产物（activate 要求 app.image.tar + .sha256）
ssh puer-hk "cd /opt/puer-hub/releases/$RID && docker image save --output app.image.tar puer-hub-app:$RID && sha256sum app.image.tar > app.image.tar.sha256"

# 5. activate —— 必须传【两个】compose 文件，否则丢掉 9 个 bind mount（含全部 uploads）
PUER_REMOTE_COMPOSE_FILES=/opt/puer-hub/docker-compose.yml:/opt/puer-hub/docker-compose.override.yml \
  ./deploy.sh activate app $RID --confirm-activate
```

第 5 步的 compose 文件链是**硬性要求**：线上 `puer-hub-app` 容器由
`docker-compose.yml` + `docker-compose.override.yml` 两个文件创建，9 个 bind mount
（`/opt/puer-hub/uploads/* → /app/public/uploads/*`、`scripts/*.mjs`、`src/lib/tea-drafts`）
都写在主 compose 里。只传主文件会让 `compose up` 重创容器并丢掉全部挂载 ——
用户图片与视频会立刻从站点消失。已用 `docker compose config` 从 3 个不同 cwd
验证相对路径恒解析为 `/opt/puer-hub/uploads/...`。

验证脚本已写好：`/tmp/puer-verify.sh`（8 组检查，含 `/` 200、`/tea` 及 16 个聚合页、
sitemap loc 与 `image:image`、结构化数据、uploads 缓存与 5 条安全头、查询参数容错、`/ask`）。

### 本次部署携带的全部改动（须向用户说明）

本次发布是 **21 个提交的完整 HEAD**（R24–R28e + SEO P0/P1），不只是 SEO ——
因为 `extractFeedImages()` 在 `ef5d8e8` 中尚不存在，SE0 改动依赖其所在的 R26 工作，
**无法**做成只含我方文件的局部 overlay。发布后另有两个提交（`fd33d25`、`fecc07e`）
不属镜像内容（deploy.sh / compose 均不在 APP_CONTEXT 内）。

### 顺带修复的两处问题（已提交并推送）

1. **`fd33d25` deploy.sh 自 9/13 起对本仓库不可用**：`3fdb699`（R26b）新增的源码文件
   `src/app/uploads/[...path]/route.ts` 被 `PROTECTED_PATTERNS` 的 `*/uploads/*` 误判为
   protected；`validate_overlay_path` 又用子串判穿越（`*'..'*`），而 catch-all 目录名
   `[...path]` 字面含 `..`。两处均改为精确语义。此前无部署，故潜伏未现。
2. **`fecc07e` 服务器端口加固未回传 git**：服务器的 `docker-compose.yml` 早已把
   MinIO(9005/9006) 与 app(3002) 改为只绑 `127.0.0.1`，仓库里却仍是 `0.0.0.0`
   （`ss -lntp` 确认线上是加固版）。按 R27 规则 1 回写，回写后 sha256 与服务器一致。

### 审查过但**决定不动**的漂移

- `scripts/deploy-standby.sh`：服务器仍是 `DEEPSEEK_API_KEY`，git 已改 `MINIMAX_API_KEY`。
  但该变量在脚本第 23 行赋值后**从未被使用**（死配置），且这是给全新服务器用的
  standby provisioning 脚本、不在生产部署路径上 —— 改动无收益，仅记录。
- `scripts/` 下 114 个 tracked 文件中 113 个与 git 一致，说明 R26/R28 的脚本修复
  确实已在服务器上；`src/lib/tea-drafts`（被 host 挂载覆盖的目录）20 个文件也全一致，
  故挂载不会遮蔽本次镜像内的改动。
