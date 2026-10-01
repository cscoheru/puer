/**
 * Simplified Chinese → Traditional Chinese translation map.
 * UI chrome only — user-generated content is preserved as-is.
 */

const zhCNtoTW: Record<string, string> = {
  // Navigation
  "论坛": "論壇",
  "首页": "首頁",
  "经典普洱": "經典普洱",
  "经典": "經典",
  "互换大厅": "互換大廳",
  "茶记": "茶記",
  "茶品库": "茶品庫",
  "品茶论坛": "品茶論壇",
  "云喝茶": "雲喝茶",
  "茶问": "茶問",
  "我的鉴定": "我的鑑定",
  "已提交人工鉴定，请耐心等待。": "已提交人工鑑定，請耐心等待。",
  "查看我的鉴定": "查看我的鑑定",
  "对结论存疑？提交人工鉴定": "對結論存疑？提交人工鑑定",
  "请先登录后查看您的鉴定单": "請先登入後查看您的鑑定單",
  "返回茶问": "返回茶問",
  "暂无鉴定单。在茶问页上传茶图提问，若 AI 置信不足会自动送人工鉴定，也可手动提交。": "暫無鑑定單。在茶問頁上傳茶圖提問，若 AI 置信不足會自動送人工鑑定，也可手動提交。",
  "待人工鉴定": "待人工鑑定",
  "人工鉴定意见": "人工鑑定意見",
  "探索社区": "探索社區",
  "发布新帖": "發佈新帖",
  "品鉴笔记": "品鑑筆記",
  "百科": "百科",

  // User menu
  "个人主页": "個人主頁",
  "收藏": "收藏",
  "设置": "設置",
  "退出登录": "退出登錄",
  "登录": "登錄",
  "注册": "註冊",
  // 通知面板：这三个字符串只出现在 user-menu.tsx，那个组件同时渲染在
  // /forum 和 /tw/forum 两种页面下，所以必须走本表（详见下方 forum feed 段注释）。
  "通知": "通知",
  "暂无通知": "暫無通知",

  // 关注 / 投票（follow-thread-button.tsx / vote-button.tsx）
  "已关注": "已關注",
  "关注帖子": "關注帖子",
  "推荐": "推薦",
  "不推荐": "不推薦",
  "登录后投票": "登錄後投票",

  // 版主申请（board-moderator.tsx）
  "版主：": "版主：",
  "申请版主": "申請版主",
  "取消申请": "取消申請",
  "版主申请审核中": "版主申請審核中",
  "申请未通过，可重新申请": "申請未通過，可重新申請",
  "申请已提交，等待管理员审核": "申請已提交，等待管理員審核",
  "普洱茶龄（年）": "普洱茶齡（年）",
  "申请理由": "申請理由",
  "提交申请": "提交申請",
  "提交中...": "提交中...",
  "提交失败": "提交失敗",
  "说说你对这个版块的理解和你打算如何管理...": "說說你對這個版塊的理解和你打算如何管理...",

  // 用户悬停卡（author-hover.tsx）
  "声望": "聲望",
  "茶龄": "茶齡",

  // Common actions
  "搜索": "搜索",
  "发布": "發佈",
  "编辑": "編輯",
  "删除": "刪除",
  "保存": "保存",
  "取消": "取消",
  "确认": "確認",
  "关闭": "關閉",
  "返回": "返回",
  "更多": "更多",
  "全部": "全部",
  "提交": "提交",

  // Time labels
  "刚刚": "剛剛",
  "分钟前": "分鐘前",
  "小时前": "小時前",
  "天前": "天前",
  "周前": "週前",
  "个月前": "個月前",
  "年前": "年前",

  // Forum
  "帖子": "帖子",
  "评论": "評論",
  "回复": "回覆",
  "点赞": "點贊",
  "分享": "分享",
  "举报": "舉報",
  "关注": "關注",
  "粉丝": "粉絲",
  "热门": "熱門",
  "最新": "最新",
  "精华": "精華",
  "置顶": "置頂",
  "搜索帖子": "搜索帖子",
  "发布帖子": "發佈帖子",
  "写评论": "寫評論",
  "查看详情": "查看詳情",
  // 帖子 flair（src/lib/forum-constants.ts）——卡片和详情页都会渲染
  "开汤": "開湯",
  "请教": "請教",
  "讨论": "討論",
  "晒茶": "曬茶",
  "原创": "原創",

  // Tasting notes
  "外形": "外形",
  "汤色": "湯色",
  "香气": "香氣",
  "滋味": "滋味",
  "余韵": "餘韻",
  "评分": "評分",
  "冲泡": "沖泡",
  "水温": "水溫",
  "投茶": "投茶",
  "耐泡": "耐泡",

  // Tea encyclopedia
  "品牌": "品牌",
  "品名": "品名",
  "年份": "年份",
  "规格": "規格",
  "工艺": "工藝",
  "生茶": "生茶",
  "熟茶": "熟茶",
  "仓储": "倉儲",
  "茶版估价": "茶版估價",

  // Exchange
  "茶版": "茶版",
  "心愿单": "心願單",
  "我的茶版": "我的茶版",
  "添加茶版": "添加茶版",
  "在架": "在架",
  "已下架": "已下架",
  "我想要": "我想要",
  "人想要": "人想要",
  "已过期": "已過期",
  "已隐藏": "已隱藏",
  "还原": "還原",
  "隐藏": "隱藏",
  "显示": "顯示",
  "永久有效": "永久有效",
  "有效期": "有效期",
  "自行交易": "自行交易",
  "平台验货": "平臺驗貨",
  "交易请求": "交易請求",
  "待处理": "待處理",
  "已接受": "已接受",
  "已拒绝": "已拒絕",
  "已确认": "已確認",
  "已取消": "已取消",
  "已被取代": "已被取代",
  "还价": "還價",
  "购买": "購買",
  "置换": "置換",
  "描述": "描述",
  "图片": "圖片",

  // Sessions
  "视频": "視頻",
  "音频": "音頻",
  "邀请": "邀請",
  "加入": "加入",
  "离开": "離開",

  // Inventory form labels
  "类型": "類型",
  "剩余克数": "剩餘克數",
  "购买时间": "購買時間",
  "开版时间": "開版時間",
  "货源": "貨源",
  "厂家一手": "廠家一手",
  "茶商二手": "茶商二手",
  "干仓高香": "乾倉高香",
  "干仓非高香": "乾倉非高香",
  "家庭自然仓": "家庭自然倉",
  "湿仓": "濕倉",
  "其他": "其他",

  // Buttons & misc
  "加载中": "加載中",
  "暂无数据": "暫無數據",
  "加载更多": "加載更多",
  "没有更多了": "沒有更多了",
  "确定": "確定",
  "提示": "提示",
  "操作成功": "操作成功",
  "操作失败": "操作失敗",

  // Errors
  "请先登录": "請先登錄",
  "无权限": "無權限",
  "未找到": "未找到",
  "参数错误": "參數錯誤",
  "服务器错误": "服務器錯誤",
  "网络错误": "網絡錯誤",
  "请重试": "請重試",

  // Forum feed (论坛列表 / 版块页共用外壳文案)
  // 说明：这些字符串由 forum-feed.tsx 等**同时渲染在简繁两种页面**上的组件使用，
  // 因此必须走本表而非 s2t.convertText —— 后者带 "server-only" 指令，进不了客户端包。
  "普洱茶论坛": "普洱茶論壇",
  "展开全文 ▼": "展開全文 ▼",
  "📅 本周": "📅 本週",
  "💎 精华": "💎 精華",
  "还没有精华帖": "還沒有精華帖",
  "暂无最新帖子": "暫無最新帖子",
  "今天还没有帖子，看看本周热榜吧": "今天還沒有帖子，看看本週熱榜吧",
  "暂无帖子": "暫無帖子",
  "正在加载更多…": "正在加載更多…",
  "上滑/滚动加载更多 ↓": "上滑/滾動加載更多 ↓",
  "— 到底了，去经典普洱茶吧逛逛 —": "— 到底了，去經典普洱茶吧逛逛 —",
  "审核中": "審核中",
  "审核通过后对所有人可见": "審核通過後對所有人可見",
  "个帖子": "個帖子",
  "上一页": "上一頁",
  "下一页": "下一頁",
  "页": "頁",
  "版块未找到": "版塊未找到",

  // Forum sidebar
  "新建社区": "新建社區",
  "社区": "社區",
  "建档中": "建檔中",
  "篇品鉴": "篇品鑑",
  "热点茶品 · 动态更新": "熱點茶品 · 動態更新",
  "💬 最近经典帖": "💬 最近經典帖",
  "关于 PuEr": "關於 PuEr",
  "广告合作": "廣告合作",
  "帮助": "幫助",
  "社区规则": "社區規則",
  "隐私政策": "隱私政策",
  "用户协议": "用戶協議",

  // Header / a11y
  "切换语言": "切換語言",
  "关闭搜索": "關閉搜索",
  "关闭菜单": "關閉菜單",
  "打开菜单": "打開菜單",
};

