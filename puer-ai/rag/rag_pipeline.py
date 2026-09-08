#!/usr/bin/env python3
"""RAG answer pipeline: question (+optional images) → clue extraction →
hybrid retrieval (SKU + knowledge chunks) → teacher generation grounded in
the retrieved evidence, with citations and an uncertainty discipline.

CLI:
  python3 rag_pipeline.py --q "03四星孔雀什么行情" [--json]
  python3 rag_pipeline.py --q "识别这饼茶" --img ../eval/images/N009.jpg
"""
import argparse
import json
import os
import re

import image_ocr
import teacher_api
import visual_match
from retriever import hybrid_search, price_str, donghe_img_path

# per-call provider routing (thread-safe: teacher_api.ask(provider=...) never
# mutates its global). Empty env falls back to the module default (RAG_PROVIDER).
ANSWER_PROVIDER = os.environ.get("RAG_ANSWER_PROVIDER") or None

SYSTEM_EXPERT_RAG = """你是一位有二十年经验的普洱茶专家。请直接、简洁地回答,术语专业,不确定时明确说明。

回答铁律(必须遵守):
1 优先依据【参考资料】回答;资料支持的部分必须引用,格式 [来源:文件名 p页码] 或 [来源:SKU记录];可以多条引用。
2 若参考资料未覆盖问题的核心,可以在呈现资料相关部分之后,补充通用普洱茶知识,但必须以「【资料未覆盖,以下为通用知识】」标注分隔,不得混写。
3 严禁编造唛号、年代、厂家、价格;图片线索里读不到的文字不得当作事实;引用的资料里没有的信息不得以资料名义陈述。
4 图片线索若无可读文字(仅视觉特征),严禁依据视觉风格(颜色/版式/布局/印刷风格)断言具体品名、厂家或年代——同一版式特征会命中多个年代相差数十年的茶品;此时必须明确说「图上未读到可辨认文字,无法断言身份」,视觉特征只可用于客观描述。
5 你只能看到【图片线索】的文字转录,看不到图片本身:图面细节(饼面条索、汤色、器物、叶片形态等)凡线索未提及的一律不得描述、不得以「从图片线索看」引出——那是编造。
6 图片文字由 OCR 转录,存在形近字误差(天/大、己/已、土/士、末/未等)。若参考资料中出现与图上文字仅一两字之差或高度吻合的条目(监制方/出品厂/年份/版式相互印证),必须作为「疑似匹配」明确指出:引用该条目的全部信息(含行情价),说明图上读法与库名的差异字,标注「疑为同款,请以实物或内飞核对」——严禁以一字之差直接判定「无关联/无资料记录」。注意:「云南七子饼茶」「中国土产畜产…监制」「勐海茶厂/昆明茶厂出品」等是通行版面文字,出现在成百上千款棉纸上,不得作为疑似匹配的依据;疑似匹配必须建立在图上核心身份文字(品牌名/唛号/签名式用字)与库名的对应上,仅通行版面吻合时必须如实说「图上无身份文字,无法与具体条目关联」。
7 回答末尾不要复述规则。"""

# appended to SYSTEM_EXPERT_RAG only when the visual comparison stage ran
SYSTEM_VISUAL_RULE = """
8 【视觉比对结论】是把用户图片与东和参考图逐版面比对的机器判定,引用格式 [来源:视觉比对:SKU名]。真伪立场必须保守:与东和参考图版面高度一致(same_product)可作为「符合东和版别」的真品依据之一,但仍建议核对内飞;判定为同系列不同版本(same_series_variant)或未找到相同包装(different_product/uncertain)时,严禁断言真品或断言不同款,必须标注「存疑,请核对内飞及实物细节」,并说明依据的具体版面元素;视觉置信度低于0.8时须明确说明置信有限。"""

SYSTEM_NO_EVIDENCE = """你是一位有二十年经验的普洱茶专家。本次没有检索到相关资料。
请基于通用普洱茶知识回答,并:开头注明「【无检索证据,以下为通用知识,可靠性有限】」;不确定处明确说明;严禁编造具体唛号、年代、价格。"""


