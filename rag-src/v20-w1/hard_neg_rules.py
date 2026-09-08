#!/usr/bin/env python3
"""W2-2 hard-negative 降级规则引擎。

用途：对 M3 给出的 same_product verdict 做"系列内混淆"降级。
当 best 是 same_product + 高置信度，但 best 本身的 dino_sim 没有达到自匹配
级别（<0.95），且 to_compare 池中存在与 best 共享"系列锚词"
(SERIES_ANCHOR_PATTERNS) 且视觉距离足够近（dino_sim≥0.50）的其他 SKU 时，
把 best.verdict 降为 same_series_variant + 置信度乘以 0.6。

为什么这两个阈值都对：
- best.dino_sim ≥ 0.95 → 自匹配层级（用户上传的图本身就在库里），不该降级
- other.dino_sim ≥ 0.50 → 其他锚词兄弟在视觉上也算接近，可能是 M3 漏掉的
  正确答案；低于 0.50 说明它包装差异太大，M3 的选择合理

设计：
- SERIES_ANCHOR_PATTERNS 来源：默认内置 + 可由 HARD_NEG_PATTERNS env 指向
  JSON 文件 override（运营调参无需改代码）。
- 默认 patterns 包含容易混淆的系列标识：7572/7542/7262 是经典唛号，
  越陈越香/八角亭/班章/孔雀/金贡品/银孔雀 是系列主题词。
- 触发条件是双向：best 名称 和 池中其他 SKU 名称都包含同一锚词。

回滚开关：env HARD_NEG_DEMOTE=0 关闭整个模块。
已知局限：跨系列混淆（如越陈越香照片被误判为八角亭 2009 金贡品）不在
本规则覆盖范围——需要 anchor 不重叠 + 视觉相似，需要下一轮单独的
inter-series confusion 规则。
"""
import json
import os
import re


SERIES_ANCHOR_PATTERNS_FILE = os.environ.get(
    "HARD_NEG_PATTERNS",
    "/opt/puer-hub/rag-data/hard_neg_patterns.json")

# 内置默认锚词。运营可通过 JSON 文件 override。
# 选词逻辑：经典唛号（7572/7542/7262）+ 系列主题（越陈越香/八角亭/班章/
# 孔雀/金贡品/银孔雀）+ 经典大益常规款标识（避免"大益"过宽，仅在
# "大益XX" 形式下出现）。
DEFAULT_PATTERNS = [
    r"越陈越香",
    r"八角亭",
    r"7572",
    r"班章",
    r"孔雀",
    r"金贡品",
    r"银孔雀",
    r"7542",
    r"7262",
    r"金大益",
    r"银大益",
]

_PATTERNS = None


def _load_patterns() -> list:
    """加载锚词正则。优先 env 指向文件，缺则用内置默认。"""
    if os.path.exists(SERIES_ANCHOR_PATTERNS_FILE):
        try:
            raw = json.load(open(SERIES_ANCHOR_PATTERNS_FILE,
                                 encoding="utf-8"))
            return [re.compile(p) for p in raw]
        except (OSError, json.JSONDecodeError) as e:
            print(f"[hard_neg_rules] WARN: failed to load "
                  f"{SERIES_ANCHOR_PATTERNS_FILE}: {e}; using defaults")
    return [re.compile(p) for p in DEFAULT_PATTERNS]


def patterns() -> list:
    global _PATTERNS
    if _PATTERNS is None:
        _PATTERNS = _load_patterns()
    return _PATTERNS


def reload_patterns() -> list:
    """强制重读 patterns 文件（运营 hot-reload 用）。"""
    global _PATTERNS
    _PATTERNS = None
    return patterns()


def apply_demote(verdicts: list, to_compare: list, recs: dict) -> int:
    """对 verdicts 做硬负例降级，返回降级条数。

    Args:
        verdicts: M3 给出的 [{"skuId","verdict","confidence","notes"}, ...]
        to_compare: 候选池 [{"skuId","dino_sim","name"}, ...]（含 best）
        recs: skuId -> donghe record dict（含 name 字段）

    Returns:
        被降级的 verdict 条数。每个 verdict 最多降级一次（first anchor wins）。
    """
    if not verdicts or not to_compare:
        return 0

    n_demoted = 0
    # pre-build skuId -> name lookup for the pool
    pool_names = {h["skuId"]: (recs.get(str(h["skuId"]), {}).get("name")
                                or h.get("name") or "")
                  for h in to_compare}

    pats = patterns()
    for v in verdicts:
        if v.get("verdict") != "same_product":
            continue
        # 0.85 阈值：低于此置信度不触发降级（M3 自己已经不太确定）
        if v.get("confidence", 0) < 0.85:
            continue
        v_sid = str(v.get("skuId", ""))
        v_name = recs.get(v_sid, {}).get("name") or pool_names.get(v_sid, "")
        if not v_name:
            continue
        # 找到 v 对应的 dino_sim（用于自匹配保护）
        v_hit = next((h for h in to_compare
                      if str(h.get("skuId")) == v_sid), None)
        v_dino = v_hit.get("dino_sim", 0) if v_hit else 0
        if v_dino >= 0.95:
            # 自匹配层级，不动它
            continue

        shared_anchor = None
        demo_other = None
        for other_h in to_compare:
            other_sid = str(other_h.get("skuId", ""))
            if not other_sid or other_sid == v_sid:
                continue
            other_name = recs.get(other_sid, {}).get("name") \
                         or pool_names.get(other_sid, "") \
                         or other_h.get("name") or ""
            if not other_name:
                continue
            # 双向匹配同一锚词 + 其他候选视觉也够近（≥0.50 = M3 可能漏选）
            for pat in pats:
                if pat.search(v_name) and pat.search(other_name):
                    if other_h.get("dino_sim", 0) >= 0.50:
                        shared_anchor = pat.pattern
                        demo_other = (other_sid, other_name,
                                      other_h.get("dino_sim"))
                        break
            if shared_anchor:
                break

        if shared_anchor:
            old_verdict = v["verdict"]
            old_conf = v["confidence"]
            v["verdict"] = "same_series_variant"
            v["confidence"] = round(old_conf * 0.6, 2)
            tag = (f"[W2降级:系列混淆 anchor={shared_anchor} "
                   f"vs={demo_other[0]} sim={demo_other[2]:.3f}]")
            v["notes"] = ((v.get("notes") or "") + " " + tag).strip()
            n_demoted += 1

    return n_demoted