/**
 * Forum paths that have NO `/tw/` mirror yet.
 *
 * `/tw/` currently covers exactly three shapes: the forum index, a board page
 * (`/forum/<boardSlug>`), and a thread page (`/forum/thread/<id>`). Everything
 * else under `/forum` — classics, explore, new, search, boards, communities —
 * exists only on the simplified side and is `robots: disallow` for most of it.
 * Linking to those from inside the TW tree must stay unprefixed, or the click
 * lands on a 404.
 *
 * `thread` is deliberately absent: `/tw/forum/thread/<id>` is the one
 * non-board segment that IS mirrored.
 */
export const NON_MIRRORED_FORUM_SEGMENTS = new Set([
  "classics",
  "new",
  "explore",
  "search",
  "boards",
  "communities",
]);

/**
 * `/tw` and `/tw/...` are the traditional-Chinese tree.
 *
 * This is the single source of truth for the predicate. It is deliberately
 * exported: `src/proxy.ts` (server, sets `x-puer-locale`) and
 * `src/i18n/context.tsx` (client, forces the provider locale) must agree — if
 * they drift, the server ships one language's HTML and the client hydrates
 * with the other's. `i18n-paths.test.ts` pins `isTwPath(p) === (untwHref(p)
 * !== null)` so the two can never disagree silently.
 */
