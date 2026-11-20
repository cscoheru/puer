import { prisma } from "./prisma.ts";

/**
 * 站点级运行时开关（`site_settings` 表）。
 *
 * 为什么不放 `.env`：`.env` 的开关要 `docker compose up -d` 重建容器才生效，
 * 而且改它得登上服务器。产品层的开关（今天要不要展示 AI 回复）属于运营决策，
 * 应该由管理员在后台点一下就生效。
 *
 * 统一策略：**读不到就是关闭**。这里管的都是「默认不该出现」的东西，数据库
 * 抖动时宁可少显示，也不能把本该藏起来的内容放出来。
 */

export const SITE_SETTING_KEYS = {
  /**
   * 首页内联回复的预览里是否展示 AI 评论。
   *
   * 关闭时预览与「N 条回复」计数都只算真人 —— 两边口径必须一致，否则卡片会
   * 出现「查看全部 5 条回复」+「当前没有可预览的顶层回复」的自相矛盾。
   */
  feedAiReplies: "feed.aiReplies",
} as const;

export type SiteSettingKey = (typeof SITE_SETTING_KEYS)[keyof typeof SITE_SETTING_KEYS];

/** 布尔开关的解析口径：只认 `1`/`true`（忽略大小写与首尾空白），其余一律false。 */
export function parseSettingFlag(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

const CACHE_TTL_MS = 30_000;

interface CacheEntry {
  value: boolean;
  at: number;
}

interface FlagCache {
  values: Map<string, CacheEntry>;
  /** 每次失效 +1。在途读取发现版本变了就不回写，见下方注释。 */
  generation: number;
}

// 与 src/lib/prisma.ts 一样挂到 globalThis：dev/HMR 与打包都会重建模块实例，
// 每个实例一份缓存会让「保存后立即生效」偶发失效。
const globalForSettings = globalThis as { __siteSettingCache?: FlagCache };
const cache: FlagCache = globalForSettings.__siteSettingCache ??= {
  values: new Map(),
  generation: 0,
};

/** 后台写入后调用；单实例部署下本进程缓存立即失效。 */
export function invalidateSiteSettingCache(key?: SiteSettingKey): void {
  if (key) cache.values.delete(key);
  else cache.values.clear();
  cache.generation += 1;
}

export async function isSiteFlagEnabled(key: SiteSettingKey): Promise<boolean> {
  const now = Date.now();
  const hit = cache.values.get(key);
  // 负数间隔说明系统时钟被往回拨过：按过期处理，否则一次时钟回跳就能把
  // 缓存无限延长（找不到那行之后仍会继续显示旧值）。
  if (hit && now >= hit.at && now - hit.at < CACHE_TTL_MS) return hit.value;

  const generation = cache.generation;
  try {
    const row = await prisma.siteSetting.findUnique({
      where: { key },
      select: { value: true },
    });
    const value = parseSettingFlag(row?.value);
    // 查询在途时后台可能刚把这个开关改掉并调用了 invalidate。此时回写会把
    // 刚被作废的旧值重新钉满一个 TTL（点击关闭后 AI 评论还继续出现 30 秒）。
    // 本次请求仍用读到的值，但不再写回缓存。
    if (cache.generation === generation) {
      cache.values.set(key, { value, at: Date.now() });
    }
    return value;
  } catch (error) {
    // 失败不写缓存：一次数据库抖动不该把错误状态锁 30 秒，下一次请求要重新试。
    // 日志只记键名与错误类别，不记录任何内容。
    console.error("[site-settings]", JSON.stringify({
      key,
      category: error instanceof Error ? error.name : "unknown",
    }));
    return false;
  }
}

/** 首页内联回复是否展示 AI 评论（默认关闭）。 */
export function isFeedAiRepliesEnabled(): Promise<boolean> {
  return isSiteFlagEnabled(SITE_SETTING_KEYS.feedAiReplies);
}
