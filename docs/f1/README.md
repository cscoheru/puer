# F1 结构化回填 · 运行手册

PRD v0.3 §5 Phase 1。目标：从**站长原始笔记**抽取 `stage` / `delta_vs_prev` /
`descriptors` / `grams` / `vessel`，供 Phase 3 站长线使用。

## 三步

```bash
# 1. 抽样出标注底稿（按年份分层，默认 100 条）
node --import tsx scripts/f1-make-eval-set.mjs
#    → docs/f1/eval-set.tsv   用 Excel/Numbers 打开，只填最后 5 列

# 2. 评测（stage / delta 均 ≥85% 才通过）
node --import tsx scripts/f1-eval.mjs --out docs/f1/eval-report.json

# 3. 回填（先 dry-run 看样例，再加 --apply）
node --import tsx scripts/f1-extract.mjs --limit 20 --sample 5
node --import tsx scripts/f1-extract.mjs --apply
```

## 标注约定（TSV 最后 5 列）

| 填法 | 含义 |
|---|---|
| 留空 | 还没标 —— 评测时跳过该字段 |
| `-` | 原文**未提及** —— 应抽成 null；模型抽出任何值都算误报 |
| 实值 | 期望值 |

- `stage`：上升期 / 巅峰期 / 适饮期 / 走下坡
- `delta`：更好 / 差不多 / 更差（首次品鉴或没提上次 → `-`）
- `grams`：数字（克）
- `vessel`：盖碗 / 紫砂壶 / 瓷壶 / 玻璃杯 …（词表见 `src/lib/tasting-extract/vocab.ts`）
- `descriptors`：逗号分隔，**必须是原文用词**

## 三道安全闸

1. **评测闸**：`--apply` 前强制读取 `docs/f1/eval-report.json`，stage 与 delta
   任一低于 85% 直接退出。确实要跳过需显式 `--force-ungated`（日志留痕）。
2. **接地校验**：`grams` / `vessel` / `descriptors` 写库前逐个验证原文确实出现过；
   模型编的值被丢弃并记入 `extractionMeta.dropped`，模型说错的记入 `corrected`。
3. **可回滚**：每次 `--apply` 写 `docs/f1/runs/<时间戳>-rollback.json`，
   `node --import tsx scripts/f1-extract.mjs --rollback <文件>` 整体还原。

原文列永不修改，只 UPDATE 新增的六个列；已有 `extractionMeta` 的笔记默认跳过（`--force` 重抽）。

## 词表可改，但要重评

`src/lib/tasting-extract/vocab.ts` 是 stage / delta / 器具的唯一真源。
改动词表后必须重跑评测，否则旧的一致率结论失效。

## 部署顺序

```sql
-- 先执行迁移（只加列，幂等），再部署带新代码的镜像
prisma/migrations/20261022_tasting_extraction/migration.sql
```

在容器内跑脚本：

```bash
docker cp scripts/f1-make-eval-set.mjs  puer-hub-app:/app/scripts/
docker cp scripts/f1-eval.mjs           puer-hub-app:/app/scripts/
docker cp scripts/f1-extract.mjs        puer-hub-app:/app/scripts/
docker exec puer-hub-app ./node_modules/.bin/tsx scripts/f1-make-eval-set.mjs
```
