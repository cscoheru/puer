/**
 * F2「我的茶仓」API 的入参校验（PRD v0.3 §5 Phase 2）。
 *
 * ## 为什么用 zod 而不是手写 if
 *
 * 手写校验的通病是**漏一处**。这里 7 个接口的入参形状各不相同，
 * 每个都手写 if 的话，某个字段漏了长度上限就可能被灌进超长文本。
 * zod 的 schema 写一次，所有接口共用，且失败时能指出是哪个字段。
 *
 * **用 `safeParse` 不用 `parse`**：`parse` 抛异常 → Next.js 返回 500，
 * 把「用户填错了」变成「服务器炸了」。站内 `api/teas` 就是这个毛病
 * （`teaSchema.parse(body)`），这里不抄。
 *
 * ## 与数据库的关系
 *
 * 这里校验的是**形状与范围**，DB 里还有一层 CHECK 约束
 * （见 `prisma/migrations/20261023_cellar/migration.sql`）。
 * 两层都挡住才算数 —— 应用层会漂移，约束不会。
 *
 * 纯模块（只依赖 zod），可被裸 `node --test` 直接跑。
 */

import { z } from "zod";

/** 仓储评分：45–60 的整数（锚点 45/50/55/60，允许中间值）。 */
export const storageScoreSchema = z
  .number()
  .int()
  .min(45, "仓储评分不能低于 45")
  .max(60, "仓储评分不能高于 60");

/**
 * 四维评分：每维 1–10 的整数。
 *
 * `z.strictObject` 拒绝未知键 —— 拼错的键（`water_path`）如果被静默
 * 忽略，用户会以为自己打了分。`.partial()` 让四维可以只填一部分
 * （但综合分只在四维齐全时给，见 cellar.ts 的 overallScore）。
 */
export const dimsSchema = z
  .strictObject({
    aroma: z.number().int().min(1).max(10).optional(),
    flavor: z.number().int().min(1).max(10).optional(),
    waterPath: z.number().int().min(1).max(10).optional(),
    bodyFeel: z.number().int().min(1).max(10).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "四维评分不能是空对象" });

/** 仓储登记（三项都可跳过）。 */
export const storageSchema = z.strictObject({
  storageScore: storageScoreSchema.nullable().optional(),
  city: z.string().max(50, "城市名过长").nullable().optional(),
  container: z.string().max(50, "容器名过长").nullable().optional(),
});

/** 自建茶品申请。 */
export const teaRequestInputSchema = z.strictObject({
  name: z.string().min(1, "茶品名不能为空").max(200),
  brand: z.string().max(100).nullable().optional(),
  year: z.number().int().min(1900).max(2100).nullable().optional(),
  type: z.enum(["raw", "ripe"]).default("raw"),
  weightSpec: z.string().max(50).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/**
 * 新建茶仓条目。
 *
 * 二选一：`teaId`（茶品库里已有）或 `teaRequest`（自建申请）。
 * `targetUserId` 只有管理员能传 —— 代录用。
 */
export const createCellarItemSchema = z
  .strictObject({
    teaId: z.string().min(1).optional(),
    teaRequest: teaRequestInputSchema.optional(),
    name: z.string().max(200).nullable().optional(),
    acquiredAt: z.iso.datetime().nullable().optional(),
    qtyNote: z.string().max(100).nullable().optional(),
    remindEveryMonths: z.number().int().min(1).max(60).optional(),
    storage: storageSchema.optional(),
    targetUserId: z.string().min(1).optional(),
  })
  .refine((d) => Boolean(d.teaId || d.teaRequest), {
    message: "要么指定茶品，要么提交一个自建茶品申请",
  });

/** 改条目。 */
export const updateCellarItemSchema = z.strictObject({
  name: z.string().max(200).nullable().optional(),
  acquiredAt: z.iso.datetime().nullable().optional(),
  qtyNote: z.string().max(100).nullable().optional(),
  remindEveryMonths: z.number().int().min(1).max(60).optional(),
  nextRemindAt: z.iso.datetime().nullable().optional(),
});

/** 换仓（新增一条仓储期）。 */
export const addStorageEpochSchema = z.strictObject({
  startsAt: z.iso.datetime().optional(),
  storageScore: storageScoreSchema.nullable().optional(),
  city: z.string().max(50).nullable().optional(),
  container: z.string().max(50).nullable().optional(),
});

/** 记一条品鉴。 */
export const addTastingSchema = z.strictObject({
  tastedAt: z.iso.datetime().optional(),
  stage: z.enum(["ascending", "peak", "drinking", "declining"]).nullable().optional(),
  deltaVsPrev: z.enum(["better", "same", "worse"]).nullable().optional(),
  dims: dimsSchema.nullable().optional(),
  descriptors: z.array(z.string().min(1).max(40)).max(20).optional(),
  grams: z.number().min(1).max(100).nullable().optional(),
  vessel: z.string().max(40).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  images: z.array(z.string().max(500)).max(9).optional(),
  visibility: z.enum(["private", "shared"]).optional(),
  elapsedSeconds: z.number().int().min(0).max(86400).nullable().optional(),
});

/** 提交自建茶品申请（不一定要同时进茶仓）。 */
export const createTeaRequestSchema = teaRequestInputSchema;

/** 后台审核自建茶品申请。 */
export const reviewTeaRequestSchema = z
  .strictObject({
    action: z.enum(["approve", "reject"]),
    mergedTeaId: z.string().min(1).nullable().optional(),
    rejectReason: z.string().max(200).nullable().optional(),
  })
  .refine(
    (d) => d.action === "reject" || Boolean(d.mergedTeaId),
    { message: "通过时必须指定并入的茶品" },
  );

/**
 * 把 zod 的错误压成一句人话 + 字段名。
 *
 * `issues[0].message` 往往已经带了字段名（「仓储评分不能低于 45」），
 * 但没有路径时补上，方便前端直接标红对应输入框。
 */
export function zodMessage(error: z.ZodError): string {
  const first = error.issues[0];
  if (!first) return "参数不合法";
  const path = first.path.join(".");
  if (!path) return first.message;
  if (first.message.includes(path)) return first.message;
  return `${path}：${first.message}`;
}
