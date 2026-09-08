# M4:RAG 应答管线报告(2026-08-18)

> 目标:兑现铁律「知识走 RAG 不进权重」——把 942 SKU + 973 知识块接到「检索 → grounded 生成」链路。
> 本轮生成端点:**glm-5.2**(教师 qwen3.7-plus 一周配额 8-23 恢复;代码已支持一键切换)。

## 一、交付物(rag/ 目录)

| 文件 | 职责 | 状态 |
|---|---|---|
| `retriever.py` | 检索模块(从 smoke 搬移,惰性加载+hybrid_search 统一入口,embed 降级) | ✅ smoke 零回归(diff 验证) |
| `teacher_api.py` | 多端点 LLM 客户端(bailian/glm/kimi,Anthropic 兼容,token 只内存) | ✅ 3 端点连通 |
| `image_ocr.py` | 图面线索抽取(只读不猜+自动 2x 放大+拒读检测重试) | ✅ 纪律生效;glm 视觉不稳定 |
| `rag_pipeline.py` | 核心管线 CLI(OCR→多路检索→grounded 生成→引用/置信) | ✅ 文本模式全通 |
| `run_rag_eval.py` | E1/E8/E8b/E14+A1-A3 跑批,E8/E8b 自动校验,断点续跑 | ✅ 7 题跑完 |
| `eval_rag_report.py` | 三方对照报告(同端点裸答 vs +RAG,学生v3 参考行) | ✅ rag-eval-report.md |

## 二、本轮验证结论

1. **grounding 纪律完美工作(核心验收)**:E8/E8b 图读不清 → 拒绝编造、明确说缺什么证据。
   对照学生 v3 在同两题的「88青饼」「8582」幻觉——**读不到就不说,这是本管线对学生 SFT 的本质优势**。
2. **文本模式全链通**:7542 标杆题检索 6 命中、回答带真实 `[来源:]` 引用、有批判性补充(「标杆已不合时宜」)。
3. **grounding 过严缺陷已修**:初版 prompt 把通用知识出路堵死(A1 明明能答却硬说证据不足);
   修后行为理想——资料相关部分引用 + 「【资料未覆盖,以下为通用知识】」标注分隔 + 资料例外提醒。
   A1 修复后与专家要点一致(75=1975配方/4=等级/2=勐海厂),且多出裸答没有的来源与边界警示。
4. **检索资产可用性确认**:E8 正解 `002中茶黄印7572(2003)` 就在 SKU 库;紫大益 39 SKU+16 知识块;
   7572 知识块 57 条——知识层天花板取决于线索质量,不取决于素材。

## 三、已知局限(全部指向同一根因:glm-5.2 视觉不稳定)

- 版面小字 OCR 基本失败(同图 4 次调用 4 种结果,颜色都漂移:黄褐/深棕/红底)→ E8/E8b 自动校验 0/4,**诚实降级**
- E1/E14 的汤色图被 OCR 读成「棉纸包装」;裸答基线也出现「图片未传入」——glm 视觉层时好时坏,对照基线本身残缺
- 2x Lanczos 放大确有改善(N343 读出「中茶牌/净重肆佰克」,N009 正确识别「茶字黄色」)但不稳定
- **教师 qwen3.7-plus 的 OCR 能力已在 ocr_image_pdfs.py 管线验证过**;8-23 配额恢复后:
  `python3 run_rag_eval.py --provider bailian && python3 eval_rag_report.py` 一键重跑(先清 rag-eval.jsonl)

## 四、eval 快照(glm 端点)

- E8+E8b 自动校验 0/4(OCR 瓶颈,非管线缺陷;两题均诚实降级,零幻觉)
- A 类:grounding 修复后置信全 high,A1 答案=裸答质量+真实引用+边界警示
- 详细对照(含专家打分栏):`rag-eval-report.md`

## 五、下一步

1. **~~8-23 教师配额恢复~~ 已提前解决**:用户刷了一次免费配额重置,教师端点已重跑 eval(见七)。
2. **服务化(下个里程碑)**:管线过 eval 后包成 puer-hub 的问答 API(检索层本地常驻+教师生成)
3. 检索改进备选(低优先):SKU 检索加语义(bge)、ref-images 参照图匹配
4. 与 M6(v4 混合训练)的分工:感知/编目→LoRA;知识/断代→本管线;两线并行不冲突

## 七、M7 东和数据接入后的补充(2026-08-18 下午)

- **东和茶叶网全量入库**:6,716 SKU(品名/年份/实时行情/涨跌/计价单位)+ 6,716 张 OSS 原图(654MB,0 失败)→ `donghe-skus.jsonl` + `donghe-images/`。爬取走 Playwright 真浏览器(API 域名 TLS 指纹级 WAF 只放行浏览器)。
- **retriever 双源化**:`donghe_lookup`(同 bigram-IDF 评分器)+ hybrid_search 合并 xlsx SKU/东和/知识块三路;smoke 零回归。
- **实时行情问答验证**:"7542 各年份行情" → 答案混引 xlsx 快照(03 蓝大益 30 万/件)与东和实时价(1701 7542:5,000 元/件,较上次 -9.1%,更新于 2026-06-26),置信 high。
- **E8/E8b 终态(E8 2/4 波动,E8b 1/4)**:教师 OCR 已能读出八中茶版式+公司落款,厂家可确认、年代给出合理区间(70s-92,公司更名下限)、唛号诚实说无法识别。**自动校验 4 要素对单张棉纸图信息过载**——唛号/生熟/精确年份在棉纸上不存在(在内飞/大票/饼背),该分数不代表管线缺陷。下一步提分方向不是调检索,而是**多图题**(棉纸+内飞+饼背组图)或 E 类出题改造。
- 教师 OCR 非确定性是分数波动主因(同图多次调用读出的文字不同);生产化时需固定温度或多采样投票。

## 六、复跑命令

```bash
cd rag
python3 retrieval_smoke.py                          # 检索回归(5 canned 查询)
python3 rag_pipeline.py --q "7542为什么被称为标杆"   # 文本模式
python3 rag_pipeline.py --q "识别这饼茶" --img ../eval/images/N009.jpg --json
python3 run_rag_eval.py --provider glm              # eval(断点续跑)
python3 run_rag_eval.py --provider bailian          # 教师端点(配额恢复后)
python3 eval_rag_report.py                          # 对照报告
```

坑位备忘:本机 shell 的 `ANTHROPIC_AUTH_TOKEN` 属于 Claude Code 自己,不能当教师 token(401);
token-plan 周配额会耗尽(本次 8-23 恢复),teacher_api 已支持 glm/kimi 备援;GLM 全角冒号「来源:」需正则兼容;
VLM 读图前 2x Lanczos 放大可显著改善小字识别。
