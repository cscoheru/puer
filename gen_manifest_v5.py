#!/usr/bin/env python3
"""B1 offline eval manifest v5 — >=60 cases across 6 categories.

Schema (compatible with eval_offline.py):
  case_id / image_abs / query_skuId / target_sibling_skuId /
  expected_sku (alias for target) / allowed_verdicts /
  forbidden_verdicts / category / score_modes / notes

Categories:
  1. anchor-pair-distinction  (>= 10 pairs x 2 directions = 24+ cases)
  2. perspective              (10 cases from forum uploads, expect refusal)
  3. out_of_catalog           (10 cases non-tea / unseen SKU, expect refusal)
  4. partial_text             (10 cases, PIL crop 50% center or partial包装)
  5. cross_year               (>=10 cases, same anchor different year)
  6. synthetic                 (10 orig x 3 perturbations = 30 cases)

Total target: >= 60 cases.

Output: /opt/puer-hub/rag-data/eval/manifest.v5.jsonl
"""
import json
import os
import random
import shutil
import sys
from collections import defaultdict
from pathlib import Path

from PIL import Image

random.seed(42)

PDATA = "/opt/puer-hub/rag-data"
HOST_UPLOADS = "/opt/puer-hub/uploads/forum"
SYNTH_DIR = f"{PDATA}/eval/synth"        # relative to RAG_DATA
FORUM_DIR = f"{PDATA}/eval/forum"         # relative to RAG_DATA
SKUS_FILE = f"{PDATA}/donghe-skus.jsonl"
SKU_IMG_DIR = f"{PDATA}/donghe-images"
OUT = f"{PDATA}/eval/manifest.v5.jsonl"

os.makedirs(SYNTH_DIR, exist_ok=True)

# ── load SKUs ────────────────────────────────────────────────────────────────
skus = {s["skuId"]: s for s in [json.loads(l) for l in open(SKUS_FILE)]}

cases = []
cid_counter = 0


def add(
    category,
    image_abs,
    query_skuId=None,
    target_sibling_skuId=None,
    anchor=None,
    allowed_verdicts=None,
    forbidden_verdicts=None,
    expect_refusal=False,
    score_modes=None,
    notes=None,
):
    global cid_counter
    cid_counter += 1
    # expected_sku used by eval_offline._rank_target / _score_recall
    # image_path relative to RAG_DATA (/opt/puer-hub/rag-data)
    # eval_offline._resolve_image uses os.path.join(RAG_DATA, image_path)
    img_rel = None
    if image_abs.startswith(f"{SKU_IMG_DIR}/"):
        img_rel = image_abs[len(f"{SKU_IMG_DIR}/"):]   # → donghe-images/xxx.jpeg
        img_rel = f"donghe-images/{img_rel}"
    elif image_abs.startswith(f"{SYNTH_DIR}/"):
        img_rel = image_abs[len(f"{PDATA}/"):]         # → eval/synth/xxx.jpg
    elif image_abs.startswith(f"{FORUM_DIR}/"):
        img_rel = image_abs[len(f"{PDATA}/"):]         # → eval/forum/xxx.jpg
    elif image_abs.startswith(f"{HOST_UPLOADS}/"):
        # will be copied; final path will be eval/forum/xxx.jpg
        img_rel = f"eval/forum/{os.path.basename(image_abs)}"
    else:
        img_rel = image_abs  # fallback

    expected = target_sibling_skuId or query_skuId
    c = {
        "case_id": f"v5-{category}-{cid_counter:03d}",
        "image_path": img_rel,       # relative to RAG_DATA, used by eval_offline.py
        "image_abs": image_abs,      # absolute path for reference
        "image_type": "jpeg",
        "query_skuId": str(query_skuId) if query_skuId else None,
        "target_sibling_skuId": str(target_sibling_skuId) if target_sibling_skuId else None,
        "expected_sku": str(expected) if expected else None,
        "anchor": anchor,
        "category": category,
        "allowed_verdicts": allowed_verdicts or [],
        "forbidden_verdicts": forbidden_verdicts or [],
        "expect_refusal": expect_refusal,
        "score_modes": score_modes or ["recall"],
        "notes": notes or "",
    }
    cases.append(c)


