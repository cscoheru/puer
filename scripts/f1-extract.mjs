#!/usr/bin/env node

/**
 * f1-extract.mjs — F1 批量回填（PRD v0.3 §5 Phase 1）。
 *
 * 只处理「站长原始笔记」：authorId = 站长 且 source ≠ 'article'
 * （source='article' 是帖子/AI 文章镜像，PRD 明确不得进入 F1 抽取）。
 *
 * ## 为什么用参数化 SQL 而不是 Prisma 模型 API
 *
 * 这六个字段是后加的。生产镜像里的 Prisma Client 是旧版，不认识它们；
 * 而回填不该逼着整个应用重新构建发布一次。`$executeRawUnsafe` + `$1..$n`
 * 占位符不经过 Client 的字段校验，因此可以在旧镜像里安全跑完。
 * 所有取值一律走占位符绑定，不做字符串拼接。
 *
 * ## 安全闸
 *
 * 1. **评测闸（可选）**：加 --require-gate 时，--apply 前必须有通过的评测报告。
 *    默认不启用 —— 站长选择「先回填、后人工修正」，每个字段带 basis
 *    （stated / inferred / default），来源可追溯。
 * 2. **默认 dry-run**：不加 --apply 只打印将写什么，不碰库。
 * 3. **可回滚**：每次 --apply 写一份 runs/<时间戳>-rollback.json。
 *
 * ## 写库规则
 *
 * - 投茶量/器具原文没写 → 补默认值（7.5g / 盖碗），basis 标 default。
 * - stage 原文没直说 → 按语气推断，basis 标 inferred。
 * - 模型与原文冲突 → 以原文为准并记 corrected；无法从原文找回才丢弃并进复核。
 * - 原文永远不动（只写新增的六个列）。
 *
 * Run:
 *   node --import tsx scripts/f1-extract.mjs                    # dry-run
 *   node --import tsx scripts/f1-extract.mjs --limit 20         # 多看几条
 *   node --import tsx scripts/f1-extract.mjs --apply
 *   node --import tsx scripts/f1-extract.mjs --rollback docs/f1/runs/xxx-rollback.json
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractTastingFields } from "../src/lib/tasting-extract/extract.ts";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(`--${name}`);

const APPLY = has("apply");
const FORCE = has("force");
const REQUIRE_GATE = has("require-gate");
const AUTHOR_UID = Number(arg("author-uid", "1001"));
const LIMIT = Number(arg("limit", "50"));
const SAMPLE = Number(arg("sample", "0"));
const MIN_CONTENT = Number(arg("min-content", "80"));
const GATE_REPORT = resolve(arg("gate-report", "docs/f1/eval-report.json"));
const RUN_DIR = resolve(arg("run-dir", "docs/f1/runs"));
const ROLLBACK_FILE = arg("rollback", "");
/** 只用指定供应商（逗号分隔）。整批重跑时固定一家，避免数据集混模型。 */
const PROVIDER_ONLY = (arg("provider-only", "") || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function checkGate() {
  if (!REQUIRE_GATE) {
    log("⚠️  未启用评测闸（站长选择先回填、后人工修正）。每个字段都带 basis 标记，");
    log("    取值来源可追溯；修正用 scripts/f1-corrections.mjs。");
    return;
  }
  if (!existsSync(GATE_REPORT)) {
    console.error(`ERROR: 找不到评测报告 ${GATE_REPORT}`);
    process.exit(1);
  }
  const r = JSON.parse(readFileSync(GATE_REPORT, "utf8"));
  const acc = (s) => (s.total ? s.correct / s.total : 0);
  const ok = acc(r.stats.stage) >= r.gate && acc(r.stats.delta) >= r.gate;
  if (!ok) {
    console.error(
      `ERROR: 评测未达标 —— stage ${acc(r.stats.stage).toFixed(3)} / delta ${acc(r.stats.delta).toFixed(3)}，要求 ≥ ${r.gate}`,
    );
    process.exit(1);
  }
  log(`评测闸通过：stage ${acc(r.stats.stage).toFixed(3)} / delta ${acc(r.stats.delta).toFixed(3)}`);
}

/** 抽取结果 → 六个列的值（被丢弃的字段保持 null）。 */
function toColumns(result) {
  const f = result.fields;
  const dropped = result.meta?.dropped ?? {};
  return {
    stage: f.stage && !dropped.stage ? f.stage : null,
    deltaVsPrev: f.deltaVsPrev && !dropped.deltaVsPrev ? f.deltaVsPrev : null,
    grams: f.grams != null && !dropped.grams ? f.grams : null,
    vessel: f.vessel && !dropped.vessel ? f.vessel : null,
    descriptors: f.descriptors.length && !dropped.descriptors ? f.descriptors : null,
    extractionMeta: result.meta,
  };
}

const UPDATE_SQL = `
  UPDATE tasting_notes SET
    stage = $2,
    "deltaVsPrev" = $3,
    grams = $4,
    vessel = $5,
    descriptors = $6::jsonb,
    "extractionMeta" = $7::jsonb
  WHERE id = $1
`;

async function rollback(prisma, file) {
  const rows = JSON.parse(readFileSync(resolve(file), "utf8"));
  log(`回滚 ${rows.length} 条…`);
  let n = 0;
  for (const r of rows) {
    const b = r.before ?? {};
    await prisma.$executeRawUnsafe(
      UPDATE_SQL,
      r.id,
      b.stage ?? null,
      b.deltaVsPrev ?? null,
      b.grams ?? null,
      b.vessel ?? null,
      b.descriptors == null ? null : JSON.stringify(b.descriptors),
      b.extractionMeta == null ? null : JSON.stringify(b.extractionMeta),
    );
    n++;
  }
  log(`已回滚 ${n} 条`);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    if (ROLLBACK_FILE) {
      await rollback(prisma, ROLLBACK_FILE);
      return;
    }

    const author = await prisma.user.findFirst({
      where: { uid: AUTHOR_UID },
      select: { id: true, uid: true, username: true, nickname: true },
    });
    if (!author) {
      console.error(`ERROR: uid=${AUTHOR_UID} 不存在`);
      process.exit(1);
    }
    log(`作者：uid=${author.uid} ${author.nickname || author.username}`);

    const selectSql = `
      SELECT id, title, content, "createdAt",
             stage, "deltaVsPrev", grams, vessel, descriptors, "extractionMeta"
      FROM tasting_notes
      WHERE "authorId" = $1
        AND source <> 'article'
        AND ($2::boolean OR "extractionMeta" IS NULL)
      ORDER BY "createdAt" ASC
      LIMIT $3
    `;
    const notes = await prisma.$queryRawUnsafe(
      selectSql,
      author.id,
      FORCE,
      SAMPLE > 0 ? SAMPLE : LIMIT,
    );

    const countRows = await prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS c FROM tasting_notes
        WHERE "authorId" = $1 AND source <> 'article'
          AND ($2::boolean OR "extractionMeta" IS NULL)`,
      author.id,
      FORCE,
    );
    const total = countRows?.[0]?.c ?? 0;
    log(`待处理：${total} 条（已有抽取结果的会被跳过${FORCE ? "，但 --force 已开" : ""}）`);

    if (APPLY) checkGate();
    if (PROVIDER_ONLY.length) log(`限定供应商：${PROVIDER_ONLY.join(", ")}`);

    const usable = notes.filter((n) => (n.content || "").trim().length >= MIN_CONTENT);
    log(`本次取 ${notes.length} 条，其中正文 ≥${MIN_CONTENT} 字：${usable.length} 条`);

    const rollbackRows = [];
    const stats = { ok: 0, failed: 0, review: 0, empty: 0, defaulted: 0 };

    for (const note of usable) {
      const r = await extractTastingFields({
        title: note.title,
        content: note.content,
        providers: PROVIDER_ONLY.length ? PROVIDER_ONLY : undefined,
      });
      if (!r.ok) {
        stats.failed++;
        log(`失败 ${note.id}：${r.reason}`);
        continue;
      }
      const f = r.fields;
      const hasAny = f.stage || f.deltaVsPrev || f.grams != null || f.vessel || f.descriptors.length;
      if (!hasAny) stats.empty++;
      if (r.meta?.needsReview) stats.review++;
      if (r.meta?.basis && (r.meta.basis.grams === "default" || r.meta.basis.vessel === "default")) {
        stats.defaulted++;
      }

      if (!APPLY) {
        log(
          `[dry-run] ${note.id} ${new Date(note.createdAt).toISOString().slice(0, 10)} ` +
            `stage=${f.stage ?? "-"}(${r.meta?.basis.stage ?? "-"}) ` +
            `delta=${f.deltaVsPrev ?? "-"} grams=${f.grams ?? "-"}(${r.meta?.basis.grams ?? "-"}) ` +
            `vessel=${f.vessel ?? "-"}(${r.meta?.basis.vessel ?? "-"}) ` +
            `desc=${f.descriptors.slice(0, 4).join("/") || "-"}` +
            (r.meta?.needsReview ? `  ⚠ ${r.meta.reviewReason}` : ""),
        );
        stats.ok++;
        continue;
      }

      const cols = toColumns(r);
      await prisma.$executeRawUnsafe(
        UPDATE_SQL,
        note.id,
        cols.stage,
        cols.deltaVsPrev,
        cols.grams,
        cols.vessel,
        cols.descriptors == null ? null : JSON.stringify(cols.descriptors),
        cols.extractionMeta == null ? null : JSON.stringify(cols.extractionMeta),
      );
      rollbackRows.push({
        id: note.id,
        before: {
          stage: note.stage,
          deltaVsPrev: note.deltaVsPrev,
          grams: note.grams,
          vessel: note.vessel,
          descriptors: note.descriptors,
          extractionMeta: note.extractionMeta,
        },
      });
      stats.ok++;
      if (stats.ok % 10 === 0) log(`已写 ${stats.ok} 条…`);
    }

    if (APPLY && rollbackRows.length) {
      mkdirSync(RUN_DIR, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const path = resolve(RUN_DIR, `${ts}-rollback.json`);
      writeFileSync(path, JSON.stringify(rollbackRows, null, 2), "utf8");
      log(`回滚文件：${path}`);
    }

    log("──────────── 统计 ────────────");
    log(
      `${APPLY ? "已写入" : "可写入"} ${stats.ok} 条，默认值 ${stats.defaulted}，` +
        `抽取为空 ${stats.empty}，需复核 ${stats.review}，失败 ${stats.failed}`,
    );
    if (!APPLY) log("这是 dry-run。确认无误后加 --apply。");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
