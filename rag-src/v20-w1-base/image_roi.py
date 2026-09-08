#!/usr/bin/env python3
"""B4 ROI crop PoC — 找出 user upload 中的最大矩形主区域，失败 fallback 原图。

输入 user path → 输出 crop path（OpenCV 轮廓 / 最大矩形，失败 fallback 原图）。
设计目标：缩小 DINO/CLIP 关注区，避开大面积背景干扰。

策略：
1. OpenCV 读图 → 转灰度 → Otsu 自适应阈值分前景/背景
2. 找外轮廓 → 取面积最大的凸包 → 外接矩形 = crop bbox
3. 边长裁剪（短边 < 0.6 × 长边）→ fallback 原图（避免过度裁剪）
4. 失败（无 cv2 / 读图错）→ fallback 原图
"""
import os
import sys
from typing import Optional, Tuple

try:
    import cv2
    import numpy as np
    _CV2_OK = True
except Exception:
    _CV2_OK = False


ROI_MIN_AREA_RATIO = 0.20  # crop area / image area 最低 20%
ROI_ASPECT_RATIO = 0.6     # 短边/长边 最低 0.6 (避免过扁)
ROI_PADDING = 0.05         # bbox 外扩 5%


def find_roi(image_path: str) -> Optional[Tuple[int, int, int, int]]:
    """Return (x, y, w, h) of dominant region bbox, or None on fallback."""
    if not _CV2_OK:
        return None
    try:
        img = cv2.imread(image_path)
        if img is None:
            return None
        h0, w0 = img.shape[:2]
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        # BINARY_INV so dark subject is foreground (white=255) and
        # findContours picks the subject's outline, not the background ring.
        _, th = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
        th = cv2.morphologyEx(th, cv2.MORPH_CLOSE, kernel, iterations=2)
        th = cv2.morphologyEx(th, cv2.MORPH_OPEN, kernel, iterations=1)
        contours, _ = cv2.findContours(th, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if not contours:
            return None
        cnt = max(contours, key=cv2.contourArea)
        area = cv2.contourArea(cnt)
        if area < ROI_MIN_AREA_RATIO * h0 * w0:
            return None
        x, y, w, h = cv2.boundingRect(cnt)
        if w < ROI_ASPECT_RATIO * h or h < ROI_ASPECT_RATIO * w:
            return None
        px = int(w * ROI_PADDING); py = int(h * ROI_PADDING)
        x = max(0, x - px); y = max(0, y - py)
        w = min(w0 - x, w + 2 * px); h = min(h0 - y, h + 2 * py)
        return (x, y, w, h)
    except Exception:
        return None


def crop_image(image_path: str, output_path: str) -> Optional[str]:
    """Crop image using find_roi, save to output_path. Return path or None on fallback."""
    bbox = find_roi(image_path)
    if bbox is None:
        return None
    if not _CV2_OK:
        return None
    try:
        img = cv2.imread(image_path)
        if img is None:
            return None
        x, y, w, h = bbox
        cropped = img[y:y + h, x:x + w]
        os.makedirs(os.path.dirname(output_path), exist_ok=True)
        cv2.imwrite(output_path, cropped)
        return output_path
    except Exception:
        return None


def _self_test():
    """3 cases: synthetic image with rectangle, plain image, missing file."""
    import tempfile
    if not _CV2_OK:
        print("[self-test roi] cv2 unavailable, skip")
        return
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        img = np.full((400, 400, 3), 255, dtype=np.uint8)
        cv2.rectangle(img, (60, 60), (340, 340), (50, 50, 50), -1)
        cv2.imwrite(f.name, img)
        bbox = find_roi(f.name)
        assert bbox is not None, "case1 expect bbox"
        x, y, w, h = bbox
        # rect was (60..340) ~280x280 = 70% area; with padding should be wider
        assert 40 <= x <= 80 and 40 <= y <= 80, f"x,y={x},{y} out of expected"
        assert 280 <= w + x <= 360 and 280 <= h + y <= 360, f"x+w,y+h={x+w},{y+h}"
        print(f"[self-test roi] case1 synthetic square bbox=({x},{y},{w},{h}) OK")
        os.unlink(f.name)

    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        img = np.full((200, 200, 3), 128, dtype=np.uint8)
        cv2.imwrite(f.name, img)
        bbox = find_roi(f.name)
        assert bbox is None, f"case2 expect None, got {bbox}"
        print("[self-test roi] case2 uniform image None OK")
        os.unlink(f.name)

    bbox = find_roi("/nonexistent/path.jpg")
    assert bbox is None
    print("[self-test roi] case3 missing file None OK")
    print("[self-test roi] 3/3 PASS")


if __name__ == "__main__":
    _self_test()