# ── helpers ──────────────────────────────────────────────────────────────────
def img_path(sku_id):
    return os.path.join(SKU_IMG_DIR, f"{sku_id}.jpeg")


def sku_name(sku_id):
    return skus.get(str(sku_id), {}).get("name", "")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 1: anchor-pair-distinction (extend W4: 7 pairs → >=10 pairs)
# ════════════════════════════════════════════════════════════════════════════
# Existing pairs from pairs.json
existing_pairs = [
    # (anchor, sku_a, sku_b)
    ("越陈越香", "1933", "1705"),
    ("越陈越香", "1668", "1657"),
    ("咖啡大益", "3087", "2608"),
    ("大益唛号", "3087", "9505"),
    ("八角亭",  "5878", "5666"),
    ("八角亭",  "5878", "6712"),
    ("班章",    "1795", "9388"),
]

# New pairs: same anchor, different SKU, both with donghe-images
new_pairs = [
    # 7542 pairs
    ("7542", "2690", "2831"),  # 1701 vs 1901
    ("7542", "2831", "2203"),  # 1901 vs 2010
    # 金大益 pairs
    ("金大益", "2705", "1645"),  # 1701 vs 101
    ("金大益", "1645", "2123"),  # 101 vs 301
    # 越陈越香 extra pairs
    ("越陈越香", "2602", "1665"),  # 1601 vs 101珍藏版
    ("越陈越香", "1668", "2602"),  # 001 vs 1601
    # 7572 pairs
    ("7572", "2176", "2139"),  # 001 vs 2004
]

all_pairs = existing_pairs + new_pairs

for anchor, sku_a, sku_b in all_pairs:
    path_a = img_path(sku_a)
    path_b = img_path(sku_b)
    name_a = sku_name(sku_a)
    name_b = sku_name(sku_b)

    if not os.path.exists(path_a) or not os.path.exists(path_b):
        print(f"  SKIP {anchor} {sku_a}/{sku_b} — image missing", file=sys.stderr)
        continue

    # A → B: query A, expect sibling B
    add(
        category="anchor-pair-distinction",
        image_abs=path_a,
        query_skuId=sku_a,
        target_sibling_skuId=sku_b,
        anchor=anchor,
        allowed_verdicts=["same_series_variant", "uncertain"],
        forbidden_verdicts=["same_product"],
        score_modes=["recall"],
        notes=f"anchor-pair {anchor}: query {sku_a}({name_a}) vs sibling {sku_b}({name_b})",
    )
    # B → A
    add(
        category="anchor-pair-distinction",
        image_abs=path_b,
        query_skuId=sku_b,
        target_sibling_skuId=sku_a,
        anchor=anchor,
        allowed_verdicts=["same_series_variant", "uncertain"],
        forbidden_verdicts=["same_product"],
        score_modes=["recall"],
        notes=f"anchor-pair {anchor}: query {sku_b}({name_b}) vs sibling {sku_a}({name_a})",
    )

print(f"  anchor-pair: {sum(1 for c in cases if c['category']=='anchor-pair-distinction')} cases")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 2: perspective (phone oblique shots from forum uploads)
# ════════════════════════════════════════════════════════════════════════════
forum_jpgs = sorted([
    os.path.join(HOST_UPLOADS, f)
    for f in os.listdir(HOST_UPLOADS)
    if f.endswith(".jpg")
])
# Pick 10 diverse forum images
random.shuffle(forum_jpgs)
persp_imgs = forum_jpgs[:10]

for fp in persp_imgs:
    fname = os.path.basename(fp)
    # copy to eval/forum/ so _resolve_image can find it
    dest = os.path.join(FORUM_DIR, fname)
    shutil.copy2(fp, dest)
    add(
        category="perspective",
        image_abs=dest,
        query_skuId=None,
        target_sibling_skuId=None,
        anchor=None,
        expect_refusal=True,
        score_modes=["recall"],
        notes=f"forum upload perspective shot: {fname}",
    )