def build_context(hits):
    """Render retrieved hits into the 参考资料 block + machine-readable sources."""
    lines, sources = [], []
    for h in hits:
        r = h["record"]
        if h["kind"] == "sku":
            src = f"SKU记录:{r['name']}"
            desc = (f"{r['name']}|{r['year']}年|{r.get('form') or '?'}"
                    f"{'|' + r['lot'] if r.get('lot') else ''}"
                    f"{'|' + r['raw_or_ripe'] if r.get('raw_or_ripe') else ''}"
                    f"|{price_str(r)}")
        elif h["kind"] == "donghe":
            src = f"东和行情:{r['name']}"
            price = f"行情价{r['price']:,.0f}元/{r.get('unit') or '件'}" if r.get("price") else "暂无报价"
            chg = ""
            if r.get("change") is not None:
                chg = f"|较上次{'+' if r['change'] > 0 else ''}{r['change']:,.0f}({r.get('changeRatio', 0) * 100:+.1f}%)"
            img = donghe_img_path(r)
            img_note = f"|参照图:{os.path.basename(img)}" if os.path.exists(img) else ""
            desc = (f"{r['name']}|{r.get('year') or '?'}年|{price}{chg}"
                    f"|行情更新于{r.get('priceUpdatedAt') or '?'}{img_note}")
        else:
            src = f"{r['source']} p{r['pages']}"
            desc = r["text"][:800]
        lines.append(f"[{src}]\n{desc}")
        sources.append({"source": src, "kind": h["kind"]})
    return "\n\n".join(lines), sources


def merge_hits(lists, cap=12):
    """Dedup across multi-query retrieval; SKU by name+year, chunk by source+pages."""
    seen, out = set(), []
    for hits in lists:
        for h in hits:
            r = h["record"]
            k = (h["kind"], r.get("name"), r.get("year")) if h["kind"] == "sku" \
                else (h["kind"], r.get("source"), r.get("pages"))
            if k in seen:
                continue
            seen.add(k)
            out.append(h)
    return out[:cap]


def extract_citations(answer):
    # teachers often emit the fullwidth colon despite the prompt
    return sorted(set(re.findall(r"\[来源[:：]([^\]]+)\]", answer)))


# Domain term normalization for RETRIEVAL QUERIES ONLY (never shown to the
# generator as fact): the trade name for a wrapper feature is not an identity
# guess — e.g. 「黄色茶字」 is literally what 「黄印」 means in the trade.
# Keys are regex over OCR text+features; values are appended to the query.
TERM_HINTS = [
    (r"黄[^。;；,，]{0,6}茶.?字|茶.?字[^。;；,，]{0,4}黄", "黄印"),
    (r"紫(褐|红|色)?[^。;；,，]{0,6}(茶.?字|文字|大益)|紫大益", "紫大益"),
    (r"红[^。;；,，]{0,6}茶.?字|茶.?字[^。;；,，]{0,4}红(?!火)", "红印"),
    (r"八中|中茶牌|中國?土產?畜產", "中茶"),
    (r"大益", "大益"),
    # commissioned wrappers: the brand name drowns in the full OCR transcript
    (r"天福|大福茶业", "天福"),
    # Tianfu commissioned 7262 wrapper carries NO mark number or brand text —
    # its signature is 「陈年」 flanking a fan-shaped 福 medallion. M3 reads
    # are non-deterministic (陈年→陳舂, 扇形→杯型), so anchor on stable
    # fragments: 陈/陳+年-like char, or 陈/陳+福 co-occurrence. A false
    # trigger only injects one extra query — rule 6' in SYSTEM_EXPERT_RAG
    # keeps the generator from forcing a match on it.
    (r"[陈陳][年舂宁宇]", "天福 7262 陈年定制"),
    (r"(?=[\s\S]*[陈陳])(?=[\s\S]*福)", "天福 7262 陈年定制"),
]


def term_expand(text):
    extra = []
    for pat, term in TERM_HINTS:
        if re.search(pat, text) and term not in extra:
            extra.append(term)
    return extra


