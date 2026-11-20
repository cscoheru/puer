import { NextRequest, NextResponse } from "next/server";
import { requirePermission } from "@/lib/admin-auth";
import { prisma } from "@/lib/prisma";
import {
  SITE_SETTING_KEYS,
  invalidateSiteSettingCache,
  parseSettingFlag,
} from "@/lib/site-settings";

export const dynamic = "force-dynamic";

/**
 * 首页内联回复 · AI 评论展示开关（`feed.aiReplies`）。
 *
 * 关闭时（默认）：首页预览与「N 条回复」计数都只算真人，AI 评论一条都不出现。
 * 打开时：真人预览不变；只有零真人评论的帖子会用一条带来源标注的 AI 评论兜底。
 *
 * 只影响首页预览，详情页的评论树不受影响（那里本来就带来源标注）。
 */
const KEY = SITE_SETTING_KEYS.feedAiReplies;

export async function GET() {
  const { error } = await requirePermission("admin:settings");
  if (error) return error;

  try {
    const row = await prisma.siteSetting.findUnique({
      where: { key: KEY },
      select: { value: true },
    });
    return NextResponse.json({ enabled: parseSettingFlag(row?.value) });
  } catch (e) {
    // 迁移没跑时这里会 500。返回一句能行动的话，不把 Prisma 原始信息丢给前端。
    console.error("[admin-settings]", JSON.stringify({
      key: KEY,
      category: e instanceof Error ? e.name : "unknown",
    }));
    return NextResponse.json({ error: "读取设置失败：确认已执行 20261120_site_settings 迁移" }, { status: 500 });
  }
}

export async function PUT(req: NextRequest) {
  const { session, error } = await requirePermission("admin:settings");
  if (error) return error;

  const body = await req.json().catch(() => null);
  if (!body || typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled 必须是布尔值" }, { status: 400 });
  }

  const value = body.enabled ? "1" : "0";
  const updatedBy = session?.user?.id ?? null;
  try {
    const saved = await prisma.siteSetting.upsert({
      where: { key: KEY },
      create: { key: KEY, value, updatedBy },
      update: { value, updatedBy },
      select: { value: true },
    });
    // 单实例部署：本进程缓存立即失效。多实例时其余实例最多 30 秒后跟上（见 site-settings.ts）。
    invalidateSiteSettingCache(KEY);
    // 回读落库的值，而不是回显请求体：两个管理员同时改时，回显意图会让
    // 先点的那位一直以为自己是生效的。
    return NextResponse.json({ enabled: parseSettingFlag(saved.value) });
  } catch (e) {
    console.error("[admin-settings]", JSON.stringify({
      key: KEY,
      category: e instanceof Error ? e.name : "unknown",
    }));
    return NextResponse.json({ error: "保存设置失败：确认已执行 20261120_site_settings 迁移" }, { status: 500 });
  }
}