print(f"  perspective: {sum(1 for c in cases if c['category']=='perspective')} cases")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 3: out_of_catalog (non-tea / unseen SKU — expect refusal)
# ════════════════════════════════════════════════════════════════════════════
# Re-use more forum images (already shuffled, skip first 10)
ooc_imgs = forum_jpgs[10:20]

for fp in ooc_imgs:
    fname = os.path.basename(fp)
    # copy to eval/forum/ so _resolve_image can find it
    dest = os.path.join(FORUM_DIR, fname)
    shutil.copy2(fp, dest)
    add(
        category="out_of_catalog",
        image_abs=dest,
        query_skuId=None,
        target_sibling_skuId=None,
        anchor=None,
        expect_refusal=True,
        score_modes=["recall"],
        notes=f"out-of-catalog / non-tea forum image: {fname}",
    )

print(f"  out_of_catalog: {sum(1 for c in cases if c['category']=='out_of_catalog')} cases")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 4: partial_text (50% center crop — synthetic degradation)
# ════════════════════════════════════════════════════════════════════════════
# Pick 10 donghe-images for partial_text (must be wide enough to crop)
partial_candidates = [
    "1933", "1705", "1668", "1657", "3087", "2608",
    "2690", "2831", "2705", "1645",
]

for sku_id in partial_candidates:
    src = img_path(sku_id)
    if not os.path.exists(src):
        continue
    try:
        img = Image.open(src)
        w, h = img.size
        # 50% center crop
        crop_w, crop_h = w // 2, h // 2
        left = (w - crop_w) // 2
        top = (h - crop_h) // 2
        cropped = img.crop((left, top, left + crop_w, top + crop_h))
        out_name = f"partial_{sku_id}.jpg"
        out_path = os.path.join(SYNTH_DIR, out_name)
        cropped.save(out_path, "JPEG", quality=90)
        add(
            category="partial_text",
            image_abs=out_path,
            query_skuId=sku_id,
            target_sibling_skuId=None,
            anchor=sku_name(sku_id).split()[0] if sku_name(sku_id) else None,
            expect_refusal=False,  # partial still matches, just harder
            score_modes=["recall"],
            notes=f"50%% center crop of SKU {sku_id} ({sku_name(sku_id)})",
        )
    except Exception as e:
        print(f"  partial_text skip {sku_id}: {e}", file=sys.stderr)

print(f"  partial_text: {sum(1 for c in cases if c['category']=='partial_text')} cases")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 5: cross_year (same anchor, different years — subset of anchor-pair)
# ════════════════════════════════════════════════════════════════════════════
# Build year-aware pairs for anchors with multiple year variants
cross_year_pairs = [
    # 越陈越香 — different years
    ("越陈越香", "1668", "2602"),  # 001 vs 1601
    ("越陈越香", "1657", "1668"),  # 901 vs 001
    ("越陈越香", "1933", "1668"),  # 2004 vs 001
    ("越陈越香", "1705", "2602"),  # 701 vs 1601
    ("越陈越香", "1933", "1657"),  # 2004 vs 901
    # 7542 — year variants
    ("7542", "2690", "2203"),   # 1701 vs 2010
    ("7542", "2831", "2203"),   # 1901 vs 2010
    ("7542", "2690", "2831"),  # 1701 vs 1901
    # 金大益 — year variants
    ("金大益", "2705", "2123"),  # 1701 vs 301
    ("金大益", "1645", "2123"),  # 101 vs 301
    # 7572 — year variants
    ("7572", "2176", "2139"),  # 001 vs 2004
]

