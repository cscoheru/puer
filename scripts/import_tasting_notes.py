#!/usr/bin/env python3 -u
"""
将 evernote_export/*.json 导入 TastingNote + Tea 模型，含三层去重。

用法:
  # 查看匹配结果（不写入）
  python3 -u scripts/import_tasting_notes.py --dry-run

  # 执行导入
  python3 -u scripts/import_tasting_notes.py --admin-id <user_id>

  # 从 checkpoint 继续
  python3 -u scripts/import_tasting_notes.py --admin-id <user_id> --checkpoint checkpoint.json

环境变量:
  DATABASE_URL: PostgreSQL 连接字符串（默认从 .env 读取）
"""

import os, sys, json, glob, re, argparse, unicodedata
from difflib import SequenceMatcher

try:
    import psycopg
except ImportError:
    import psycopg2 as psycopg  # fallback

EXPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
CHECKPOINT_FILE = os.path.join(EXPORT_DIR, "_import_checkpoint.json")
UNMATCHED_FILE = os.path.join(EXPORT_DIR, "_unmatched.json")

# ─── 品牌识别 ───────────────────────────────────

BRANDS = [
    "勐库戎氏", "陈升号", "宝和祥", "老班章", "天地人",
    "龙园号", "百茶堂", "和合昌", "洞天福地", "山青花燃",
    "瑞荣号", "大印藏", "古佛海", "吾心光明",
    "大益", "下关", "福今", "今大福", "中茶",
    "班章", "勐库", "永年", "东和", "富华", "天弘",
]


def load_env():
    url = os.environ.get("DATABASE_URL", "")
    if not url:
        env_path = os.path.join(os.path.dirname(__file__), "..", ".env")
        if os.path.exists(env_path):
            with open(env_path) as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("DATABASE_URL="):
                        url = line.split("=", 1)[1].strip().strip('"').strip("'")
                        break
    if url:
        url = re.sub(r"\?schema=[^&]*(&|$)", "?", url).rstrip("?")
    return url


def normalize(s: str) -> str:
    """归一化：去空格/括号/连字符，全角转半角，小写"""
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[\s\-_（）()\[\]【】「」,，.。]+", "", s)
    return s.lower()


def parse_title(title: str) -> dict:
    """从标题提取 year, brand, batch, product_name"""
    result = {"year": None, "brand": None, "batch": None, "product": title.strip()}

    # Strip (资料) prefix
    raw = title.strip()
    is_info = False
    if raw.startswith("（资料）") or raw.startswith("(资料）"):
        raw = re.sub(r"^[（(]资料[）)]", "", raw).strip()
        is_info = True

    current_year = 2026  # will need updating, but fine for now

    # Extract year — try various patterns
    year_match = re.match(r"(\d{4})[-\s–—]", raw)  # "2004-大益..."
    if not year_match:
        # "2025跨年茶会", "98宫廷熟" — year at start
        year_match = re.match(r"(\d{4})(?=年|[^\d]|$)", raw)
    if not year_match:
        # "70年代7572尖出", "80年代厚纸8582" — decade pattern
        decade_match = re.match(r"([八九七十六])([零一二三四五六七八九]?)十?年代", raw)
        if decade_match:
            decade_map = {"八": 80, "九": 90, "七": 70, "十": 10, "六": 60, "零": 0, "一": 10, "二": 20, "三": 30}
            decade_num = decade_map.get(decade_match.group(1), 0)
            result["year"] = 1900 + decade_num
    if not year_match:
        # Two-digit year: "98宫廷熟", "04土鸡沱"
        year_match = re.match(r"(\d{2})(?=[^\d]|$)", raw)
        if year_match:
            y = int(year_match.group(1))
            result["year"] = 1900 + y if y > 24 else 2000 + y
    if year_match:
        y = int(year_match.group(1))
        if 1950 <= y <= current_year:
            result["year"] = y

    # Extract brand — only from the first 30 chars to avoid false matches
    raw_prefix = raw[:30]
    for brand in sorted(BRANDS, key=len, reverse=True):
        if brand in raw_prefix:
            result["brand"] = brand
            break
    if result["brand"] is None:
        for brand in sorted(BRANDS, key=len, reverse=True):
            if brand in raw:
                result["brand"] = brand
                break

    # Extract batch — prevent matching the year portion
    # Only match batch numbers that are NOT at the start of the title and are known recipe patterns
    batch_patterns = r"(?:批次?|第)?(\d{4})(?:批)?"
    # Remove the year prefix before searching for batch
    stripped = re.sub(r"^\d{4}[-–—\s]", "", raw)
    batch_match = re.search(batch_patterns, stripped)
    if batch_match:
        b = batch_match.group(1)
        # Only accept if it looks like a recipe number, not a year
        if b != str(result["year"]) and (b.startswith("7") or b.startswith("8") or b.startswith("9") or b.startswith("5") or b.startswith("6")):
            result["batch"] = b

    return result


