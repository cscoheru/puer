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
// 相对路径：这个文件要被裸 `node --test` 直接跑（路径别名 @/ 解析不了）。
// 阶段/对照的取值**只有一份** —— 在 F1 的词表里（src/lib/tasting-extract/vocab.ts），
// DB 的 CHECK 约束是它的第三份镜像，改一处要三处一起改。
import { DELTAS, STAGES } from "./tasting-extract/vocab.ts";
import {
  CELLAR_MAX_DESCRIPTORS,
  CELLAR_MAX_DIM_TAGS,
  CELLAR_MAX_ELAPSED_SECONDS,
  CELLAR_MAX_IMAGES,
  CELLAR_MAX_VIDEOS,
  DIM_MAX,
  DIM_MIN,
  STORAGE_SCORE_MAX,
  STORAGE_SCORE_MIN,
  type DimKey,
} from "./cellar.ts";

/** 仓储评分：45–60 的整数（锚点 45/50/55/60，允许中间值）。 */
export const storageScoreSchema = z
  .number()
  .int()
  .min(STORAGE_SCORE_MIN, `仓储评分不能低于 ${STORAGE_SCORE_MIN}`)
  .max(STORAGE_SCORE_MAX, `仓储评分不能高于 ${STORAGE_SCORE_MAX}`);

/**
 * 四维评分的形状。
 *
 * `satisfies Record<DimKey, ...>` 是**编译期**的守卫：往 DIM_KEYS 加了
 * 新维度而忘了往这里补一条，tsc 立刻报错 —— 不用等到运行时才发现
 * 「前端能选、后端读不到」。
 */
const dimsShape = {
  aroma: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
  flavor: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
  waterPath: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
  bodyFeel: z.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
} satisfies Record<DimKey, z.ZodOptional<z.ZodNumber>>;

/**
 * 四维评分：每维 1–10 的整数。
 *
 * `z.strictObject` 拒绝未知键 —— 拼错的键（`water_path`）如果被静默
 * 忽略，用户会以为自己打了分。`.partial()` 让四维可以只填一部分
 * （但综合分只在四维齐全时给，见 cellar.ts 的 overallScore）。
 */
export const dimsSchema = z
  .strictObject(dimsShape)
  .refine((d) => Object.keys(d).length > 0, { message: "四维评分不能是空对象" });

/**
 * 站内上传地址 —— 图片与视频**同一套**规则。
 *
 * 上传通道落地的是**站内相对路径**（`/uploads/tea/xxx.jpg`），所以这里
 * 只收站内路径；为了兼容历史上可能存过的绝对地址，也收「域名确实是
 * puer.im 的绝对地址」。
 *
 * ⚠️ 之前这条**只查协议与路径前缀、不查域名** ——
 * `https://evil.com/uploads/x.mp4` 的路径也是 `/uploads/…`，会被放行。
 * 而这些地址会直接渲染成 `<img src>` / `<video src>`，等于让用户往自己
 * 的记录里塞一个指向别人家的地址（访客的 IP 与 UA 会被送出去）。
 */
const SITE_HOSTS = new Set(["puer.im", "www.puer.im"]);

const siteUploadUrl = z
  .string()
  .max(500)
  .refine(
    (v) => {
      // 站内相对路径。`//evil.com/...` 是协议相对地址，浏览器会当成外站
      // —— 所以开头必须是**单个**斜杠。
      if (v.startsWith("/")) {
        return !v.startsWith("//") && v.startsWith("/uploads/");
      }
      try {
        const u = new URL(v);
        return (
          u.protocol === "https:" &&
          SITE_HOSTS.has(u.hostname) &&
          u.pathname.startsWith("/uploads/")
        );
      } catch {
        return false;
      }
    },
    { message: "必须是站内上传的地址" },
  );

/**
 * 按维度归类的描述词：每个维度挂自己的关键词。
 *
 * `z.strictObject` 拒绝未知维度 —— 拼错的键（`water_path`）如果被静默
 * 忽略，用户会以为自己给「水路」选了词。
 */
const dimTagList = z.array(z.string().min(1).max(40)).max(CELLAR_MAX_DIM_TAGS);
const dimTagsShape = {
  aroma: dimTagList.optional(),
  flavor: dimTagList.optional(),
  waterPath: dimTagList.optional(),
  bodyFeel: dimTagList.optional(),
} satisfies Record<DimKey, z.ZodOptional<z.ZodArray<z.ZodString>>>;
export const dimTagsSchema = z.strictObject(dimTagsShape);

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
 *
 * 没有 `targetUserId`（2026-10-23 站长拍板：取消代录）—— 归属只有录入者
 * 自己，这个接口没有「写进别人名下」的口子。schema 是 strictObject，
 * 传了它直接 400。
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
  stage: z.enum(STAGES).nullable().optional(),
  deltaVsPrev: z.enum(DELTAS).nullable().optional(),
  dims: dimsSchema.nullable().optional(),
  // 描述词：四维各挂各的词，加上通用词，摊平后写在这里（导出格式依赖它）。
  // 上限从 20 提到 100 —— 四个维度各 20 个词再加通用词，20 根本装不下。
  descriptors: z.array(z.string().min(1).max(40)).max(CELLAR_MAX_DESCRIPTORS).optional(),
  // 按维度归类的描述词（与 descriptors 并存：descriptors 是扁平数组，
  // dimTags 保留「这个词属于哪一维」）。
  dimTags: dimTagsSchema.optional(),
  grams: z.number().min(1).max(100).nullable().optional(),
  vessel: z.string().max(40).nullable().optional(),
  note: z.string().max(5000).nullable().optional(),
  // 图片只收站内上传的地址：/api/upload 落地的是公开 URL（UUID 不可猜但
  // 无访问控制），所以「私有的品鉴图片」这件事目前站里做不到。限制成
  // 站内域名至少不会让人往记录里塞任意的第三方地址。
  // ⚠️ 隐私政策里关于图片与视频的措辞要与此处一致（见 privacy/page.tsx）。
  images: z.array(siteUploadUrl).max(CELLAR_MAX_IMAGES).optional(),
  // 视频与图片同一套规则（同一个上传通道、同样的公开 URL 性质）。
  videos: z.array(siteUploadUrl).max(CELLAR_MAX_VIDEOS).optional(),
  // ⚠️ 刻意**不**接受 "shared"：社区带的同意只有一个开关 ——
  // 账号级的 share_aggregate / share_consented_at（见隐私政策 §7）。
  // 记录级的 visibility 是第二条同意通道，将来照它实现就会绕过账号级
  // 同意，把单条记录发出去。列在 DB 里留着给 Phase 3 按账号级同意来判定。
  elapsedSeconds: z.number().int().min(0).max(CELLAR_MAX_ELAPSED_SECONDS).nullable().optional(),
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
