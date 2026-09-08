#!/usr/bin/env python3
"""W3-1 refusal taxonomy — structured 7-state refusal classification.

Replaces rag_pipeline's implicit "best exists → answer, else empty" with an
explicit refusal layer. When refusal fires, the teacher_api LLM is skipped
entirely (no hallucination risk) and the user gets a deterministic fallback
message + a structured refusal state.

Seven states (in evaluation order — first match wins):

  1. out_of_scope         qclass=abc but user passed images (image-aided
                          common-knowledge question — refuse with image
                          was not usable for this question class)
  2. no_image             qclass=de but image_paths empty (user asked an
                          identification question without a photo)
  3. low_confidence       visual_match verdict=uncertain OR best.confidence<0.5
                          OR best.dino_sim<0.5
  4. multiple_matches     visual_match produced ≥2 same-tier candidates whose
                          confidence gap is ≤0.05 (caller can't disambiguate)
  5. non_tea_product      visual_match.ok=False AND OCR has no tea keywords
                          (asset broken OR clearly a non-tea item)
  6. unreadable_image     visual_match.ok=False (image_error) OR file <10KB
                          OR dino_mat all-zero (corrupted/blacked-out image)
  7. conflicting_signals  OCR text says 熟/生 but best.record.tea_type is the
                          opposite AND tea_type ∈{ripe,raw} (visual vs text
                          disagree on tea type)

Returns:
  dict {state, message} on refusal, or None when the answer should proceed
  through the teacher LLM as normal.

Self-test:
  python3 refusal.py        # 14 cases (≥2 per state)
"""
import re

# Order matters — first match wins. 状态名稳定, UI + log 都靠它.
STATES = (
    "out_of_scope", "no_image", "low_confidence", "multiple_matches",
    "non_tea_product", "unreadable_image", "conflicting_signals",
)

# Tea-product OCR signals — keep small and conservative. Adding words here
# pulls `non_tea_product` away from false negatives.
TEA_HINTS = ("茶", "普洱", "饼", "砖", "沱", "唛号", "生", "熟", "青", "厂", "牌")

# Visual vs text type strings. W3-0 tea_type ∈ {ripe, raw, white, mixed,
# unknown}; only ripe/raw count as a strong visual claim.
# USER 2026-08-25: no single-char 生/熟 (出品 would false-fire as raw).
RIPE_TOKENS = ("熟饼", "熟砖", "熟沱", "熟茶")
RAW_TOKENS = ("生饼", "生砖", "生沱", "生茶", "青饼", "青砖", "青沱", "青茶")


def _has_tea_signal(text: str) -> bool:
    return any(tok in text for tok in TEA_HINTS)


def _has_text_type_signal(text: str, want: str) -> bool:
    if want == "ripe":
        return any(tok in text for tok in RIPE_TOKENS)
    if want == "raw":
        return any(tok in text for tok in RAW_TOKENS)
    return False


def _ocr_concat(ocr_list):
    """Flatten a list of {visible_text, visual_features} into one searchable string."""
    parts = []
    for c in ocr_list or []:
        parts.append(c.get("visible_text", "") or "")
        parts.append(c.get("visual_features", "") or "")
    return " ".join(parts)


