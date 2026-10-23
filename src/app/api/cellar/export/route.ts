import { NextRequest } from "next/server";
import { cellarRateLimit, resolveCellarActor } from "@/lib/cellar-api";
import { cellarExportCsv, cellarExportJson } from "@/lib/cellar.ts";
import { exportCellarData } from "@/lib/cellar-data";

export const dynamic = "force-dynamic";

/**
 * GET /api/cellar/export?format=json|csv —— 导出我的全部茶仓数据。
 *
 * 站内**第一个**用户自助导出接口。PRD §4：「用户数据默认私有；
 * 参与匿名汇总需明确同意，可随时撤回、导出、删除」—— 导出权必须是
 * 用户自己拿在手里的，不是「联系管理员」。
 *
 * 只导自己的：数据层按 session 里的 userId 过滤，不收任何 userId 参数。
 */
export async function GET(req: NextRequest) {
  const { actor, error } = await resolveCellarActor();
  if (error) return error;

  const limited = cellarRateLimit(req, actor!.ownerId, "read");
  if (limited) return limited;

  const format = req.nextUrl.searchParams.get("format") || "json";
  const items = await exportCellarData(actor!.ownerId);
  const stamp = new Date().toISOString().slice(0, 10);

  if (format === "csv") {
    return new Response(cellarExportCsv(items), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="my-cellar-${stamp}.csv"`,
      },
    });
  }

  return new Response(JSON.stringify(cellarExportJson(items), null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="my-cellar-${stamp}.json"`,
    },
  });
}
