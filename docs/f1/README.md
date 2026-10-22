# F1 结构化回填 · 运行手册

PRD v0.3 §5 Phase 1。目标：从**站长原始笔记**抽取 `stage` / `delta_vs_prev` /
`descriptors` / `grams` / `vessel`，供 Phase 3 站长线使用。

## 工作方式（2026-10-22 调整）

不再要求逐条标注。模型直接抽取，每条笔记的每个字段都带 **basis**：

| basis | 含义 |
|---|---|
| `stated` | 原文明确写了 |
| `inferred` | 原文没直说，从用词倾向推断（只用于 stage） |
| `default` | 原文没提，补的缺省值（投茶量 7.5g / 盖碗） |
| `manual` | 人工修正过 |

分析/图表可以只取 `stated`，或把 `default` 单独标色 —— 「这饼茶投茶 7.5 克」
和「原文没写，按 7.5 补的」不是一回事。

## 三步

```bash
# 1. 回填（默认 dry-run）
node --import tsx scripts/f1-extract.mjs --limit 20        # 看效果
node --import tsx scripts/f1-extract.mjs --apply           # 写库

# 2. 导出待修正清单（含每条当前值与来源）
node --import tsx scripts/f1-corrections.mjs --export      # → docs/f1/corrections.tsv

# 3. 改完回写（默认 dry-run）
node --import tsx scripts/f1-corrections.mjs --import docs/f1/corrections.tsv
node --import tsx scripts/f1-corrections.mjs --import docs/f1/corrections.tsv --commit
```

## 修正表约定（最后 5 列）

| 填法 | 含义 |
|---|---|
| 留空 | 不改 |
| `-` | 清空该字段 |
| 实值 | 改成这个值 |

- `stage`：上升期 / 巅峰期 / 适饮期 / 走下坡
- `delta`：更好 / 差不多 / 更差
- `grams`：数字（克）
- `vessel`：盖碗 / 紫砂壶 / 壶 / 瓷壶 …
- `descriptors`：逗号分隔，必须是原文用词

最后那列「当前来源」只读，用来快速定位哪些值是 `默认` / `推断` 的。

## 接地校验（防幻觉）

- `grams` 必须能在原文里找到「数字+克」；模型说没有就不去找，避免把
  「茶样共 23 克」这类**总量**误当投茶量。
- `vessel` 取原文出现的器具；原文只写「130cc壶」也记 `壶`，不硬补成盖碗。
- `descriptors` 逐词验证原文出现过，且不含 HTML 片段。
- 模型与原文冲突 → 以原文为准并记 `corrected`；无法找回才丢弃并进复核。

## 模型供应商

按序尝试 MiniMax → DeepSeek → GLM，只有配额/限流类错误才降级。
2026-10-22 实测 MiniMax Token Plan 打满（429/2056），DeepSeek 与 GLM 正常。

## 旧路径（如需评测闸）

```bash
node --import tsx scripts/f1-make-eval-set.mjs      # 抽样出标注底稿
node --import tsx scripts/f1-eval.mjs --out docs/f1/eval-report.json
node --import tsx scripts/f1-extract.mjs --apply --require-gate
```

## 部署顺序

迁移只加列，可先于镜像发布执行（幂等）：

```sql
prisma/migrations/20261022_tasting_extraction/migration.sql
```

回填与修正脚本走参数化 SQL，不依赖镜像里的 Prisma Client 版本，
因此**不需要重新构建镜像**即可运行。
