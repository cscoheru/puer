#!/usr/bin/env python3
"""Generate W1-3 manifest.v1.jsonl from rag-data inventory + synthesized variants.

Run on HOST (Python 3, stdlib + PIL + ffmpeg). Reads /opt/puer-hub/rag-data/
donghe-skus.jsonl via SSH or local if path is reachable. Writes:
  /tmp/w1-edit/eval/manifest.v1.jsonl
  /tmp/w1-edit/eval/synth/*.jpg     (synthesized variants — must be scp'd to host)
  /tmp/w1-edit/eval/heic/*          (HEIC inputs — test.heic + derived)

Idempotent: re-running overwrites.
"""
import collections
import hashlib
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile

from PIL import Image, ImageFilter, ImageEnhance

random.seed(20260821)  # reproducible sampling

# Output dirs (override OUT_DIR to stage on a different host, e.g. server).
OUT_DIR = os.environ.get("OUT_DIR", "/tmp/w1-edit/eval")
SYNTH_DIR = f"{OUT_DIR}/synth"
HEIC_DIR = f"{OUT_DIR}/heic"
MANIFEST = f"{OUT_DIR}/manifest.v1.jsonl"

# When OUT_DIR != /tmp/w1-edit/eval, treat rag-data as local to the runner.
# Default = server-style layout; local Mac mounts can override via env.
RAG_DATA_HOST = os.environ.get("RAG_DATA_HOST", "/opt/puer-hub/rag-data")
SKUS_PATH = f"{RAG_DATA_HOST}/donghe-skus.jsonl"
IMG_DIR = f"{RAG_DATA_HOST}/donghe-images"

# 4 must-include regression cases
MUST_INCLUDE = [
    {
        "case_id": "jindayi-2501-reissue-001",
        "image_path": "donghe-images/9505.jpeg",
        "image_abs": f"{IMG_DIR}/9505.jpeg",
        "image_type": "jpeg",
        "ocr_text": "",
        "expected_sku": "9505",
        "expected_name": "2501 金大益",
        "expected_year": "2025",
        "allowed_verdicts": ["same_product"],
        "forbidden_verdicts": ["different_product"],
        "category": "cross-year-reissue",
        "tags": ["must-include", "w1-2-regression"],
        "score_modes": ["recall", "verdict"],
        "notes": "W1-2 backfill 闭环：9505 必须进候选池且 dino_rank<=2",
    },
]

SYNTH_NOTE = "PIL-synthesized variant for damage / quality robustness"


