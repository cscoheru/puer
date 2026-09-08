# puer-ai — 普洱茶垂直 AI 项目工作区

战略总纲(权威版):Obsidian vault `硅谷创新/2026-08-15 普洱茶垂直AI战略总纲.md`

## 目录

```
eval/
  questions-v0.md   # 题库(A-E 全部专家审校;裸测记录含四文本模型+GLM-4.6V+qwen3.7-plus 结果)
  images/           # 53 张身份标注图 + manifest(注意 N299-N303 实为大益2005四星孔雀)
  results/          # 各模型裸测原始答案
data/
  sku-schema.md     # SKU 图谱 schema(top5 待确认;402大叶青已成首个样本)
data-engine/        # M1 数据引擎
  tasting-notes-all.json  # 全量 1,686 条品鉴笔记(服务器拉取)
  sft-tasting.jsonl       # A 路:1,970 对文风/摘要指令对(含质量闸门)
  sft-visual-seed.jsonl   # B 路:53 图视觉种子对
  teacher_prelabel.py     # C 路:教师(qwen3.7-plus)预标注,断点续跑
  review-queue.jsonl      # 专家校正队列(已验证 5 张;图池 16,344 张唯一图)
```

## 当前状态(2026-08-15 深夜)

- [x] eval 100 题全部专家审校;四模型文本裸测 + GLM-4.6V/qwen3.7-plus 图片裸测完成(详见 questions-v0.md)
- [x] 战略总纲修订:教师-学生蒸馏路线(vault)
- [x] M1 数据引擎三路就位:A 1,970 对 / B 53 图种子 / C 教师预标注管线(已验证)
- [ ] qwen3.8-max E 类裸测(后台收尾中)
- [ ] C 路批量:待用户指令跑 200-500 张,产出 review-queue 供专家批注
- [ ] M2:Qwen3-VL-8B QLoRA(数据达标后开)
- [ ] tea-draft 审校修改率基线(#7,需 puer-hub 代码改动)
- [ ] top 5 SKU 图谱录入(#8 schema 已定,待用户确认 SKU)

## 技术备忘

- 智谱 Coding Plan token 只能走 Anthropic 兼容端点;必须 `thinking:{type:"disabled"}`,否则思考块耗尽 max_tokens
- 数据资产层永远是第一优先级(参照库>语料>模型快照)