for anchor, sku_a, sku_b in cross_year_pairs:
    path_a = img_path(sku_a)
    path_b = img_path(sku_b)
    if not os.path.exists(path_a) or not os.path.exists(path_b):
        continue
    name_a = sku_name(sku_a)
    name_b = sku_name(sku_b)
    add(
        category="cross_year",
        image_abs=path_a,
        query_skuId=sku_a,
        target_sibling_skuId=sku_b,
        anchor=anchor,
        allowed_verdicts=["same_series_variant", "uncertain"],
        forbidden_verdicts=["same_product"],
        score_modes=["recall"],
        notes=f"cross_year {anchor}: {sku_a}({name_a}) vs {sku_b}({name_b})",
    )
    add(
        category="cross_year",
        image_abs=path_b,
        query_skuId=sku_b,
        target_sibling_skuId=sku_a,
        anchor=anchor,
        allowed_verdicts=["same_series_variant", "uncertain"],
        forbidden_verdicts=["same_product"],
        score_modes=["recall"],
        notes=f"cross_year {anchor}: {sku_b}({name_b}) vs {sku_a}({name_a})",
    )

print(f"  cross_year: {sum(1 for c in cases if c['category']=='cross_year')} cases")


# ════════════════════════════════════════════════════════════════════════════
# CATEGORY 6: synthetic (10 orig × 3 perturbations — rotate / jpeg-q30 / crop)
# ════════════════════════════════════════════════════════════════════════════
synth_orig = [
    "1933", "1705", "1668", "1657", "3087",
    "2608", "2690", "2831", "2705", "1645",
]

for sku_id in synth_orig:
    src = img_path(sku_id)
    if not os.path.exists(src):
        continue
    name = sku_name(sku_id)
    base = f"synth_{sku_id}"

    # 1. rotate +15 deg
    try:
        img = Image.open(src)
        rotated = img.rotate(15, expand=True, fillcolor=(255, 255, 255))
        out1 = os.path.join(SYNTH_DIR, f"{base}_rot15.jpg")
        rotated.save(out1, "JPEG", quality=92)
        add(
            category="synthetic",
            image_abs=out1,
            query_skuId=sku_id,
            target_sibling_skuId=None,
            anchor=name.split()[0] if name else None,
            score_modes=["recall"],
            notes=f"synthetic rotate+15deg of SKU {sku_id} ({name})",
        )
    except Exception as e:
        print(f"  synth rotate skip {sku_id}: {e}", file=sys.stderr)

    # 2. rotate -15 deg
    try:
        img = Image.open(src)
        rotated = img.rotate(-15, expand=True, fillcolor=(255, 255, 255))
        out2 = os.path.join(SYNTH_DIR, f"{base}_rot-15.jpg")
        rotated.save(out2, "JPEG", quality=92)
        add(
            category="synthetic",
            image_abs=out2,
            query_skuId=sku_id,
            target_sibling_skuId=None,
            anchor=name.split()[0] if name else None,
            score_modes=["recall"],
            notes=f"synthetic rotate-15deg of SKU {sku_id} ({name})",
        )
    except Exception as e:
        print(f"  synth rot-15 skip {sku_id}: {e}", file=sys.stderr)

    # 3. JPEG quality 30
    try:
        img = Image.open(src)
        out3 = os.path.join(SYNTH_DIR, f"{base}_q30.jpg")
        img.save(out3, "JPEG", quality=30, optimize=False)
        add(
            category="synthetic",
            image_abs=out3,
            query_skuId=sku_id,
            target_sibling_skuId=None,
            anchor=name.split()[0] if name else None,
            score_modes=["recall"],
            notes=f"synthetic jpeg-q30 of SKU {sku_id} ({name})",
        )
    except Exception as e:
        print(f"  synth q30 skip {sku_id}: {e}", file=sys.stderr)

print(f"  synthetic: {sum(1 for c in cases if c['category']=='synthetic')} cases")


# ════════════════════════════════════════════════════════════════════════════
# Write manifest
# ════════════════════════════════════════════════════════════════════════════
assert len(cases) >= 60, f"need >=60 cases, got {len(cases)}"

from collections import Counter
cat_counts = Counter(c["category"] for c in cases)
print(f"\ntotal: {len(cases)} cases")
for k, v in sorted(cat_counts.items()):
    print(f"  {k}: {v}")

os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    for c in cases:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")

print(f"\nwritten: {OUT}")