def _load_skus():
    rows = []
    with open(SKUS_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def _has_image(sku_id: str) -> bool:
    return os.path.exists(f"{IMG_DIR}/{sku_id}.jpeg")


def _sha1(p):
    h = hashlib.sha1()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _save_synth(case_id: str, src: str, transform) -> str:
    """Run transform(PIL.Image) and save to SYNTH_DIR/{case_id}.jpg."""
    os.makedirs(SYNTH_DIR, exist_ok=True)
    out = f"{SYNTH_DIR}/{case_id}.jpg"
    img = Image.open(src).convert("RGB")
    img = transform(img)
    img.save(out, "JPEG", quality=85)
    return out


def _ffmpeg_heic_derived(src: str, case_id: str, vf: str) -> str:
    """Re-encode HEIC → JPEG with ffmpeg filter chain. Saved to HEIC_DIR/
    {case_id}.jpg — image_type=heic, but file is JPEG. Rationale: HEIC path
    in production is decode→JPEG→compare(), so we exercise that pipeline."""
    os.makedirs(HEIC_DIR, exist_ok=True)
    out = f"{HEIC_DIR}/{case_id}.jpg"
    subprocess.run(["ffmpeg", "-y", "-i", src, "-vf", vf, "-q:v", "3", out],
                   check=True, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, timeout=60)
    return out


def _add_case(cases: list, **kw):
    """Mandatory fields for the manifest schema. image_abs uses container path."""
    rec = {
        "image_path": kw["image_path"],
        "image_abs": kw.get("image_abs") or f"/data/{kw['image_path']}",
        "image_type": kw.get("image_type", "jpeg"),
        "ocr_text": kw.get("ocr_text", ""),
        "expected_sku": kw.get("expected_sku"),
        "expected_name": kw.get("expected_name"),
        "expected_year": kw.get("expected_year"),
        "allowed_verdicts": kw.get("allowed_verdicts", []),
        "forbidden_verdicts": kw.get("forbidden_verdicts", []),
        "category": kw["category"],
        "tags": kw.get("tags", []),
        "score_modes": kw.get("score_modes", ["recall"]),
        "notes": kw.get("notes", ""),
        "case_id": kw["case_id"],
    }
    cases.append(rec)
    return rec


def main():
    if not os.path.exists(SKUS_PATH):
        sys.exit(f"FATAL: missing {SKUS_PATH} (run from a host with the rag-data mount)")
    os.makedirs(OUT_DIR, exist_ok=True)
    skus = _load_skus()
    skus_with_img = [s for s in skus if _has_image(s["skuId"])]
    print(f"skus total={len(skus)}  with_image={len(skus_with_img)}",
          file=sys.stderr)

    cases = []
    seen_ids = set()

    # ── 1. Positive controls: 30 random SKUs with images
    pool = random.sample(skus_with_img, min(30, len(skus_with_img)))
    for s in pool:
        cid = f"pos-{s['skuId']}"
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        _add_case(cases,
                  case_id=cid,
                  image_path=f"donghe-images/{s['skuId']}.jpeg",
                  image_abs=f"{IMG_DIR}/{s['skuId']}.jpeg",
                  image_type="jpeg",
                  expected_sku=s["skuId"],
                  expected_name=s.get("name"),
                  expected_year=s.get("year"),
                  allowed_verdicts=["same_product"],
                  forbidden_verdicts=[],
                  category="positive-control",
                  tags=["self-match"],
                  notes="单 SKU 自匹配基线")
    print(f"after positive-control: {len(cases)}", file=sys.stderr)

    # ── 1b. Must-include #1 (jindayi-2501-reissue): W1-2 backfill self-match
    # regression. Use the W1-2-backfilled 9505.jpeg reference itself as the
    # test image. If compare() doesn't put 9505 in the pool or ranks it
    # poorly, the backfill regressed.
    cid = "jindayi-2501-reissue-001"
    if cid not in seen_ids and _has_image("9505"):
        seen_ids.add(cid)
        _add_case(cases,
                  case_id=cid,
                  image_path="donghe-images/9505.jpeg",
                  image_abs=f"{IMG_DIR}/9505.jpeg",
                  image_type="jpeg",
                  expected_sku="9505",
                  expected_name="2501 金大益",
                  expected_year="2025",
                  allowed_verdicts=["same_product"],
                  forbidden_verdicts=["different_product"],
                  category="cross-year-reissue",
                  tags=["must-include", "w1-2-regression"],
                  score_modes=["recall", "verdict"],
                  notes="W1-2 backfill 闭环：9505 必须进候选池且 dino_rank<=2")
    print(f"after must-include (jindayi): {len(cases)}", file=sys.stderr)

    # ── 2. Same-series: cluster by name-prefix (heuristic: drop year digits)
    # Group SKUs whose first 4 chars of name are identical
    series_groups = collections.defaultdict(list)
    for s in skus_with_img:
        n = (s.get("name") or "").strip()
        if len(n) < 4:
            continue
        # Pull a brand-y prefix: first 4-6 chars until first digit/space
        pref = ""
        for c in n:
            if c.isdigit() or c.isspace():
                break
            pref += c
        if 2 <= len(pref) <= 8:
            series_groups[pref].append(s)

    # Take 3 largest groups, up to 6 SKUs each = 18 cases
    top_series = sorted(series_groups.items(), key=lambda kv: -len(kv[1]))[:3]
    for pref, group in top_series:
        sample = random.sample(group, min(6, len(group)))
        for s in sample:
            cid = f"series-{pref}-{s['skuId']}"
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            _add_case(cases,
                      case_id=cid,
                      image_path=f"donghe-images/{s['skuId']}.jpeg",
                      image_abs=f"{IMG_DIR}/{s['skuId']}.jpeg",
                      image_type="jpeg",
                      expected_sku=s["skuId"],
                      expected_name=s.get("name"),
                      expected_year=s.get("year"),
                      allowed_verdicts=["same_product", "same_series_variant"],
                      forbidden_verdicts=[],
                      category="same-series",
                      tags=["series-recall"],
                      notes=f"系列 {pref}: 期望 sibling SKU 进候选池")
    print(f"after same-series: {len(cases)} (top series: "
          f"{[(p, len(g)) for p, g in top_series]})", file=sys.stderr)

    # ── 3. Cross-year reissues: SKUs whose name appears 2+ times with
    # different years
    by_name = collections.defaultdict(list)
    for s in skus_with_img:
        n = (s.get("name") or "").strip()
        # Brand core: strip leading digits/years
        core = n.lstrip("0123456789").strip()
        if len(core) >= 3:
            by_name[core].append(s)
    multi_year = [(n, g) for n, g in by_name.items()
                  if len({(s.get("year") or "") for s in g}) >= 2]
    random.shuffle(multi_year)
    cross_added = 0
    for core, group in multi_year:
        if cross_added >= 10:
            break
        s = random.choice(group)
        cid = f"reissue-{core[:6]}-{s['skuId']}"
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        _add_case(cases,
                  case_id=cid,
                  image_path=f"donghe-images/{s['skuId']}.jpeg",
                  image_abs=f"{IMG_DIR}/{s['skuId']}.jpeg",
                  image_type="jpeg",
                  expected_sku=s["skuId"],
                  expected_name=s.get("name"),
                  expected_year=s.get("year"),
                  allowed_verdicts=["same_product", "same_series_variant"],
                  forbidden_verdicts=[],
                  category="cross-year-reissue",
                  tags=["reissue"],
                  notes=f"跨年复刻 {core}: 期望同唛号异年款进候选池")
        cross_added += 1
    print(f"after cross-year: {len(cases)} (multi_year groups={len(multi_year)})",
          file=sys.stderr)

    # ── 4. Damage variants: 15 (5 base × 3 modes)
    base_pool = random.sample(skus_with_img, 5)
    damage_modes = [
        ("blur2",  lambda img: img.filter(ImageFilter.GaussianBlur(radius=2))),
        ("dark",   lambda img: ImageEnhance.Brightness(img).enhance(0.4)),
        ("bright", lambda img: ImageEnhance.Brightness(img).enhance(1.6)),
    ]
    dmg_added = 0
    for s in base_pool:
        for tag, t in damage_modes:
            if dmg_added >= 15:
                break
            cid = f"dmg-{tag}-{s['skuId']}"
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            src = f"{IMG_DIR}/{s['skuId']}.jpeg"
            try:
                sp = _save_synth(cid, src, t)
            except Exception as e:
                print(f"  skip synth {cid}: {e}", file=sys.stderr)
                continue
            _add_case(cases,
                      case_id=cid,
                      image_path=f"eval/synth/{cid}.jpg",
                      image_abs=sp,  # host temp path; will be scp'd to /data/eval/synth/
                      image_type="jpeg",
                      expected_sku=s["skuId"],
                      expected_name=s.get("name"),
                      expected_year=s.get("year"),
                      allowed_verdicts=["same_product", "same_series_variant"],
                      forbidden_verdicts=[],
                      category="damage-variant",
                      tags=["damage"],
                      notes=f"{SYNTH_NOTE} ({tag})")
            dmg_added += 1
    print(f"after damage: {len(cases)}", file=sys.stderr)

    # ── 5. Out-of-vault: 10 unique images from uploads/forum
    forum_dir = "/opt/puer-hub/uploads/forum"
    forum_files = []
    if os.path.exists(forum_dir):
        seen_hashes = set()
        for fn in sorted(os.listdir(forum_dir)):
            p = os.path.join(forum_dir, fn)
            if not os.path.isfile(p):
                continue
            try:
                h = _sha1(p)
            except Exception:
                continue
            if h in seen_hashes:
                continue
            seen_hashes.add(h)
            forum_files.append(p)
        random.shuffle(forum_files)
    for p in forum_files[:10]:
        cid = f"oov-{os.path.basename(p)[:8]}"
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        # Out-of-vault: expected_sku=None; we expect either different_product
        # or no confident verdict.
        _add_case(cases,
                  case_id=cid,
                  image_path=f"uploads/forum/{os.path.basename(p)}",
                  image_abs=p,
                  image_type="jpeg",
                  expected_sku=None,
                  expected_name=None,
                  expected_year=None,
                  allowed_verdicts=["different_product", "uncertain"],
                  forbidden_verdicts=["same_product"],
                  category="out-of-vault",
                  tags=["negative-control"],
                  notes="用户上传非匹配图（dedup by sha1）；期望不报 same_product")
    print(f"after out-of-vault: {len(cases)} (forum files unique={len(forum_files)})",
          file=sys.stderr)

    # ── 6. Multi-angle: 10 base images with EXIF-rotation / horizontal flip
    multi_pool = random.sample(skus_with_img, 10)
    for s in multi_pool:
        cid = f"angle-flip-{s['skuId']}"
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        src = f"{IMG_DIR}/{s['skuId']}.jpeg"
        try:
            sp = _save_synth(cid, src, lambda img: img.transpose(Image.FLIP_LEFT_RIGHT))
        except Exception:
            continue
        _add_case(cases,
                  case_id=cid,
                  image_path=f"eval/synth/{cid}.jpg",
                  image_abs=sp,
                  image_type="jpeg",
                  expected_sku=s["skuId"],
                  expected_name=s.get("name"),
                  expected_year=s.get("year"),
                  allowed_verdicts=["same_product", "same_series_variant"],
                  forbidden_verdicts=[],
                  category="multi-angle",
                  tags=["angle-variation"],
                  notes="水平翻转：期望 dino 池稳定")
    print(f"after multi-angle: {len(cases)}", file=sys.stderr)

    # ── 7. HEIC: 1 real test.heic + derived (best-effort).
    # Server-side ffmpeg (4.4.2) lacks HEIC decoder; Mac (8.1) has it.
    # Derived variants are best-effort: skip silently if decode fails.
    # The container's ffmpeg can decode HEIC and will be tested end-to-end
    # via the manifest-driven scorer anyway.
    test_heic_src = "/tmp/w1-edit/test.heic"
    if os.path.exists(test_heic_src):
        os.makedirs(HEIC_DIR, exist_ok=True)
        heic_dest = f"{HEIC_DIR}/test.heic"
        if not os.path.exists(heic_dest):
            shutil.copy(test_heic_src, heic_dest)
        cid = "heic-real-test"
        if cid not in seen_ids:
            seen_ids.add(cid)
            _add_case(cases,
                      case_id=cid,
                      image_path="eval/heic/test.heic",
                      image_abs=heic_dest,
                      image_type="heic",
                      expected_sku=None,
                      expected_name=None,
                      expected_year=None,
                      allowed_verdicts=[],
                      forbidden_verdicts=[],
                      category="heic",
                      tags=["must-include", "w1-5-regression"],
                      score_modes=["recall"],
                      notes="真实 iPhone HEIC，验证 ffmpeg 解码 + 进入候选池")
        # Derived (ffmpeg filter chains, output as jpeg for container)
        for tag, vf in [
            ("rotate90", "transpose=1"),
            ("scale512", "scale=512:-1"),
            ("bright05", "eq=brightness=-0.3"),
        ]:
            cid = f"heic-derived-{tag}"
            if cid in seen_ids:
                continue
            seen_ids.add(cid)
            try:
                sp = _ffmpeg_heic_derived(test_heic_src, cid, vf)
            except Exception as e:
                print(f"  skip heic {cid}: {e}", file=sys.stderr)
                continue
            _add_case(cases,
                      case_id=cid,
                      image_path=f"eval/heic/{cid}.jpg",
                      image_abs=sp,
                      image_type="heic",  # tag triggers ffmpeg path
                      expected_sku=None,
                      expected_name=None,
                      expected_year=None,
                      allowed_verdicts=[],
                      forbidden_verdicts=[],
                      category="heic",
                      tags=["heic-derived"],
                      notes=f"HEIC → JPEG 经 {vf} 滤镜")
    print(f"after heic: {len(cases)}", file=sys.stderr)

    # ── 8. Quality-boundary: 5 cases (tiny / compressed / grayscale)
    qb_pool = random.sample(skus_with_img, 5)
    qb_modes = [
        ("tiny224", lambda img: img.resize((224, 224), Image.BILINEAR)),
        ("q20",     lambda img: _recompress(img, 20)),
        ("gray",    lambda img: img.convert("L").convert("RGB")),
        ("tiny128", lambda img: img.resize((128, 128), Image.BILINEAR)),
        ("flip-vert", lambda img: img.transpose(Image.FLIP_TOP_BOTTOM)),
    ]
    for (tag, t), s in zip(qb_modes, qb_pool):
        cid = f"qb-{tag}-{s['skuId']}"
        if cid in seen_ids:
            continue
        seen_ids.add(cid)
        src = f"{IMG_DIR}/{s['skuId']}.jpeg"
        try:
            sp = _save_synth(cid, src, t)
        except Exception as e:
            print(f"  skip qb {cid}: {e}", file=sys.stderr)
            continue
        _add_case(cases,
                  case_id=cid,
                  image_path=f"eval/synth/{cid}.jpg",
                  image_abs=sp,
                  image_type="jpeg",
                  expected_sku=s["skuId"],
                  expected_name=s.get("name"),
                  expected_year=s.get("year"),
                  allowed_verdicts=["same_product", "same_series_variant", "uncertain"],
                  forbidden_verdicts=["different_product"],
                  category="quality-boundary",
                  tags=["quality-edge"],
                  notes=f"质量边界 {tag}")
    print(f"after quality-boundary: {len(cases)}", file=sys.stderr)

    # ── 9. MUST-INCLUDE: append the 3 non-jindayi regressions
    # (jindayi already added at top of function as the cross-year-reissue case)
    # We add baizhen + yuechenyuexiang here, plus heic-path-001.
    # baizhen-1764-false-positive: pick a non-白针贡 donghe-image as
    # the input. Expected = itself; forbidden verdict = any same_product
    # against 白针贡 SKU. We pick any random non-白针贡 SKU for the image.
    baizhen_pool = [s for s in skus_with_img
                    if "白针贡" not in (s.get("name") or "")
                    and "白针" not in (s.get("name") or "")]
    if baizhen_pool:
        s = random.choice(baizhen_pool)
        cid = "baizhen-1764-false-positive"
        if cid not in seen_ids:
            seen_ids.add(cid)
            _add_case(cases,
                      case_id=cid,
                      image_path=f"donghe-images/{s['skuId']}.jpeg",
                      image_abs=f"{IMG_DIR}/{s['skuId']}.jpeg",
                      image_type="jpeg",
                      expected_sku=s["skuId"],
                      expected_name=s.get("name"),
                      expected_year=s.get("year"),
                      allowed_verdicts=["same_product", "same_series_variant"],
                      forbidden_verdicts=["same_product_with_baizhen"],
                      category="hard-negative",
                      tags=["must-include", "false-positive-guard"],
                      score_modes=["recall", "verdict"],
                      notes="非白针贡图：M3 不得跨产品输出 same_product 0.95+ "
                            "（实测背景：M3 曾给无关照 501白针贡饼 same_product 0.95）")

    # yuechenyuexiang-series: pick a 越陈越香 SKU
    yc_pool = [s for s in skus_with_img if "越陈越香" in (s.get("name") or "")]
    if yc_pool:
        s = random.choice(yc_pool)
        cid = "yuechenyuexiang-series"
        if cid not in seen_ids:
            seen_ids.add(cid)
            _add_case(cases,
                      case_id=cid,
                      image_path=f"donghe-images/{s['skuId']}.jpeg",
                      image_abs=f"{IMG_DIR}/{s['skuId']}.jpeg",
                      image_type="jpeg",
                      expected_sku=s["skuId"],
                      expected_name=s.get("name"),
                      expected_year=s.get("year"),
                      allowed_verdicts=["same_product", "same_series_variant"],
                      forbidden_verdicts=[],
                      category="hard-negative",
                      tags=["must-include", "m7-regression", "series-distinction"],
                      score_modes=["recall", "verdict"],
                      notes="越陈越香系列：M7 m3_text rescue 链路回归测试")

    # heic-path-001: real HEIC
    if os.path.exists("/tmp/w1-edit/test.heic"):
        heic_dest = f"{HEIC_DIR}/test.heic"
        os.makedirs(HEIC_DIR, exist_ok=True)
        if not os.path.exists(heic_dest):
            shutil.copy("/tmp/w1-edit/test.heic", heic_dest)
        cid = "heic-path-001"
        if cid not in seen_ids:
            seen_ids.add(cid)
            _add_case(cases,
                      case_id=cid,
                      image_path="eval/heic/test.heic",
                      image_abs=heic_dest,
                      image_type="heic",
                      expected_sku=None,
                      expected_name=None,
                      expected_year=None,
                      allowed_verdicts=[],
                      forbidden_verdicts=[],
                      category="heic",
                      tags=["must-include", "heic-pipeline", "w1-5-regression"],
                      score_modes=["recall"],
                      notes="HEIC 解码 → compare() 链路端到端验证（W1-5 路径）")
    print(f"after must-include (extras): {len(cases)}", file=sys.stderr)

    # ── Write manifest
    with open(MANIFEST, "w", encoding="utf-8") as f:
        for c in cases:
            f.write(json.dumps(c, ensure_ascii=False) + "\n")
    # Sort
    with open(MANIFEST, "r", encoding="utf-8") as f:
        lines = f.readlines()
    lines.sort()
    with open(MANIFEST, "w", encoding="utf-8") as f:
        f.writelines(lines)
    print(f"\nDONE: {len(cases)} cases → {MANIFEST}", file=sys.stderr)
    by_cat = collections.Counter(c["category"] for c in cases)
    for cat, n in sorted(by_cat.items()):
        print(f"  {cat}: {n}", file=sys.stderr)


def _recompress(img, q):
    buf = tempfile.SpooledTemporaryFile()
    img.save(buf, "JPEG", quality=q)
    buf.seek(0)
    return Image.open(buf).copy()


if __name__ == "__main__":
    main()