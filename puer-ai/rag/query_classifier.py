"""Query classifier for puer-ask pipeline.

Decides whether a question is:
  - "abc" (A/B/C type): general knowledge — answerable by LLM common sense
    without library lookup (形态/类型/行话/色档/常识/存储/冲泡)
  - "de"  (D/E type): identity / authenticity / year / pricing — requires
    retrieval (donghe catalog + visual match + tea reviews)

Pure keyword heuristic; no LLM call. Trade-off: miss-classification on
boundary questions is biased toward "de" (more conservative — when in doubt,
we search the library). Pass `image_paths` for tiebreaker (presence of image
shifts toward "de" unless the question is explicitly asking for shape/type).

Public API:
  classify_query(question: str, has_image: bool = False) -> "abc" | "de"
"""
from __future__ import annotations

import re


# A/B/C 类 — LLM 常识可答,不查库
ABC_KEYWORDS: dict[str, list[str]] = {
    "类型/形态": [
        "饼茶", "砖茶", "沱茶", "散茶", "瓜片", "金瓜", "七子饼", "饼", "砖", "沱",
        "散", "紧茶", "青饼", "熟饼", "生砖", "熟砖", "生沱", "熟沱",
    ],
    "克重/规格": [
        "357克", "500克", "250克", "400克", "200克", "100克", "饼装", "砖装", "沱装",
        "整件", "件", "提", "片", "规格",
    ],
    "行话术语": [
        "红浓", "透亮", "琥珀", "青瓷", "青花", "生津", "回甘", "喉韵", "仓感",
        "干仓", "湿仓", "仓储", "醒茶", "出汤", "条索", "茶底", "叶底", "茶气",
        "香高味浓", "条紧形美", "内涵丰富", "梅子香", "樟香", "参香", "药香",
        "陈香", "蜜香", "兰香", "枣香",
    ],
    "色档": [
        "汤色", "茶汤", "橙黄", "金黄", "琥珀色", "栗红", "宝石红", "红浓",
        "黄亮", "深红", "浅黄",
    ],
    "常识/方法": [
        "什么是", "为什么", "怎么", "如何", "区别", "区别", "有何", "哪种好",
        "怎么存", "怎么泡", "水温", "醒茶", "几度", "几分钟", "多久", "注意什么",
        "如何辨别", "怎么看",
    ],
    "产地/茶区": [
        "勐海", "易武", "班章", "冰岛", "昔归", "景迈", "南糯", "布朗", "勐库",
        "产地", "茶区", "山头", "寨子",
    ],
}

# D/E 类 — 必须查库 + 视觉召回
DE_KEYWORDS: dict[str, list[str]] = {
    "身份/鉴别": [
        "是不是", "是不是真的", "真假", "鉴别", "鉴定", "真伪", "对不对",
        "帮我看", "帮我看看", "帮我认", "看看是不是",
    ],
    "行情/价格": [
        "多少钱", "价格", "行情", "值多少", "市场价", "值不值", "值吗",
        "现在多少", "现在价格", "现在行情", "值多少", "件价", "提价",
        "现在卖多少", "多少钱一饼", "多少钱一件", "多少钱一提",
    ],
    "年份/年代": [
        "哪年", "哪一年", "年份", "年代", "哪年制", "哪年生产", "什么时候的",
        "什么年代", "几几年", "哪年出品",
    ],
    "厂牌/唛号(查询)": [
        "大益", "下关", "中茶", "八角亭", "陈升号", "福海", "南峤", "吉幸",
        "黎明", "澜沧", "六大茶山", "合和昌", "老同志", "七彩云南", "龙润",
    ],
    "唛号": [
        "7542", "7572", "7262", "8582", "V93", "401", "901", "601", "101", "701",
        "801", "001", "1601", "107", "210", "301",
    ],
}


def _hit_count(q: str, kw_groups: dict[str, list[str]]) -> tuple[int, set[str]]:
    """Return (total_hits, matched_group_names). Single match per group."""
    hits = 0
    matched = set()
    for grp, words in kw_groups.items():
        for w in words:
            if w in q:
                hits += 1
                matched.add(grp)
                break
    return hits, matched


def classify_query(question: str, has_image: bool = False) -> str:
    """Classify a question as 'abc' (LLM common sense) or 'de' (needs retrieval).

    Priority:
      1. Explicit identity/authenticity markers ("真假/鉴别/鉴定/是不是") → de
      2. Explicit knowledge ("什么是/怎么/为什么") → abc
      3. Hit-count tiebreaker; if has_image and tied → de (more conservative)
    """
    if not question or not question.strip():
        # No question text + has image → still de (we need to ID the tea)
        return "de" if has_image else "abc"

    q = question.strip()

    # 1. 显式身份/鉴别触发 — 一票 de
    for w in DE_KEYWORDS["身份/鉴别"]:
        if w in q:
            return "de"

    # 2. 显式常识触发 — 一票 abc
    for w in ABC_KEYWORDS["常识/方法"]:
        if w in q:
            return "abc"

    # 3. 计票决胜
    abc_hit, _ = _hit_count(q, ABC_KEYWORDS)
    de_hit, _ = _hit_count(q, DE_KEYWORDS)

    if de_hit > abc_hit:
        return "de"
    if abc_hit > de_hit:
        return "abc"
    # 平局:有图偏 de(图通常是要鉴定),无图偏 abc(纯好奇)
    return "de" if has_image else "abc"


# ── smoke test (run with: python3 query_classifier.py) ─────────────
if __name__ == "__main__":
    SAMPLES = [
        # (question, has_image, expected_class, comment)
        ("普洱茶怎么存?", False, "abc", "常识方法"),
        ("红浓是什么意思?", False, "abc", "行话术语"),
        ("大益7572 是哪个年代的?", False, "de", "厂牌+号+"),
        ("越陈越香值多少钱?", False, "de", "行情"),
        ("怎么分辨大益7572的真假?", False, "de", "鉴别"),
        ("普洱茶饼和砖茶有什么区别?", False, "abc", "常识+类型"),
        ("357克一饼的茶算大饼还是小饼?", False, "abc", "规格"),
        ("汤色橙黄是什么茶?", False, "abc", "色档"),
        ("这是哪一年的?", True, "de", "年份+图"),
        ("你看这是真的还是假的?", True, "de", "鉴别+图"),
        ("帮我看看这是不是越陈越香", True, "de", "鉴别+图"),
        ("", False, "abc", "空问题"),
        ("", True, "de", "空问题+图"),
    ]
    ok = 0
    for q, img, exp, note in SAMPLES:
        got = classify_query(q, has_image=img)
        mark = "OK" if got == exp else "FAIL"
        if got == exp:
            ok += 1
        print(f"  [{mark}] {got:>3s} (expect {exp}) — {note!r:40s} | q={q!r}")
    print(f"\n{ok}/{len(SAMPLES)} passed")