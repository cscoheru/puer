#!/usr/bin/env node

/**
 * ai-news-draft.mjs — PentAGI 每周检索成果 → 论坛草稿（R29）。
 *
 * 流程：
 *   1. 从 pentagi-vps 拉取 `/opt/pentagi-artifacts/` 下的最新时间戳目录
 *      （B 拉 A，不是 A 推 B：天然幂等、A 无需知道本服务存在、失败只需重跑 B）；
 *   2. 解析成果包里的素材（`raw/02-search-results.md` 市场动态主源、
 *      `raw/03-tavily-answers.md` 品鉴/综述主源）；
 *   3. 质量闸过滤 + 版块路由（茶市风云 / 普洱醇香 / 习茶问道）；
 *   4. 逐条 AI 忠实改写（数字接地校验在改写层，不通过就丢弃该条）；
 *   5. 写库为 `status='draft'`，进 /admin/drafts 等人工审核。**绝不直接发布。**
 *
 * 幂等：主键 `news-draft_<hash(sourceKey)>` 固定，重复跑撞 PK（P2002）即跳过。
 * 所以「每周重跑」不会灌出重复帖，「上周失败这周重试」也不会产生两份。
 *
 * 失败与降级（每一条都记日志，禁止静默降级）：
 *   - 拉不到某个成果目录 → 跳过该目录，继续处理其余；
 *   - 素材不过质量闸 → 记拒绝原因分布，不生成空草稿；
 *   - AI 改写失败 → 跳过该条，不写半成品；
 *   - DB 不可用 / 缺 env → fail-fast，退出码非 0。
 *
 * Environment:
 *   DATABASE_URL                 — PostgreSQL 连接（cron-task.sh 提供）
 *   MINIMAX_API_KEY              — MiniMax key（cron-task.sh 提供）
 *   NEWS_AUTHOR_USERNAME         — 专用资讯账号 username（默认 puer-news）
 *   PENTAGI_ARTIFACT_HOST        — pentagi-vps SSH 目标（默认 pentagi-vps）
 *   PENTAGI_ARTIFACT_DIR         — 成果目录（默认 /opt/pentagi-artifacts）
 *   NEWS_ARTIFACT_LOCAL_DIR      — 本地落地目录（默认 /opt/puer-hub/rag-data/news-artifacts）
 *   NEWS_ARTIFACT_MAX_AGE_DAYS   — 只处理这个天数内的新成果（默认 21）
 *   NEWS_DRAFT_LIMIT             — 单次最多生成多少草稿（默认 0 = 不限）
 *
 * Run:
 *   node --import tsx scripts/ai-news-draft.mjs --dry-run   # 只统计不写库（默认）
 *   node --import tsx scripts/ai-news-draft.mjs --apply      # 写库
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { PrismaClient } from "../src/generated/prisma/client.js";
import {
  parseTavilyAnswers,
  parseSearchResults,
  routeBoard,
  isPublishable,
  draftId,
} from "../src/lib/news-draft/plan.ts";
import { rewriteNews } from "../src/lib/news-draft/rewrite.ts";
// 注意：这是 .mjs，Node 不做类型剥离——不能写 `import { type X }`（语法错）。
// 纯类型的东西用 JSDoc 标注即可。
import {
  deriveFeedbackPolicy,
  evaluateMaterial,
  FEEDBACK_WINDOW_DAYS,
  parseFeedbackCategory,
  normalizeFeedbackReason,
} from "../src/lib/news-draft/feedback-policy.ts";

// ── argv / env ──────────────────────────────────────────────────────

const APPLY = process.argv.includes("--apply");
const DRY_RUN = !APPLY;

const AUTHOR_USERNAME = process.env.NEWS_AUTHOR_USERNAME || "puer-news";
const ARTIFACT_HOST = process.env.PENTAGI_ARTIFACT_HOST || "pentagi-vps";
const ARTIFACT_DIR = process.env.PENTAGI_ARTIFACT_DIR || "/opt/pentagi-artifacts";
const LOCAL_DIR = process.env.NEWS_ARTIFACT_LOCAL_DIR || "/opt/puer-hub/rag-data/news-artifacts";
const MAX_AGE_DAYS = Number(process.env.NEWS_ARTIFACT_MAX_AGE_DAYS || 21);
const LIMIT = Number(process.env.NEWS_DRAFT_LIMIT || 0);

/**
 * 退回反馈 digest 在 pentagi-vps 上的落点。
 *
 * 检索侧（run.sh）每次建 flow 前会把这个文件拼进 prompt，所以它必须是
 * **整个文件的内容**（不是追加）——多轮反馈要能覆盖上一轮，否则旧规则会
 * 一直生效。
 */