def compute_refusal(qclass, image_paths, visual_result, ocr=None,
                    file_size_hint=None) -> dict | None:
    """Return {state, message} or None. ocr is a list of OCR dicts (one per
    image). file_size_hint is optional — if provided, the unreadable_image
    rule fires when bytes <10KB even if visual_match reported ok=True.
    """
    has_img = bool(image_paths)
    img_count = len(image_paths or [])

    # 1. out_of_scope — abc (common knowledge) question WITH images attached.
    #    Refuse; tell user this is a knowledge question, image was unused.
    if qclass == "abc" and has_img:
        return {
            "state": "out_of_scope",
            "message": ("这张图片不属于鉴别/行情类问题,无法用图片辅助回答。"
                        "建议用纯文字提问(如:「生茶和熟茶有什么区别?」「普洱茶怎么存放?」)"),
        }

    # 2. no_image — de (identification/price) question WITHOUT an image.
    #    qclass is "de" (单字符串, 不是 list ["d","e"]) — query_classifier
    #    returns only "abc" or "de".
    if qclass == "de" and not has_img:
        return {
            "state": "no_image",
            "message": ("请上传茶饼/茶砖/茶汤/外包装的图片,我才能帮您识别和查价。"
                        "建议拍正面棉纸 + 唛号 + 内飞,光线充足,平整摆放。"),
        }

    # 5. non_tea_product — asset broken AND OCR proves it isn't tea. If OCR
    #    is empty (no readable text), can't conclude "not tea" — fall through
    #    to unreadable_image, where the user gets a clearer "redo the photo".
    if visual_result and not visual_result.get("ok"):
        reason = visual_result.get("reason") or ""
        if any(tok in reason for tok in ("image_error", "asset_missing", "ids_mismatch")):
            ocr_text = _ocr_concat(ocr)
            if ocr_text and not _has_tea_signal(ocr_text):
                return {
                    "state": "non_tea_product",
                    "message": ("这张图似乎不是普洱茶包装。请上传标准棉纸/笋壳/外箱/内飞的"
                                "清晰照片,我才能帮您识别。"),
                }

    # 6. unreadable_image — file too small, or image broken AND OCR DID see
    #    tea words (asset issue with a tea product photo).
    if file_size_hint is not None and file_size_hint < 10 * 1024:
        return {
            "state": "unreadable_image",
            "message": ("图片无法读取 (文件过小,可能损坏)。请重新拍照上传 JPEG/PNG "
                        "格式的原图,避免压缩到 10KB 以下。"),
        }
    if visual_result and not visual_result.get("ok"):
        reason = visual_result.get("reason") or ""
        if any(tok in reason for tok in ("image_error", "asset_missing", "ids_mismatch")):
            return {
                "state": "unreadable_image",
                "message": ("图片无法读取 (可能过暗、过曝、文件损坏或格式异常)。"
                            "请重新拍照上传,确保光线充足且对焦清晰。"),
            }

    best = (visual_result or {}).get("best") if visual_result else None
    verdicts = (visual_result or {}).get("verdicts") if visual_result else None

    def _clear_best(b):
        # USER 2026-08-25: do not hide a pipeline-chosen best behind
        # multiple_matches. Require a usable identity verdict + conf.
        if not b:
            return False
        if b.get("verdict") not in ("same_product", "same_series_variant"):
            return False
        return (b.get("confidence") or 0) >= 0.7

    # 4. multiple_matches — BEFORE low_confidence. When ≥2 same-tier verdicts
    #    within 0.05 conf AND there is no clear best, surface the tie.
    if (not _clear_best(best)) and verdicts and len(verdicts) >= 2:
        from collections import defaultdict
        by_tier = defaultdict(list)
        for v in verdicts:
            tier = v.get("verdict")
            by_tier[tier].append(v)
        for tier, vs in by_tier.items():
            if tier in ("uncertain", "different_product"):
                continue
            vs_sorted = sorted(vs, key=lambda x: -x.get("confidence", 0))
            if len(vs_sorted) >= 2 and (vs_sorted[0].get("confidence", 0)
                                        - vs_sorted[1].get("confidence", 0)) <= 0.05:
                names = "、".join(v.get("name", "?") for v in vs_sorted[:3])
                return {
                    "state": "multiple_matches",
                    "message": (f"模型给出了多个相近匹配,无法确定唯一答案:{names}。"
                                f"建议结合包装年份/唛号/批次进一步确认,或描述更多细节。"),
                }

    # 3. low_confidence — uncertain verdict OR low confidence/similarity.
    #    dino_sim trigger only fires when dino_sim is present (a missing
    #    field on best shouldn't be treated as 0, which would falsely trip
    #    every well-identified case).
    if best:
        verdict = best.get("verdict")
        conf = best.get("confidence", 0) or 0
        dino_sim = best.get("dino_sim")  # may be None — only check if present
        if verdict == "uncertain" or conf < 0.5:
            return {
                "state": "low_confidence",
                "message": ("抱歉,这张图与库内参考图差异较大,难以可靠识别。"
                            "请尝试:① 更平整/光线充足的正面照;② 包装上的唛号/"
                            "年份特写;③ 同时拍内飞 (压在内包装的小纸片)。"),
            }
        if dino_sim is not None and dino_sim < 0.5:
            return {
                "state": "low_confidence",
                "message": ("抱歉,这张图与库内参考图差异较大,难以可靠识别。"
                            "请尝试:① 更平整/光线充足的正面照;② 包装上的唛号/"
                            "年份特写;③ 同时拍内飞 (压在内包装的小纸片)。"),
            }

    # 7. conflicting_signals — visual tea_type (W3-0) vs OCR/text disagree
    if best and best.get("tea_type") in ("ripe", "raw"):
        visual_type = best["tea_type"]
        ocr_text = _ocr_concat(ocr)
        if ocr_text:
            text_says_ripe = _has_text_type_signal(ocr_text, "ripe")
            text_says_raw = _has_text_type_signal(ocr_text, "raw")
            text_type = None
            if text_says_ripe and not text_says_raw:
                text_type = "ripe"
            elif text_says_raw and not text_says_ripe:
                text_type = "raw"
            if text_type and text_type != visual_type:
                visual_cn = "熟茶" if visual_type == "ripe" else "生茶"
                text_cn = "熟茶" if text_type == "ripe" else "生茶"
                return {
                    "state": "conflicting_signals",
                    "message": (f"图示与文字描述有冲突:视觉显示是{visual_cn},"
                                f"文字标识为{text_cn}。请核对实物内飞或厂家信息。"),
                }

    return None


