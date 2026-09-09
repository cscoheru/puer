# 茶问 rag-service v20-w1-w5 部署记录（2026-09-08）

## 部署内容

`rag-src/v20-w1-base/visual_match.py`（2026-08-25 09:16 UTC 版，+744 行）——此前仅存在于
服务器目录、从未进入运行容器的代码。同系列 SKU 召回/判定改进：

- **B2 Notes-Verdict 一致性**（默认 ON，本次上线即生效）：备注含"新版/老版/变体/
  不同年份/跨年份/复刻"等线索时，`same_product` → `same_series_variant`，置信度 ×0.6
- **B3/W5-1 sibling inject**（默认 OFF，需 `SIBLING_INJECT=1`）：按 anchor 注入同系列 SKU
- **F1 驱逐地板 0.40 / F1b 池内链式补全**（随 SIBLING_INJECT 开关）
- **E2 sibling-aware best bias**（默认 OFF，需 `E2_SIBLING_BIAS=1`）

## 部署前验证（全部通过）

| # | 验证项 | 结果 |
|---|---|---|
| 1 | `py_compile` 语法检查 | PASS |
| 2 | API 兼容：rag_pipeline 仅调用 `compare`/`compare_multi`，新版保留 | PASS |
| 3 | 内置自测试（宿主 Python3 + numpy 2.2.6） | 18/18 PASS |
| 4 | 内置自测试（镜像内 Python 3.12） | 18/18 PASS |
| 5 | 冒烟容器 `/healthz`（127.0.0.1:8001，不影响生产） | PASS |
| 6 | 池级真实数据（默认配置）：1605.jpeg 正确召回自身 dino=1.0 + 大益系列 M3 | PASS |
| 7 | 池级真实数据（SIBLING_INJECT=1）：注入 3 条八角亭 sibling，槽位替换制 | PASS |
| 8 | E2E 拒答路径 A/B（8000 vs 8001）：行为完全一致 | PASS |
| 9 | E2E 知识问答：confidence=high 正常回答 | PASS |

注：自测试需 `SIBLING_INJECT=1` 环境下运行（测试设计如此，非 bug）。

## 上线操作

1. 备份标签：`docker tag puer-rag-service:v20-w1-w4 puer-rag-service:pre-w5-20260908`
2. 旧容器停止并改名保留：`puer-hub-rag-service-w4-backup`（v20-w1-w4）
3. 新容器同配置启动：`puer-hub-rag-service` = `puer-rag-service:v20-w1-w5`
   （network=puer-hub_puer-net, alias=rag-service, 8000:8000, rag-data/uploads ro 挂载,
   unless-stopped, env 与旧容器一致）
4. 验证：healthz OK；app 容器 → rag-service 连通 OK（node fetch）

## 回滚方案（无需授权外操作）

```bash
docker stop puer-hub-rag-service && docker rm puer-hub-rag-service
docker rename puer-hub-rag-service-w4-backup puer-hub-rag-service
docker start puer-hub-rag-service
```

## 行为变化说明

线上默认配置下唯一行为变化 = B2 生效（同款判定遇时间/变体线索时降级并降置信度）。
B3/F1/F1b/E2 保持关闭，待离线评估（run_f1/f3/e12 + analyze_v5）达标后再按
`SIBLING_INJECT=1` / `E2_SIBLING_BIAS=1` 开启。
