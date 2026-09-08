#!/usr/bin/env python3
"""Stage-1 clue extraction for image questions: teacher VLM reads the image.

Iron rule — READ, DON'T GUESS: the prompt forbids inferring factory/era/mark
numbers; only verbatim transcription of visible text (tagging illegible /
occluded spans) plus objective visual features (colors, layout). Identity
claims must come from retrieval, never from this stage.
"""
import json
import os
import re

from teacher_api import ask_vision

# Optional explicit lead provider (RAG_OCR_PROVIDER); the chain continues
# through teacher_api.VISION_CHAIN afterwards. Never set it to deepseek (no vision).
OCR_PROVIDER = os.environ.get("RAG_OCR_PROVIDER") or None

SYSTEM = ("你是图像文字转录助手。只转录与客观描述,严禁推测身份、厂家、年代、唛号。"
          "所有输出一律用简体中文(图中为繁体也转写为简体)。")

PROMPT = """逐项转录这张图片,输出一个 JSON 对象(不要输出其他内容):
{
  "visible_text": "图中所有可见文字,按主要阅读顺序拼接。环绕边缘的小字、生产单位落款、编号数字也要尽力逐字细读;单个字读不清才写[模糊],被遮挡写[遮挡];严禁补全或猜测文字",
  "visual_features": "客观视觉特征2-3句:主色调、版式布局、字体颜色(如'茶字为黄色')、纸张/器物状态;禁止推断含义",
  "obscured": ["看不清或被遮挡的关键区域列表,没有则空数组"]
}
再次强调:不许推断厂家、品牌、年代、唛号;图上没有的字一个都不许出现。"""


def _parse_json_sloppy(text):
    """Teachers usually comply; tolerate ```json fences and trailing prose."""
    text = text.strip()
    m = re.search(r"\{.*\}", text, flags=re.S)
    if not m:
        return None
    try:
        return json.loads(m.group(0))
    except json.JSONDecodeError:
        return None


def _upscale_for_ocr(path, min_side=1600, max_side=1600, quality=85):
    """Normalize the image for the VLM. Two directions:
    - upscale 2x when the long side is under min_side (small wrapper print
      becomes legible);
    - DOWNSCALE to max_side otherwise — the GLM anthropic-compat layer silently
      drops large base64 images (model thinking: "I can't actually see the
      image"); ~1600px/q85 lands around 400-600KB, inside every provider's
      comfort zone, and wrapper print stays fully legible."""
    from PIL import Image
    import os
    im = Image.open(path).convert("RGB")
    long_side = max(im.size)
    if min_side <= long_side <= max_side:
        # already in the sweet zone but may still be multi-MB — re-encode
        # (3024px @ q92 ≈ 900KB+ still trips the GLM compat layer)
        if os.path.getsize(path) <= 700 * 1024:
            return path, False
        scale = 1.0
    elif long_side > max_side:
        scale = max_side / long_side
    else:
        scale = 2
    im2 = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))),
                    Image.LANCZOS)
    import tempfile, os
    fd, tmp = tempfile.mkstemp(suffix=".jpg")
    os.close(fd)
    im2.save(tmp, quality=quality)
    return tmp, True


_REFUSAL = re.compile(r"无法辨认|未能成功加载|无法确认|无法提供|无法识别|无法获取|无法进行")


def _is_useful(parsed, require_text=False):
    """Accept only when there is real content: visible text beyond the
    [模糊]/[遮挡] placeholders, or usable visual features — and no refusal
    boilerplate (GLM occasionally declines the whole image).
    require_text: caller demands actual readable text (VLM reads are
    non-deterministic — re-rolling for text beats accepting a 模糊-only read)."""
    vt = re.sub(r"\[模糊\]|\[遮挡\]", "", parsed.get("visible_text", "")).strip()
    vf = parsed.get("visual_features", "") or ""
    if _REFUSAL.search(vf) or _REFUSAL.search(parsed.get("visible_text", "")):
        return False
    if require_text and not vt:
        return False
    return bool(vt) or (vf.strip() and not _REFUSAL.search(vf))


def extract(path):
    """Returns {'visible_text': str, 'visual_features': str, 'obscured': [..]}.
    Retries up to 3 times for a useful read (VLM reads are non-deterministic);
    returns an empty-features dict only if all attempts fail."""
    ocr_path, is_tmp = _upscale_for_ocr(path)
    try:
        # Provider order: retry the PROVEN reader (kimi reads wrapper print
        # verbatim) before falling back. GLM is demoted out of the rotation —
        # its anthropic-compat layer silently drops images and it then INVENTS
        # a template wrapper ("中心书法体茶字") that passes the require-text
        # gate and reads as confident nonsense to the user.
        # Attempts 0-1 demand readable TEXT; attempt 2 accepts features-only.
        import teacher_api
        lead = OCR_PROVIDER or "kimi"
        order = [p for p in [lead, lead, "bailian", lead]
                 if p in teacher_api.PROVIDERS]
        for i in range(4):
            prov = order[i] if i < len(order) else order[-1]
            out, _used = ask_vision(PROMPT, images=[ocr_path], system=SYSTEM,
                                    max_tokens=2000, providers=[prov])
            if not out:
                continue
            parsed = _parse_json_sloppy(out)
            # attempts 0-1: lead provider must produce TEXT; attempt 2: backup
            # vision provider, features-only OK; attempt 3: lead again, the
            # honest features-only degrade (a bare cake face has no text!)
            if parsed and _is_useful(parsed, require_text=(i < 2)):
                return {
                    "visible_text": str(parsed.get("visible_text", "")).strip(),
                    "visual_features": str(parsed.get("visual_features", "")).strip(),
                    "obscured": parsed.get("obscured") or [],
                    "ocr_provider": prov,
                }
    finally:
        if is_tmp:
            import os
            os.unlink(ocr_path)
    return {"visible_text": "", "visual_features": "", "obscured": ["extraction_failed"]}


if __name__ == "__main__":
    import sys
    p = sys.argv[1] if len(sys.argv) > 1 else "../eval/images/N009.jpg"
    r = extract(p)
    print(json.dumps(r, ensure_ascii=False, indent=2))