def similarity(a: str, b: str) -> float:
    """归一化字符串相似度"""
    return SequenceMatcher(None, normalize(a), normalize(b)).ratio()


def find_exact_match(cursor, parsed: dict) -> str | None:
    """第一层：精确匹配 year + brand + batch"""
    if not parsed["year"] or not parsed["batch"]:
        return None
    cursor.execute(
        """SELECT id FROM teas
           WHERE year = %s AND batch = %s
           AND (%s IS NULL OR brand = %s)
           LIMIT 1""",
        (parsed["year"], parsed["batch"], parsed["brand"], parsed["brand"]),
    )
    row = cursor.fetchone()
    return row[0] if row else None


def find_strict_match(cursor, title: str, parsed: dict) -> str | None:
    """第二层：严格匹配 — 同一年份 + 归一化品名完全相等"""
    norm_product = normalize(parsed["product"])

    if not parsed["year"]:
        return None

    cursor.execute(
        """SELECT id, name, aliases FROM teas
           WHERE year = %s""",
        (parsed["year"],),
    )

    for tid, name, aliases in cursor.fetchall():
        candidates = [name] + (aliases or [])
        for c in candidates:
            if normalize(c) == norm_product:
                return tid

    return None


def find_or_create_tea(cursor, conn, title: str, parsed: dict, admin_id: str) -> tuple[str, str]:
    """三层去重 → 返回 (tea_id, match_type)"""
    # Layer 1: Exact
    tid = find_exact_match(cursor, parsed)
    if tid:
        return tid, "exact"

    # Layer 2: Strict (same year + exact normalized name)
    tid = find_strict_match(cursor, title, parsed)
    if tid:
        # Auto-update aliases
        norm_product = normalize(parsed["product"])
        cursor.execute("SELECT name, aliases FROM teas WHERE id = %s", (tid,))
        row = cursor.fetchone()
        if norm_product not in [normalize(a) for a in (row[1] or []) + [row[0]]]:
            new_aliases = list(set((row[1] or []) + [title[:200]]))
            cursor.execute("UPDATE teas SET aliases = %s WHERE id = %s", (new_aliases, tid))
            conn.commit()
        return tid, "matched"

    # Layer 3: Create new tea
    name = parsed["product"][:200]
    brand = parsed["brand"] or "未知"
    year_val = parsed["year"] or 0
    tea_type = "raw" if "熟" not in name else "ripe"

    cursor.execute(
        """INSERT INTO teas (id, name, brand, year, type, aliases, "createdBy", "createdAt", "updatedAt")
           VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, NOW(), NOW())
           RETURNING id""",
        (name, brand, year_val, tea_type, [title[:200]], admin_id),
    )
    new_id = cursor.fetchone()[0]
    conn.commit()
    return new_id, "created"