const REMOTE_FEEDBACK_DIR = process.env.PENTAGI_FEEDBACK_DIR || "/opt/pentagi/ops/weekly-puer-tea";
const REMOTE_FEEDBACK_FILE = `${REMOTE_FEEDBACK_DIR}/feedback-digest.md`;

// 远端路径会拼进 `ssh host "mkdir -p … && cat > …"` 的命令串（远端由 shell 解释），
// 所以必须先卡死字符集——否则一个带 `;` 或 `$(…)` 的 env 值就等于在远端执行命令。
// 还要挡 `..` 穿越：只允许落在 /opt/pentagi/ 之下。
if (
  !/^[A-Za-z0-9._\/-]+$/.test(REMOTE_FEEDBACK_DIR) ||
  REMOTE_FEEDBACK_DIR.split("/").includes("..") ||
  !REMOTE_FEEDBACK_DIR.startsWith("/opt/pentagi/")
) {
  console.error(
    `ERROR: PENTAGI_FEEDBACK_DIR 非法（只允许 /opt/pentagi/ 下的字母数字与 . _ / -，且不得含 ..）：${REMOTE_FEEDBACK_DIR}`,
  );
  process.exit(1);
}

// ssh 主机名同样不能想当然：`-` 开头会被 ssh 当成选项（如 -oProxyCommand=…），
// 那就等于把 env 值变成了命令执行。主机名必须是普通的主机/别名形态。
if (!/^[A-Za-z0-9._-]+$/.test(ARTIFACT_HOST) || ARTIFACT_HOST.startsWith("-")) {
  console.error(`ERROR: PENTAGI_ARTIFACT_HOST 非法（主机名形态）：${ARTIFACT_HOST}`);
  process.exit(1);
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`ERROR: missing required env ${name}. Set it before running.`);
    process.exit(1);
  }
  return v;
}

function makePrisma() {
  const url = required("DATABASE_URL");
  return new PrismaClient({ datasources: { db: { url } } });
}

// ── 成果包拉取 ──────────────────────────────────────────────────────

/**
 * 列出 pentagi-vps 上最新的成果目录名。
 *
 * 只认「符合时间戳目录名」的那些：`YYYY-MM-DDTHH-MM-SSZ__<flow>-<topic>`。
 * 目录名本身就是产出时间，比 mtime 可靠（rsync 保留 mtime，但人工改动会污染）。
 *
 * 拉取本身在 `pullArtifactDir`（rsync，退化到 scp）。
 */
function listRemoteArtifactDirs() {
  let listing;
  try {
    listing = execFileSync(
      "ssh",
      [ARTIFACT_HOST, `ls -1 ${ARTIFACT_DIR} 2>/dev/null || true`],
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch (e) {
    log(`ERROR: 无法列出 ${ARTIFACT_HOST}:${ARTIFACT_DIR} — ${e.message.split("\n")[0]}`);
    return [];
  }

  const dirs = listing
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__/.test(s));

  if (dirs.length === 0) {
    log(`WARN: ${ARTIFACT_HOST}:${ARTIFACT_DIR} 下没有符合命名的时间戳目录`);
    return [];
  }

  // 只取最近的若干个（按目录名里的时间戳倒序），避免一次拉几年的历史。
  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 3600 * 1000;
  const fresh = dirs
    .filter((d) => {
      // 目录名时间戳是 `YYYY-MM-DDTHH-MM-SSZ`（冒号在文件名里不安全，用了 -），
      // 转成可解析的 ISO 串 `YYYY-MM-DDTHH:MM:SSZ`。只替换时间部分的两个连字符，
      // 不能碰日期里的连字符。
      const ts = d.slice(0, 20).replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, "T$1:$2:$3Z");
      const t = Date.parse(ts);
      return Number.isFinite(t) ? t >= cutoff : false;
    })
    .sort()
    .reverse();

  log(`远端成果目录 ${dirs.length} 个，其中 ${fresh.length} 个在 ${MAX_AGE_DAYS} 天内`);
  return fresh;
}

