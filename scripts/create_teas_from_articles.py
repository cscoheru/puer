#!/usr/bin/env python3 -u
"""
从已导入的品鉴笔记标题解析茶品信息，创建 tea 记录并关联 article.teaId。

用法:
  # 预览（不写入）
  python3 -u scripts/create_teas_from_articles.py --dry-run

  # 正式导入
  python3 -u scripts/create_teas_from_articles.py

环境变量:
  DATABASE_URL: PostgreSQL 连接字符串（默认从 .env 读取）
"""

import os, sys, re, uuid, argparse

try:
    import psycopg
except ImportError:
    import psycopg2 as psycopg


KNOWN_BRANDS = sorted([
    "大益", "下关", "福今", "陈升号", "勐库戎氏", "老同志", "八角亭",
    "中茶", "龙园号", "今大福", "宝和祥", "天地人", "百茶堂",
    "瑞荣号", "永年", "富华", "兴海", "和合昌", "天弘",
    "大印藏", "古佛海", "花园", "傣文", "山青花燃",
], key=len, reverse=True)


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


def normalize_title(raw: str) -> str:
    return re.sub(r"^[（(]资料[)）]\s*", "", raw.strip())


def detect_brand(name_part: str) -> str | None:
    for brand in KNOWN_BRANDS:
        if name_part.startswith(brand):
            return brand
    return None


def detect_type(title: str) -> str:
    t = title
    if any(kw in t for kw in ["熟", "7572", "8592", "7562"]):
        return "ripe"
    return "raw"


def parse_year(val: int) -> int:
    if 1000 <= val <= 2030:
        return val
    if val > 2030:
        # Batch number like 2101 → 2021
        return 2000 + val // 100
    return 2000  # fallback


def parse_title(raw: str) -> dict:
    title = normalize_title(raw)

    # YEAR-NAME with dash: 2005-大益7592
    m = re.match(r"^(\d{4})[-—](.+)$", title)
    if m:
        year = int(m.group(1))
        rest = m.group(2).strip()
        brand = detect_brand(rest)
        name = rest[len(brand):].strip() if brand else rest
        return {"brand": brand or "未知", "year": parse_year(year), "name": name or rest, "type": detect_type(title)}

    # 4-digit year without dash: 2025跨年茶会, 2101-大益 → handled above
    m = re.match(r"^(\d{4})(.+)$", title)
    if m:
        year = int(m.group(1))
        rest = m.group(2).strip()
        brand = detect_brand(rest)
        name = rest[len(brand):].strip() if brand else rest
        return {"brand": brand or "未知", "year": parse_year(year), "name": name or rest, "type": detect_type(title)}

    # 2-digit year: 98宫廷熟, 70年代7572尖出
    m = re.match(r"^(\d{2})(?:年代)?\s*(.+)$", title)
    if m:
        y = int(m.group(1))
        year = y + (1900 if y > 50 else 2000)
        rest = m.group(2).strip()
        brand = detect_brand(rest)
        name = rest[len(brand):].strip() if brand else rest
        return {"brand": brand or "未知", "year": year, "name": name or rest, "type": detect_type(title)}

    return {"brand": "未知", "year": None, "name": title, "type": detect_type(title)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    database_url = load_env()
    if not database_url:
        print("错误: 请设置 DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    conn = psycopg.connect(database_url)
    cur = conn.cursor()

    # 获取所有未关联的品鉴笔记
    cur.execute("""
        SELECT id, title, "authorId" FROM articles
        WHERE type = 'tasting' AND "teaId" IS NULL
        ORDER BY title
    """)
    rows = cur.fetchall()
    if not rows:
        print("没有找到未关联茶品的品鉴笔记。")
        cur.close()
        conn.close()
        return

    print(f"找到 {len(rows)} 篇待关联的品鉴笔记\n", flush=True)

    # 获取已有茶品做去重
    cur.execute("SELECT brand, year, name, id FROM teas")
    existing = {}
    for brand, year, name, tid in cur.fetchall():
        existing[(brand, year, name)] = tid

    # 获取 admin 用户
    cur.execute("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
    admin_row = cur.fetchone()
    admin_id = admin_row[0] if admin_row else rows[0][2]

    # 解析标题
    to_create = []  # (key, parsed)
    to_link = []    # (article_id, tea_id)
    article_author = {}

    for article_id, title, author_id in rows:
        parsed = parse_title(title)
        key = (parsed["brand"], parsed["year"], parsed["name"])
        article_author[article_id] = author_id

        if key in existing:
            to_link.append((article_id, existing[key], title, parsed))
        else:
            existing[key] = None  # placeholder
            to_create.append((article_id, key, parsed, title))

    now = "2025-01-01T00:00:00Z"

    if args.dry_run:
        print("=== DRY RUN 预览 ===")
        for article_id, key, parsed, title in to_create:
            y = parsed["year"] or "????"
            print(f"  新建茶品: {parsed['brand']} {y} {parsed['name']} ({parsed['type']}) ← {title}")
        for article_id, tea_id, title, parsed in to_link:
            y = parsed["year"] or "????"
            print(f"  关联已有: {parsed['brand']} {y} {parsed['name']} (tea={tea_id}) ← {title}")
        print(f"\n摘要: 新建 {len(to_create)} 个茶品，关联 {len(to_link)} 篇笔记到已有茶品")
        cur.close()
        conn.close()
        return

    # 创建新茶品
    insert_tea = """
        INSERT INTO teas (id, name, brand, year, type, "createdBy", "createdAt", "updatedAt")
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
    """
    created = 0
    for article_id, key, parsed, title in to_create:
        new_id = str(uuid.uuid4())
        year_val = parsed["year"] if parsed["year"] else 2000
        try:
            cur.execute(insert_tea, (new_id, parsed["name"], parsed["brand"], year_val, parsed["type"], admin_id, now, now))
            existing[key] = new_id
            # Link article
            cur.execute('UPDATE articles SET "teaId" = %s WHERE id = %s', (new_id, article_id))
            created += 1
            print(f"  [{created}] {parsed['brand']} {year_val} {parsed['name']}", flush=True)
        except Exception as e:
            conn.rollback()
            print(f"  [!] 失败 {parsed['brand']} {parsed['name']}: {e}", flush=True)

    # 关联已有茶品（重新从 existing 查找，因创建阶段可能已更新）
    linked = 0
    for article_id, tea_id, title, parsed in to_link:
        key = (parsed["brand"], parsed["year"], parsed["name"])
        actual_id = existing.get(key)
        if not actual_id:
            continue
        try:
            cur.execute('UPDATE articles SET "teaId" = %s WHERE id = %s', (actual_id, article_id))
            linked += 1
        except Exception as e:
            conn.rollback()
            print(f"  [!] 关联失败 {title}: {e}", flush=True)

    conn.commit()
    print(f"\n完成! 创建 {created} 个茶品，关联 {linked} 篇笔记", flush=True)
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
