/**
 * 行情快照（F5）的入参校验。
 *
 * 与 `src/lib/cellar-schemas.ts` 同一套思路：**zod 挡一层，DB 的 CHECK 再挡
 * 一层**，两层都挡住才算数（应用层会漂，约束不会）。
 */
import { z } from "zod";

/** 单价上限（元）—— 防止手滑多打一个 0。 */
export const PRICE_MAX = 10_000_000;

/** 录一条价格快照。 */
export const createPriceSnapshotSchema = z
  .strictObject({
    /** 哪款茶。 */
    teaId: z.string().min(1, "请选择茶品").max(64),
    /** 快照日期（YYYY-MM-DD）—— 可以补录过去。 */
    snapshotDate: z.iso.date("请填日期（YYYY-MM-DD）"),
    /** 区间下限（元）。 */
    low: z.number().int().min(0, "价格不能是负数").max(PRICE_MAX),
    /** 区间上限（元）。 */
    high: z.number().int().min(0, "价格不能是负数").max(PRICE_MAX),
    /** 币种，默认人民币。 */
    currency: z.string().max(8).optional(),
    /** 来源 —— 必填（PRD F5：「必须填来源与日期」）。 */
    sourceLabel: z
      .string()
      .min(1, "请填来源（比如「东和」「茶友私询」）")
      .max(60),
    /** 备注。 */
    note: z.string().max(300).optional(),
  })
  .refine((d) => d.high >= d.low, {
    message: "区间上限不能低于下限",
    path: ["high"],
  });
