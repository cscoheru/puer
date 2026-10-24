import { NextRequest, NextResponse } from "next/server";
import { cellarRateLimit, readJsonBody, resolveCellarActor } from "@/lib/cellar-api";
import { addTastingSchema, zodMessage } from "@/lib/cellar-schemas";
import { addTastingGuarded, listItemTastings } from "@/lib/cellar-data";
import { formatWaitMessage } from "@/lib/cellar";

export const dynamic = "force-dynamic";

/**
 * POST /api/cellar/[id]/tastings —— 记一条品鉴。
 *
 * 快速品鉴的三下点击（比上次 → 阶段 → 保存）打到这里；
 * 四维、描述词、备注、图片、视频、克重、器具都是可选项，不传就留空。
 *
 * `elapsedSeconds` 由前端记录 —— 退出标准要「快速品鉴中位耗时 < 30 秒」，
 * 这个数只能从客户端拿。
 *
 * **同一条茶的两次品鉴至少隔 24 小时**（2026-10-24 站长要求）——
 * 间隔按**服务端写入的 createdAt** 算，客户端传来的 tastedAt 伪造不了。
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {

  const { id } = await params;

  // 第一道门是**可见性**：看不见茶仓的人回 404，不能让他拿到 400 的参数
  // 校验错误 —— 那等于告诉他「这个接口存在、还要这些字段」。
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const { body, error: bodyError } = await readJsonBody(req);
  if (bodyError) return bodyError;

  const parsed = addTastingSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: zodMessage(parsed.error) }, { status: 400 });
  }
  const d = parsed.data;

  const limited = cellarRateLimit(req, actor!.ownerId, "write");
  if (limited) return limited;

  // 24 小时间隔：同一条茶，两次品鉴至少隔一天。
  //
  // 检查与写入在**同一个事务**里（数据层），而且先拿一把按「用户+茶」
  // 派生的 advisory lock —— 否则两个并发请求会同时读到「没有上一条」，
  // 各写一条，规则就被绕过了。「上一次」按服务端写入的 createdAt 算，
  // 客户端传来的 tastedAt 伪造不了。
  //
  // tastedAt 完全由客户端给，而它决定时间轴的排序（也就决定「比上次」
  // 看到的是哪一条）。允许往回填 —— 忘了记是常事；但不许填到未来，
  // 否则一条 tastedAt=9999 的记录会永远钉在时间轴最上面。
  const tastedAt = d.tastedAt ? new Date(d.tastedAt) : undefined;
  const maxTastedAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (tastedAt && tastedAt.getTime() > maxTastedAt.getTime()) {
    return NextResponse.json(
      { error: "品鉴时间不能是未来" },
      { status: 400 },
    );
  }

  let result: Awaited<ReturnType<typeof addTastingGuarded>>;
  try {
    result = await addTastingGuarded(actor!.ownerId, id, {
      tastedAt,
      stage: d.stage ?? null,
      deltaVsPrev: d.deltaVsPrev ?? null,
      dims: d.dims ?? null,
      descriptors: d.descriptors ?? undefined,
      dimTags: d.dimTags ?? undefined,
      grams: d.grams ?? null,
      vessel: d.vessel ?? null,
      note: d.note ?? null,
      images: d.images ?? undefined,
      videos: d.videos ?? undefined,
      elapsedSeconds: d.elapsedSeconds ?? null,
    });
  } catch (err) {
    // 写库失败必须**留痕** —— 否则用户只看到「保存失败」，日志里什么都没有，
    // 排障时连是不是数据库的问题都不知道（AGENTS.md：静默降级 = 延迟爆炸）。
    console.error("[cellar] 记品鉴失败", {
      itemId: id,
      code: (err as { code?: string })?.code ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
    // 并发争锁 / 连接池排不上 → 让他稍后重试，而不是「保存失败」。
    const code = (err as { code?: string })?.code ?? "";
    if (code === "P2028" || code === "P2024") {
      return NextResponse.json(
        { error: "写入繁忙，请稍后重试" },
        { status: 503 },
      );
    }
    return NextResponse.json({ error: "保存失败" }, { status: 500 });
  }

  if (!result.ok) {
    if (result.reason === "wait") {
      return NextResponse.json(
        {
          error: formatWaitMessage(result.waitMs),
          waitMs: result.waitMs,
        },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ id: result.id }, { status: 201 });
}

/**
 * GET /api/cellar/[id]/tastings —— 这条目的全部品鉴记录（时间轴）。
 *
 * 前端用它渲染「我的线」；条目页的「站长线对照」另走茶品页那条线。
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {

  const { id } = await params;
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read");
  if (limited) return limited;

  // 只查品鉴这一张表 —— 取整个条目详情要 4 条 SQL，其中 3 条的结果会被丢掉。
  const tastings = await listItemTastings(actor!.ownerId, id);
  if (!tastings) {
    return NextResponse.json({ error: "条目不存在" }, { status: 404 });
  }
  return NextResponse.json({ tastings });
}