# ---------- self-test ----------
def _self_test():
    """14 cases — 2 per state. Run with `python3 refusal.py`."""
    img = ["/tmp/fake.jpg"]
    no_img = []
    ok_visual = {"ok": True, "best": {"verdict": "same_product",
                                       "confidence": 0.95, "skuId": "1",
                                       "name": "示例", "tea_type": "unknown"},
                 "verdicts": [{"verdict": "same_product", "confidence": 0.95,
                                "skuId": "1", "name": "示例"}]}
    uncertain = {"ok": True, "best": {"verdict": "uncertain",
                                       "confidence": 0.4, "skuId": "1",
                                       "name": "示例", "tea_type": "unknown"}}
    broken = {"ok": False, "reason": "image_error"}
    asset_missing = {"ok": False, "reason": "asset_missing:npy"}
    ocr_tea = [{"visible_text": "普洱茶饼茶", "visual_features": "棉纸"}]
    ocr_none = [{"visible_text": "卡通贴纸", "visual_features": "纪念币"}]
    ocr_ripe = [{"visible_text": "此茶为熟饼", "visual_features": ""}]
    ocr_raw = [{"visible_text": "此茶为生饼", "visual_features": ""}]

    cases = [
        # (label, qclass, imgs, visual, ocr, expected_state)
        ("abc+img", "abc", img, ok_visual, None, "out_of_scope"),
        ("abc+multi_img", "abc", img + img, ok_visual, None, "out_of_scope"),
        ("de+no_img", "de", no_img, None, None, "no_image"),
        ("abc+no_img", "abc", no_img, None, None, None),  # abc without img → answer
        ("e+no_img", "de", no_img, None, None, "no_image"),
        ("uncertain_verdict", "de", img, uncertain, None, "low_confidence"),
        ("low_confidence_05", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.3,
                                "skuId": "1", "name": "x", "tea_type": "unknown"}},
         None, "low_confidence"),
        ("two_same_tier_close", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.9,
                                "skuId": "1", "name": "A", "tea_type": "unknown"},
          "verdicts": [{"verdict": "same_product", "confidence": 0.9,
                         "skuId": "1", "name": "A"},
                        {"verdict": "same_product", "confidence": 0.88,
                         "skuId": "2", "name": "B"}]},
         None, None),  # USER 2026-08-25: clear best 0.9 must not be refused
        ("weak_best_still_mm", "de", img,
         {"ok": True, "best": {"verdict": "same_series_variant", "confidence": 0.51,
                                "skuId": "1", "name": "A", "tea_type": "unknown"},
          "verdicts": [{"verdict": "same_series_variant", "confidence": 0.51,
                         "skuId": "1", "name": "A"},
                        {"verdict": "same_series_variant", "confidence": 0.50,
                         "skuId": "2", "name": "B"}]},
         None, "multiple_matches"),
        ("two_same_tier_far_apart", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.9,
                                "skuId": "1", "name": "A", "tea_type": "unknown"},
          "verdicts": [{"verdict": "same_product", "confidence": 0.9,
                         "skuId": "1", "name": "A"},
                        {"verdict": "same_product", "confidence": 0.7,
                         "skuId": "2", "name": "B"}]},
         None, None),  # gap 0.20 → no refusal
        ("broken+no_tea_keyword", "de", img, broken, ocr_none, "non_tea_product"),
        ("asset_missing+no_tea", "de", img, asset_missing, ocr_none, "non_tea_product"),
        ("broken_image_only", "de", img, broken, None, "unreadable_image"),
        ("tiny_file", "de", img, ok_visual, None, "unreadable_image"),  # via file_size_hint
        ("visual_ripe_text_raw", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.9,
                                "skuId": "1", "name": "X", "tea_type": "ripe"}},
         ocr_raw, "conflicting_signals"),
        ("visual_raw_text_ripe", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.9,
                                "skuId": "1", "name": "X", "tea_type": "raw"}},
         ocr_ripe, "conflicting_signals"),
        ("chupin_not_raw", "de", img,
         {"ok": True, "best": {"verdict": "same_product", "confidence": 0.95,
                                "skuId": "2659", "name": "7572", "tea_type": "ripe"},
          "verdicts": [{"verdict": "same_product", "confidence": 0.95,
                         "skuId": "2659", "name": "7572"}]},
         [{"visible_text": "云南七子饼茶 勐海茶厂出品", "visual_features": "棉纸"}],
         None),
    ]

    passed = 0
    for label, qc, imgs, vis, ocr, exp in cases:
        # tiny_file passes file_size_hint via kwarg below
        if label == "tiny_file":
            r = compute_refusal(qc, imgs, vis, ocr=ocr, file_size_hint=5 * 1024)
        else:
            r = compute_refusal(qc, imgs, vis, ocr=ocr)
        got = r["state"] if r else None
        ok = got == exp
        print(f"  [{'PASS' if ok else 'FAIL'}] {label}: expected={exp} got={got}")
        if ok:
            passed += 1
    print(f"\n  {passed}/{len(cases)} passed")
    return passed == len(cases)


if __name__ == "__main__":
    import sys
    sys.exit(0 if _self_test() else 1)