/**
 * 用 rsync 拉取一个成果目录（比 tar-over-ssh 稳，且支持断点续传）。
 *
 * 服务器上没装 rsync 时退回 scp -r。单目录失败不阻塞其余——一个成果包坏了
 * 不该让整批停摆。
 */
function pullArtifactDir(dir) {
  const local = join(LOCAL_DIR, dir);
  try {
    execFileSync(
      "rsync",
      ["-az", "--timeout=120", `${ARTIFACT_HOST}:${ARTIFACT_DIR}/${dir}/`, `${local}/`],
      { encoding: "utf8", timeout: 300_000 },
    );
    return true;
  } catch {
    try {
      execFileSync(
        "scp",
        ["-r", `${ARTIFACT_HOST}:${ARTIFACT_DIR}/${dir}`, LOCAL_DIR],
        { encoding: "utf8", timeout: 300_000 },
      );
      return true;
    } catch (e) {
      log(`WARN: 拉取 ${dir} 失败: ${e.message.split("\n")[0]}`);
      return false;
    }
  }
}

// ── 品牌与反馈（规则来源）────────────────────────────────────────────

/**
 * 库中该排除的「非品牌」值。
 *
 * `teas.brand` 是自由文本，历史导入时留了一批占位值（`未知` 619 条、
 * `即将作废` 25 条）。把它们当品牌会让「命中已知品牌」这条规则形同虚设——
 * 任何一条垃圾素材都能命中 `未知`。
 */
const NON_BRAND_VALUES = new Set(["未知", "即将作废", "老茶", "古树", "其他茶类", ""]);

/**
 * 从 `teas` 表聚合品牌统计与经典茶品名。
 *
 * 品牌「知名度」的最好代理就是**本站库里的存量**——编辑部维护过的品牌比
 * 外部榜单更贴合本站内容（用户明确要「大益等知名厂商的经典普洱（库中已有的）」）。
 */
async function loadBrandContext(prisma) {
  const rows = await prisma.tea.findMany({
    where: { deletedAt: null },
    select: { brand: true, name: true, isClassic: true },
  });

  const byBrand = new Map();
  const classicTeas = new Set();
  for (const t of rows) {
    const brand = (t.brand || "").trim();
    if (!NON_BRAND_VALUES.has(brand)) {
      const cur = byBrand.get(brand) || { brand, count: 0, classicCount: 0 };
      cur.count += 1;
      if (t.isClassic) cur.classicCount += 1;
      byBrand.set(brand, cur);
    }
    if (t.isClassic && t.name) classicTeas.add(t.name.trim());
  }

  const brands = [...byBrand.values()].sort((a, b) => b.count - a.count);
  return { brands, classicTeas: [...classicTeas] };
}

/**
 * 读取近期人工退回反馈，并推导下一轮的筛选规则。
 *
 * 只看 `status="rejected"` 且带 `reviewFeedback` 的行——被退回的稿子正是
 * 「什么信息不合适」的第一手样本。规则推导是纯函数（`deriveFeedbackPolicy`），
 * 这里只负责取数。
 */