export function isTwPath(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return pathname === "/tw" || pathname.startsWith("/tw/");
}

/**
 * Keep a link inside the traditional-Chinese tree when the target has a TW
 * mirror.
 *
 * Without this, a TW reader who arrives on `/tw/forum` and clicks any post
 * falls straight back to the simplified site — the mirror would only ever be
 * one page deep, which is exactly the outcome the `/tw/` project exists to
 * avoid. Mirrored targets get the `/tw` prefix; everything else (user pages,
 * tea pages, non-mirrored forum sections, external links) is returned
 * untouched so we never manufacture a 404.
 *
 * The test is a positive allowlist over the mirrored **shapes**, not a
 * `startsWith("/forum")` prefix test and not a denylist over segment 2. Both of
 * those fail the same way: they cannot see that a *deeper* path under a
 * mirrored segment is a different page. `/forum/thread/<id>/edit` is the live
 * example — a real simplified-only route whose first three segments look
 * exactly like the mirrored thread shape, so a denylist rewrites it to
 * `/tw/forum/thread/<id>/edit`, which has no page. Matching the shape (depth
 * included) is what makes that unreachable.
 *
 * Query strings and hashes survive: the shape is read from the pathname part
 * only, and the prefix is applied to the full original href.
 */
export function twHref(locale: string | undefined, href: string): string {
  if (locale !== "zh-TW") return href;
  const pathname = href.split(/[?#]/)[0];
  // Segment-aware, not `startsWith("/forum")` — that would also swallow
  // "/forums", "/forum-x" and any future sibling route.
  const segments = pathname.split("/").filter(Boolean);
  if (segments[0] !== "forum") return href;
  const mirrored =
    segments.length === 1 || // /forum
    (segments.length === 2 && !NON_MIRRORED_FORUM_SEGMENTS.has(segments[1])) || // /forum/<board>
    (segments.length === 3 && segments[1] === "thread"); // /forum/thread/<id>
  if (!mirrored) return href;
  return `/tw${href}`;
}

/**
 * Inverse of {@link twHref}: strip the `/tw` prefix, or return `null` when the
 * path is not inside the traditional tree.
 *
 * Used by the language switch to walk *out* of the mirror. A `null` return is
 * meaningful — it distinguishes "this page has no traditional counterpart, so
 * flip the chrome instead" from "this page's traditional counterpart is `/`".
 */
export function untwHref(pathname: string): string | null {
  // "/tw/" as well as "/tw": a trailing slash would otherwise slice down to the
  // empty string, and `router.push("")` is a silent no-op rather than a walk
  // back to the simplified root.
  if (pathname === "/tw" || pathname === "/tw/") return "/";
  if (!pathname.startsWith("/tw/")) return null;
  return pathname.slice(3);
}

/**
 * What the header's language button should do, given where the reader is and
 * which language they are currently reading.
 *
 * Returns the destination (`href: null` = stay put) plus the locale the
 * cookie-backed state must hold afterwards. Both halves matter: the provider
 * is mounted once in the root layout and survives soft navigation, so a state
 * left over from the other tree would render one language's URLs with the
 * other's chrome.
 *
 * The two authorities split at the `/tw` boundary:
 *
 * - **Inside `/tw/...` the URL wins.** The reader asked for traditional by
 *   asking for this page, whatever last month's cookie says, so the button
 *   targets simplified and walks back out via {@link untwHref}. The state must
 *   be set too — `initialLocale` was frozen at first paint and will not re-run.
 * - **Outside it the cookie wins**, and the button targets the *other*
 *   language, not "the traditional tree". A reader on `/forum` whose cookie
 *   says zh-TW is already on a simplified URL; for them 简体 means flipping
 *   back in place, not navigating to a mirror they did not ask for.
 */
export function localeSwitch(pathname: string, locale: Locale): { href: string | null; locale: Locale } {
  const scPath = untwHref(pathname);
  if (scPath !== null) return { href: scPath, locale: "zh-CN" };
  if (locale === "zh-TW") return { href: null, locale: "zh-CN" };
  // Simplified chrome: prefer the real /tw page when the target has a mirror,
  // otherwise there is nothing to navigate to and the cookie has to carry it.
  const mirrored = twHref("zh-TW", pathname);
  if (mirrored !== pathname) return { href: mirrored, locale };
  return { href: null, locale: "zh-TW" };
}

/**
 * What language this request renders in, from the URL's opinion and the reader's
 * cookie.
 *
 * The two sources are **not** symmetric, and getting that wrong is a silent
 * mixed-language page rather than an error:
 *
 * - Inside `/tw/...` the URL forces `zh-TW` — the reader asked for traditional
 *   by asking for this page, whatever last month's cookie says.
 * - Outside it the URL has *no* opinion. `src/proxy.ts` stamps `x-puer-locale`
 *   to "zh-CN" on every non-`/tw` route, so treating the header as a general
 *   locale would make it non-null everywhere and silently outrank a reader's
 *   deliberate `zh-TW` cookie. The chrome would then be one language in the
 *   SSR HTML and another after hydration.
 *
 * Same shape as `forcedLocale ?? locale` in src/i18n/context.tsx and the same
 * rule as src/lib/locale-server.ts, which is the point: both call sites read
 * through here so there is one definition to get wrong.
 */
export function pickLocale(
  urlLocale: string | null | undefined,
  cookieLocale: string | null | undefined,
): Locale | null {
  if (parseLocale(urlLocale) === "zh-TW") return "zh-TW";
  return parseLocale(cookieLocale);
}

export function t(key: string, locale: string): string {
  if (locale !== "zh-TW") return key;
  return zhCNtoTW[key] || key;
}

export const LOCALE_COOKIE = "puer-locale";
export const DEFAULT_LOCALE = "zh-CN";
export type Locale = "zh-CN" | "zh-TW";

/**
 * Narrows an arbitrary string to a `Locale`, or `null` if it is not one.
 *
 * The cookie and the `x-puer-locale` header are both attacker-controllable, and
 * a bare `as Locale` cast would let a value like "zh-Hant" through — it matches
 * neither the zh-TW branch nor the map lookup, so the chrome silently degrades
 * instead of falling back. Every read of a locale from outside the type system
 * goes through here.
 */
export function parseLocale(value: string | null | undefined): Locale | null {
  return value === "zh-TW" || value === "zh-CN" ? value : null;
}