if __name__ == "__main__":
    # 简单自检
    print("loaded patterns:", [p.pattern for p in patterns()])

    # Case 1: 同锚词 + 其他候选也够近(0.50+) + best非自匹配 → 应降级
    verdicts1 = [
        {"skuId": "5878", "verdict": "same_product",
         "confidence": 0.95, "notes": ""},
    ]
    to_compare1 = [
        {"skuId": "5878", "name": "八角亭 2009 金贡品青饼", "dino_sim": 0.70},
        {"skuId": "2200", "name": "八角亭 2005 7542 经典青饼", "dino_sim": 0.62},
        {"skuId": "9505", "name": "大益 金大益 2501", "dino_sim": 0.55},
    ]
    recs1 = {
        "5878": {"name": "八角亭 2009 金贡品青饼"},
        "2200": {"name": "八角亭 2005 7542 经典青饼"},
        "9505": {"name": "大益 金大益 2501"},
    }
    n1 = apply_demote(verdicts1, to_compare1, recs1)
    print(f"Case1 demoted={n1} (expected 1):",
          "verdict=", verdicts1[0]["verdict"],
          "conf=", verdicts1[0]["confidence"])

    # Case 2: 不同锚词 + 高 conf → 不降级
    verdicts2 = [
        {"skuId": "9505", "verdict": "same_product", "confidence": 0.98,
         "notes": ""},
    ]
    to_compare2 = [
        {"skuId": "9505", "name": "大益 金大益 2501", "dino_sim": 0.70},
        {"skuId": "4032", "name": "下关沱茶 绿盒", "dino_sim": 0.55},
    ]
    recs2 = {
        "9505": {"name": "大益 金大益 2501"},
        "4032": {"name": "下关沱茶 绿盒"},
    }
    n2 = apply_demote(verdicts2, to_compare2, recs2)
    print(f"Case2 demoted={n2} (expected 0):",
          "verdict=", verdicts2[0]["verdict"])

    # Case 3: 自匹配 (best.dino_sim=1.0) → 不降级，即便有同锚词候选
    verdicts3 = [
        {"skuId": "5878", "verdict": "same_product", "confidence": 0.99,
         "notes": ""},
    ]
    to_compare3 = [
        {"skuId": "5878", "name": "八角亭 2009 金贡品青饼", "dino_sim": 1.0},
        {"skuId": "5879", "name": "八角亭 2010 金贡品红盒", "dino_sim": 0.88},
    ]
    recs3 = {
        "5878": {"name": "八角亭 2009 金贡品青饼"},
        "5879": {"name": "八角亭 2010 金贡品红盒"},
    }
    n3 = apply_demote(verdicts3, to_compare3, recs3)
    print(f"Case3 demoted={n3} (expected 0, best.dino_sim=1.0 self-match):",
          "verdict=", verdicts3[0]["verdict"])

    # Case 4: conf < 0.85 → 不降级
    verdicts4 = [
        {"skuId": "5878", "verdict": "same_product", "confidence": 0.70,
         "notes": ""},
    ]
    to_compare4 = [
        {"skuId": "5878", "name": "八角亭 2009 金贡品青饼", "dino_sim": 0.70},
        {"skuId": "2200", "name": "八角亭 2005 7542 经典青饼", "dino_sim": 0.62},
    ]
    recs4 = {
        "5878": {"name": "八角亭 2009 金贡品青饼"},
        "2200": {"name": "八角亭 2005 7542 经典青饼"},
    }
    n4 = apply_demote(verdicts4, to_compare4, recs4)
    print(f"Case4 demoted={n4} (expected 0, conf=0.70<0.85):",
          "verdict=", verdicts4[0]["verdict"])

    # Case 5: 同锚词 + 其他候选也够近 + 但best.dino_sim < 0.95 → 应降级
    verdicts5 = [
        {"skuId": "5878", "verdict": "same_product", "confidence": 0.92,
         "notes": ""},
    ]
    to_compare5 = [
        {"skuId": "5878", "name": "八角亭 2009 金贡品青饼", "dino_sim": 0.85},
        {"skuId": "2200", "name": "八角亭 2005 7542 经典青饼", "dino_sim": 0.78},
    ]
    recs5 = {
        "5878": {"name": "八角亭 2009 金贡品青饼"},
        "2200": {"name": "八角亭 2005 7542 经典青饼"},
    }
    n5 = apply_demote(verdicts5, to_compare5, recs5)
    print(f"Case5 demoted={n5} (expected 1, both anchor-match + other.dino_sim=0.78>=0.50):",
          "verdict=", verdicts5[0]["verdict"],
          "conf=", verdicts5[0]["confidence"])