async function loadFeedback(prisma) {
  const rows = await prisma.article.findMany({
    // 刻意**不**用 `reviewFeedback: { not: null }` 过滤：Prisma 对 JSON 列的
    // `null` 指的是「JSON 值是 null」而非「SQL 列为 NULL」，语义不同很容易
    // 匹配错。这里只按 status 取行，再在 JS 里校验反馈内容是否可用。
    where: { status: "rejected" },
    select: { reviewFeedback: true, updatedAt: true },
    orderBy: { updatedAt: "desc" },
    take: 50,
  });

  const entries = [];
  for (const row of rows) {
    const fb = row.reviewFeedback;
    if (!fb || typeof fb !== "object") continue;
    // 读取侧**重新校验**：写入口是 admin-only 且有白名单，但库里这列将来可能
    // 被别的写入方填上任何东西（迁移、脚本、直接改库）。而这些文本会进
    // prompt（本地改写 + 远端检索），未校验的库值就是注入源。
    const category = parseFeedbackCategory(fb.category);
    if (!category) continue;
    const reason = normalizeFeedbackReason(fb.reason);
    if (!reason) continue;
    entries.push({
      category,
      reason,
      by: typeof fb.by === "string" ? fb.by : undefined,
      at: typeof fb.at === "string" ? fb.at : row.updatedAt?.toISOString(),
    });
  }
  return entries;
}

/**
 * 把退回反馈汇总成一份「给检索侧的选题要求」。
 *
 * 这一步是反馈闭环的**跨机半环**：puer-hub 持有反馈，pentagi-vps 负责检索，
 * 而检索才是「选什么题」发生的地方。B→A 单向推一份 digest（不走 API、不改
 * pentagi 的库），A 在建 flow 时把它拼进 prompt。
 *
 * 没有这一环，退回只能影响**改写**（写出来像不像），影响不了**选题**
 * （写的是什么）——而用户抱怨的「还在提春茶」正是选题问题。
 */