def import_notes(database_url: str, admin_id: str | None, dry_run: bool, checkpoint_path: str | None):
    conn = psycopg.connect(database_url)
    cursor = conn.cursor()

    # Resolve admin
    if not admin_id:
        cursor.execute('SELECT id, username FROM users WHERE role = \'admin\' ORDER BY "createdAt" ASC LIMIT 1')
        row = cursor.fetchone()
        if not row:
            cursor.execute('SELECT id, username FROM users ORDER BY "createdAt" ASC LIMIT 1')
            row = cursor.fetchone()
        if not row:
            print("错误: 数据库无用户", file=sys.stderr)
            sys.exit(1)
        admin_id, admin_name = row
        print(f"使用作者: {admin_name} ({admin_id})", flush=True)

    # Load checkpoint
    processed_files = set()
    if checkpoint_path and os.path.exists(checkpoint_path):
        with open(checkpoint_path) as f:
            cp = json.load(f)
            processed_files = set(cp.get("processed", []))
        print(f"加载 checkpoint: {len(processed_files)} 条已处理", flush=True)

    # Gather JSON files
    json_files = sorted(glob.glob(os.path.join(EXPORT_DIR, "*.json")))
    json_files = [f for f in json_files if not os.path.basename(f).startswith("_")]
    total = len(json_files)
    pending = [f for f in json_files if os.path.basename(f) not in processed_files]
    print(f"总计 {total} 篇，待处理 {len(pending)} 篇", flush=True)

    stats = {"exact": 0, "matched": 0, "created": 0, "errors": 0, "unmatched": []}
    unmatched = []
    imported = 0

    for fpath in pending:
        fname = os.path.basename(fpath)
        try:
            with open(fpath, encoding="utf-8") as f:
                note = json.load(f)
        except Exception as e:
            print(f"  [!] 读取失败 {fname}: {e}", flush=True)
            stats["errors"] += 1
            continue

        title = note.get("title", "未命名")[:200]
        content_html = note.get("content_html", "")
        plain = re.sub(r"<[^>]+>", "", content_html).strip()
        summary = (plain[:497] + "...") if len(plain) > 497 else plain
        tags = note.get("tags", [])
        raw_images = note.get("images", [])
        images = ["/uploads/evernote/" + img for img in raw_images]
        source_id = note.get("guid", None)
        created_ts = note.get("created")

        from datetime import datetime, timezone
        created_dt = datetime.fromtimestamp(created_ts / 1000, tz=timezone.utc) if created_ts else datetime.now(timezone.utc)

        # Parse title and match Tea
        parsed = parse_title(title)
        if dry_run:
            print(f"  [DRY] {title} → {parsed}", flush=True)
            imported += 1
            continue

        tea_id, match_type = find_or_create_tea(cursor, conn, title, parsed, admin_id)

        if match_type == "created" and parsed["year"] is None:
            unmatched.append({"title": title, "parsed": parsed, "file": fname})

        # Create TastingNote
        cursor.execute(
            """INSERT INTO tasting_notes
               (id, title, content, summary, images, source, "sourceId",
                "teaId", "authorId", "createdAt", "updatedAt")
               VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
            (
                title, content_html, summary,
                json.dumps(images) if images else None,
                "evernote", source_id,
                tea_id, admin_id, created_dt, created_dt,
            ),
        )

        # Update tea tastingNoteCount
        cursor.execute(
            "UPDATE teas SET \"tastingNoteCount\" = \"tastingNoteCount\" + 1 WHERE id = %s",
            (tea_id,),
        )
        conn.commit()
        stats[match_type] += 1
        imported += 1
        print(f"  [{imported}/{len(pending)}] [{match_type}] {title}", flush=True)

        # Save checkpoint every 50
        if imported % 50 == 0:
            processed_files.add(fname)
            with open(CHECKPOINT_FILE, "w") as f:
                json.dump({"processed": list(processed_files)}, f, ensure_ascii=False)

    # Final checkpoint
    for f in pending:
        processed_files.add(os.path.basename(f))
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump({"processed": list(processed_files)}, f, ensure_ascii=False)

    if unmatched:
        with open(UNMATCHED_FILE, "w") as f:
            json.dump(unmatched, f, ensure_ascii=False, indent=2)
        print(f"\n⚠ {len(unmatched)} 条未识别年份/品牌 → 已保存到 {UNMATCHED_FILE}", flush=True)

    cursor.close()
    conn.close()

    print(f"\n完成! 导入 {imported} 篇（精确 {stats['exact']}，严格匹配 {stats['matched']}，新建茶品 {stats['created']}，错误 {stats['errors']}）", flush=True)


def main():
    parser = argparse.ArgumentParser(description="导入 Evernote 笔记到 TastingNote + Tea")
    parser.add_argument("--admin-id", help="管理员用户 ID")
    parser.add_argument("--dry-run", action="store_true", help="仅预览匹配结果")
    parser.add_argument("--checkpoint", help="从 checkpoint 文件继续（默认自动）")
    args = parser.parse_args()

    database_url = load_env()
    if not database_url:
        print("错误: 请设置 DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("=== DRY RUN ===", flush=True)
        import_notes(database_url, args.admin_id, dry_run=True, checkpoint_path=args.checkpoint)
    else:
        import_notes(database_url, args.admin_id, dry_run=False, checkpoint_path=args.checkpoint)


if __name__ == "__main__":
    main()