def answer_question(question, image_paths=None, topk=6, use_embed=True):
    """Full pipeline. Returns a dict (JSON-friendly)."""
    ocr = []
    queries = [question]
    terms = []
    for p in (image_paths or []):
        clue = image_ocr.extract(p)
        clue["image"] = p
        ocr.append(clue)
        # Style words (黄字/中央大字/环绕小字…) as retrieval keys match MANY
        # decades of wrappers — e.g. they anchored a 2001 天福7262 to "1950红印".
        # Only feed the retriever when there is actual readable TEXT.
        vt = re.sub(r"\[模糊\]|\[遮挡\]", "", clue["visible_text"]).strip()
        if vt:
            ocr_q = (clue["visible_text"] + " " + clue["visual_features"]).strip()
        else:
            ocr_q = ""
        ocr_q = re.sub(r"puer\.im", " ", ocr_q)  # strip site watermark noise
        terms += term_expand(ocr_q)
        if ocr_q and ocr_q != question:
            queries.append(ocr_q)
    if terms:
        # trade terms get their own SHORT query path: inside the full OCR
        # transcript, high-df bigrams (公司名/英文) drown out 黄印/紫大益
        queries.append(" ".join(dict.fromkeys(terms)))

    hits_all, embed_ok = [], True
    for q in queries:
        hits, ok = hybrid_search(q, topk=topk, use_embed=use_embed)
        hits_all.append(hits)
        embed_ok = embed_ok and ok
    if terms:
        # the term-derived SHORT query is the most targeted retrieval; its hits
        # must enter the merge FIRST or the generic hits of the long OCR
        # transcript fill the cap and squeeze it out (天福7262 was capped out
        # by 12 孔雀之乡/日志 chunks in exactly this way).
        hits_all.insert(0, hits_all.pop())

    # visual comparison vs donghe reference wrappers (same/variant verdicts
    # enter the merge FIRST — same discipline as the term short-query above)
    visual = (visual_match.compare(image_paths[0], ocr[0]["visible_text"])
              if image_paths else {"ok": False, "reason": "no_image"})
    visual_block = ""
    visual_hits = []
    best = visual.get("best") if visual.get("ok") else None
    if best and best.get("verdict") in ("same_product", "same_series_variant") \
            and best.get("record"):
        visual_hits = [{"kind": "donghe", "score_b": None, "score_e": None,
                        "record": best["record"]}]
        conf = best.get("confidence", 0)
        word = "包装高度一致,符合东和版别" if best["verdict"] == "same_product" \
            else "同系列但版面/年份存在差异(早年茶常见同款多版棉纸)"
        visual_block = (f"视觉比对结论(用户图 vs 东和参考图,机器判定,未经实物核验):\n"
                        f"- 与「{best['name']}」{word}(置信{conf})。{best.get('notes','')}")
    elif best:
        near = "、".join(c["name"] for c in visual.get("candidates", [])[:2]) or "无"
        visual_block = (f"视觉比对结论(用户图 vs 东和参考图,机器判定,未经实物核验):\n"
                        f"- 未在东和库找到相同包装(判定:{best['verdict']},置信"
                        f"{best.get('confidence', 0)});最接近:{near}。{best.get('notes','')}")
    if visual_hits:
        hits_all.insert(0, visual_hits)
    merged = merge_hits(hits_all)

    context, sources = build_context(merged)
    if merged:
        sys_prompt = SYSTEM_EXPERT_RAG
        user = ""
        if ocr:
            lines = [f"[图{i+1} 线索(仅转录,未经证实)] {c['visible_text'] or '(无文字)'};{c['visual_features']}"
                     for i, c in enumerate(ocr)]
            user += "图片线索:\n" + "\n".join(lines) + "\n\n"
        user += f"【参考资料】\n{context}\n\n【问题】{question}"
        if visual_block:
            sys_prompt = SYSTEM_EXPERT_RAG + SYSTEM_VISUAL_RULE
            user = user.replace("【参考资料】", visual_block + "\n\n【参考资料】")
    else:
        sys_prompt = SYSTEM_NO_EVIDENCE
        user = question
    answer = teacher_api.ask(user, system=sys_prompt, max_tokens=3000,
                             provider=ANSWER_PROVIDER)

    cites = extract_citations(answer)
    unsure = len(re.findall(r"证据不足|不确定|无法确认", answer))
    confidence = "low" if unsure >= 2 or (not merged) else ("high" if cites and not unsure else "medium")
    return {"question": question, "answer": answer,
            "sources": sources, "citations": cites, "confidence": confidence,
            "queries": queries, "ocr": ocr, "n_hits": len(merged),
            "embed_used": embed_ok,
            "visual": {"ok": visual.get("ok", False),
                       "brand": visual.get("brand", ""),
                       "best": ({k: v for k, v in best.items() if k != "record"}
                                if best else None)}}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--q", required=True)
    ap.add_argument("--img", action="append", default=[], help="image path, repeatable")
    ap.add_argument("--topk", type=int, default=6)
    ap.add_argument("--no-embed", action="store_true")
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()
    out = answer_question(args.q, args.img or None, args.topk, not args.no_embed)
    if args.json:
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        print(f"Q: {out['question']}")
        print(f"检索: {out['n_hits']} 条命中 (embed={'on' if out['embed_used'] else 'off/degraded'})")
        print(f"置信: {out['confidence']}\n")
        print(out["answer"])
        if out["citations"]:
            print("\n引用:", "; ".join(out["citations"]))


if __name__ == "__main__":
    main()