function buildFeedbackDigest(entries, policy) {
  const lines = [
    "# 编辑退回反馈（自动生成，请勿手工编辑）",
    "",
    `生成时间：${new Date().toISOString()}`,
    `统计窗口：最近 ${FEEDBACK_WINDOW_DAYS} 天内，共 ${entries.length} 条退回`,
    "",
  ];

  if (entries.length === 0) {
    lines.push("近期没有退回记录，按既有规则检索。", "");
    return lines.join("\n");
  }

  const counts = {};
  for (const e of entries) counts[e.category] = (counts[e.category] || 0) + 1;
  lines.push("## 分类分布");
  for (const [cat, n] of Object.entries(counts)) {
    lines.push(`- ${cat}：${n} 条`);
  }
  lines.push("", "## 下一轮检索必须遵守");

  // 分类 → 检索侧的具体要求。这里写的是**检索侧能执行的动作**
  // （不检索什么、优先检索什么），不是泛泛的「注意时效」。
  if (counts.stale) {
    lines.push(
      "- **时效优先**：只取最近 7 天的内容。当前季节不适用的旧题材" +
        "（例如非春茶季的春茶行情、旧批次价格）不要检索，也不要写进报告。",
    );
  }
  if (counts.unknown_brand) {
    lines.push(
      "- **只取知名厂商**：优先大益、下关沱茶、陈升号、澜沧古茶、中茶、今大福、" +
        "福今、昌泰等主流品牌；小厂/杂牌/贴牌茶品不要作为素材。",
    );
  }
  if (counts.vague) {
    lines.push(
      "- **必须具体**：每条资讯都要带具体价格、批次号、产区或年份；" +
        "只有“市场回暖”“品质提升”这类空话的条目不要收录。",
    );
  }
  if (counts.inaccurate) {
    lines.push(
      "- **核对数字**：价格与批次号必须与原文逐字一致；" +
        "若同一数字在不同来源里对不上，两边都写出来并注明来源，不要取其一。",
    );
  }
  lines.push("");

  lines.push("## 最近退回的具体原因（负例，检索时避免重蹈）");
  for (const e of entries.slice(0, 10)) {
    lines.push(`- [${e.category}] ${e.reason}`);
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * 把 digest 推到 pentagi-vps，供下一次检索的 run.sh 拼进 prompt。
 *
 * 推失败**不阻塞**本轮生成：反馈同步是增强项，不是本轮产稿的前置条件。
 * 但必须留下日志——静默失败会让「反馈没生效」变成查不出原因的问题。
 */
function pushFeedbackDigest(digest) {
  try {
    execFileSync(
      "ssh",
      [
        ARTIFACT_HOST,
        `mkdir -p ${REMOTE_FEEDBACK_DIR} && cat > ${REMOTE_FEEDBACK_FILE}`,
      ],
      { input: digest, encoding: "utf8", timeout: 60_000 },
    );
    log(`退回反馈 digest 已推送到 ${ARTIFACT_HOST}:${REMOTE_FEEDBACK_FILE}`);
    return true;
  } catch (e) {
    log(`WARN: 推送退回反馈 digest 失败（不影响本轮产稿）: ${e.message.split("\n")[0]}`);
    return false;
  }
}

// ── 素材抽取 ────────────────────────────────────────────────────────

/** 从一个成果目录里抽出全部素材。 */
function extractFromDir(dir) {
  const base = join(LOCAL_DIR, dir, "raw");
  const materials = [];
  const searchResults = join(base, "02-search-results.md");
  const tavilyAnswers = join(base, "03-tavily-answers.md");
  if (existsSync(searchResults)) {
    try {
      materials.push(...parseSearchResults(readFileSync(searchResults, "utf8")));
    } catch (e) {
      log(`WARN: 解析 ${dir}/raw/02-search-results.md 失败: ${e.message.split("\n")[0]}`);
    }
  }
  if (existsSync(tavilyAnswers)) {
    try {
      materials.push(...parseTavilyAnswers(readFileSync(tavilyAnswers, "utf8")));
    } catch (e) {
      log(`WARN: 解析 ${dir}/raw/03-tavily-answers.md 失败: ${e.message.split("\n")[0]}`);
    }
  }
  return materials;
}

/** 本地已有的成果目录（用于「上次的也再处理一次」的场景）。 */
function listLocalDirs() {
  if (!existsSync(LOCAL_DIR)) return [];
  return readdirSync(LOCAL_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z__/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
}

// ── 主流程 ──────────────────────────────────────────────────────────

async function main() {
  // Fail fast on missing env before touching the network or the DB.
  required("DATABASE_URL");
  required("MINIMAX_API_KEY");
  const prisma = makePrisma();

  try {
    // 1. 取成果目录：先拉新的，再把本地的也列上（拉取失败的目录若本地已有旧版
    //    也能继续处理，不让一次网络抖动毁掉整批）。
    mkdirSync(LOCAL_DIR, { recursive: true });
    for (const dir of listRemoteArtifactDirs()) {
      if (existsSync(join(LOCAL_DIR, dir, "raw"))) {
        log(`跳过已存在的成果目录 ${dir}`);
        continue;
      }
      pullArtifactDir(dir);
    }
    const dirs = listLocalDirs();
    if (dirs.length === 0) {
      log("WARN: 没有可用的成果目录，本轮不生成任何草稿");
      return;
    }
    log(`处理 ${dirs.length} 个成果目录: ${dirs.join(", ")}`);

    // 2. 抽素材 + 质量闸。
    const seenKeys = new Set();
    const rejected = {};
    const candidates = [];
    for (const dir of dirs) {
      for (const m of extractFromDir(dir)) {
        if (seenKeys.has(m.sourceKey)) continue;
        seenKeys.add(m.sourceKey);
        const verdict = isPublishable(m);
        if (!verdict.ok) {
          rejected[verdict.reason] = (rejected[verdict.reason] || 0) + 1;
          continue;
        }
        candidates.push(m);
      }
    }
    log(`抽取素材 ${seenKeys.size} 条，过闸 ${candidates.length} 条`);
    log(`拒绝原因分布: ${JSON.stringify(rejected)}`);

    // 2b. 人工反馈 → 筛选规则（时效/跨季/品牌/具象度）。
    //
    // 这一段是「退回」闭环的落点：管理员在草稿箱退回时写下的分类，
    // 在这里变成确定的闸门。规则本身由纯函数推导（可单测），
    // 本脚本只负责取数与接线。
    const feedbackEntries = await loadFeedback(prisma);
    const policy = deriveFeedbackPolicy(feedbackEntries);
    log(
      `退回反馈 ${feedbackEntries.length} 条 → 规则: ` +
        `时效≤${policy.maxAgeDays}天 跨季春茶${policy.rejectCrossSeason ? "拦截" : "放行"} ` +
        `要求已知品牌${policy.requireKnownBrand ? "是" : "否"} ` +
        `具象信号≥${policy.minConcreteSignals}类 严格接地${policy.stricterGrounding ? "开" : "关"}`,
    );

    const { brands, classicTeas } = await loadBrandContext(prisma);
    log(`库中品牌 ${brands.length} 个（Top5: ${brands.slice(0, 5).map((b) => b.brand).join("、")}），经典茶品 ${classicTeas.length} 个`);

    // 把反馈推给检索侧，让「选题」也吃到反馈（改写侧只能管表达，选题在检索侧）。
    pushFeedbackDigest(buildFeedbackDigest(feedbackEntries, policy));

    const policyRejected = {};
    const scored = [];
    for (const m of candidates) {
      const evaluation = evaluateMaterial(m, {
        now: Date.now(),
        policy,
        brands,
        classicTeas,
      });
      if (!evaluation.ok) {
        // 理由归一化到「类别」粒度，便于看分布（原因里带具体日期/天数，
        // 直接当 key 会碎成几十个桶）。
        const key = evaluation.reason.split("（")[0];
        policyRejected[key] = (policyRejected[key] || 0) + 1;
        continue;
      }
      scored.push({ material: m, score: evaluation.score, evaluation });
    }
    if (Object.keys(policyRejected).length > 0) {
      log(`规则闸拒绝分布: ${JSON.stringify(policyRejected)}`);
    }
    // 同等合格的候选按分数降序：分数高 = 更新 + 更可能是知名厂商的经典茶。
    // 用户要「尽量选择大益等知名厂商的经典普洱」，在这个环节直接落实。
    scored.sort((a, b) => b.score - a.score);
    log(`规则闸通过 ${scored.length} 条（Top5 分数: ${scored.slice(0, 5).map((s) => s.score).join(",")}）`);
    candidates.length = 0;
    candidates.push(...scored.map((s) => s.material));
    // 素材 → 命中的品牌与经典茶名：只把**这条素材真正提到**的喂给改写层。
    // 整库 195 个经典名 / 几百个品牌名全塞进 prompt 是噪音（还挤占 token），
    // 而且品牌名是会员可写的自由文本——全量传入等于给 prompt 注入开门。
    const matchedClassics = new Map(
      scored.map((s) => [s.material.sourceKey, s.evaluation.classicTeas]),
    );
    const matchedBrands = new Map(
      scored.map((s) => [s.material.sourceKey, s.evaluation.brands]),
    );

    // 3. 版块路由统计。
    const byRoute = { trade: 0, puer: 0, knowledge: 0 };
    for (const m of candidates) byRoute[routeBoard(m)]++;
    log(`版块分布: ${JSON.stringify(byRoute)}`);

    if (LIMIT > 0 && candidates.length > LIMIT) {
      log(`按 NEWS_DRAFT_LIMIT=${LIMIT} 截断`);
      candidates.length = LIMIT;
    }

    // 4. 查作者与版块（都按名字查，不硬编码 id——生产库有 7 个版块，
    //    `scripts/lib/post-helpers.mjs` 里那张硬编码表只有 6 个且已过时）。
    const author = await prisma.user.findUnique({
      where: { username: AUTHOR_USERNAME },
      select: { id: true, username: true, nickname: true, role: true, level: true },
    });
    if (!author) {
      log(`ERROR: 资讯账号 ${AUTHOR_USERNAME} 不存在，无法署名。先建号再跑本脚本。`);
      process.exitCode = 1;
      return;
    }
    log(`署名账号: ${author.username} (${author.nickname || "无昵称"}) role=${author.role}`);

    const boards = await prisma.board.findMany({
      select: { id: true, slug: true, name: true },
    });
    const boardBySlug = new Map(boards.map((b) => [b.slug, b]));
    for (const slug of ["trade", "puer", "knowledge"]) {
      if (!boardBySlug.has(slug)) {
        log(`ERROR: 版块 ${slug} 不存在，无法路由。`);
        process.exitCode = 1;
        return;
      }
    }

    // 5. 逐条改写 → 写库。
    let created = 0;
    let skippedExisting = 0;
    let rewriteFailed = 0;
    const failures = [];
    // 429 配额熔断：账户额度耗尽时对每条素材再打 2 发必败请求纯属浪费，
    // 且会拖长整批运行时间。命中一次 429 就停掉后面的模型调用（已抽取/已
    // 过闸的统计照常打印，方便恢复后只补改写）。
    let quotaExhausted = false;

    for (const m of candidates) {
      if (quotaExhausted) break;
      const slug = routeBoard(m);
      const board = boardBySlug.get(slug);
      const id = draftId(m.sourceKey);

      // 已存在就跳过（幂等）。这里查一次，避免白跑一次模型调用。
      const existing = await prisma.article.findUnique({
        where: { id },
        select: { id: true, status: true },
      });
      if (existing) {
        skippedExisting++;
        continue;
      }

      const rewritten = await rewriteNews({
        material: m,
        // 品牌白名单与经典茶名进 prompt：让模型用**站内规范名**写具体茶品。
        // 只给这条素材**命中的**品牌/经典茶：品牌名是会员可写的自由文本，
        // 把全库名单塞进 prompt 等于开一条 prompt 注入的路（见 rewrite.ts
        // 的 knownBrands 注释）。「优先知名厂商」由筛选排序落实，不靠名单。
        knownBrands: matchedBrands.get(m.sourceKey) ?? [],
        // 只给这条素材真正命中的经典茶名（整库名单是噪音）。
        classicTeas: matchedClassics.get(m.sourceKey) ?? [],
        // 退回负例：编辑说过的「不合适」直接进提示词。
        rejectReasons: feedbackEntries.map((e) => e.reason),
        // 「信息不实」反馈占比高时，严格接地（关键价格不得消失）。
        stricterGrounding: policy.stricterGrounding,
      });
      if (!rewritten.ok) {
        rewriteFailed++;
        failures.push({ title: m.title.slice(0, 30), reason: rewritten.reason });
        log(`改写失败，跳过: ${m.title.slice(0, 30)} — ${rewritten.reason}`);
        if (/\b429\b|rate_limit|用量上限|额度|积分/.test(rewritten.reason)) {
          quotaExhausted = true;
          log("检测到配额/限流错误，熔断本轮后续模型调用（已抽取的素材保留，恢复后重跑即可）");
        }
        continue;
      }

      if (DRY_RUN) {
        log(`[dry-run] 将创建 ${id} → ${board.name} | ${rewritten.title}`);
        created++;
        continue;
      }

      try {
        await prisma.article.create({
          data: {
            id,
            type: "discussion",
            title: rewritten.title,
            content: rewritten.content,
            summary: rewritten.summary,
            boardId: board.id,
            authorId: author.id,
            // 资讯帖不关联茶品：关联了会在发布时镜像出一条品鉴笔记，
            // 而资讯稿没有对应的品鉴事实。
            teaId: null,
            tags: ["资讯", board.name],
            images: [],
            visibility: "public",
            status: "draft",
            // 不写 aiOriginal：资讯稿一次成型，没有「AI 原版 vs 人工改后」的
            // 双轨需求；写了反而会让后台的「⚠ 待重写」徽章逻辑误判。
          },
        });
        created++;
        log(`已创建草稿 ${id} → ${board.name} | ${rewritten.title}`);
      } catch (e) {
        // P2002 = 主键冲突 = 并发或上一轮已创建，按幂等跳过。
        if (e?.code === "P2002") {
          skippedExisting++;
          continue;
        }
        rewriteFailed++;
        failures.push({ title: m.title.slice(0, 30), reason: `db: ${e.message.split("\n")[0]}` });
        log(`写库失败，跳过: ${m.title.slice(0, 30)} — ${e.message.split("\n")[0]}`);
      }
    }

    log(
      `本批统计: 抽取 ${seenKeys.size} / 过闸 ${candidates.length} / ` +
        `新建 ${created} / 已存在跳过 ${skippedExisting} / 改写失败 ${rewriteFailed}`,
    );
    if (failures.length > 0) {
      log(`失败明细: ${JSON.stringify(failures.slice(0, 10))}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  process.exit(1);
});
