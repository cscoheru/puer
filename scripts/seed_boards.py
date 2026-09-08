#!/usr/bin/env python3 -u
"""
初始化论坛版块数据。需在可访问数据库的环境中运行。

用法:
  python3 -u scripts/seed_boards.py
"""

import os, sys, re

try:
    import psycopg
except ImportError:
    import psycopg2 as psycopg

BOARDS = [
    ("puer", "普洱醇香", "🍵", "普洱茶品鉴讨论、收藏交流", 1),
    ("heicha", "黑茶雅韵", "🫖", "黑茶、六堡、安化交流", 2),
    ("teacup", "茶器清心", "🏺", "紫砂、建盏、茶器鉴赏", 3),
    ("water", "茶水人生", "💧", "茶人茶事、以茶会友", 4),
    ("knowledge", "习茶问道", "📖", "茶知识、茶文化探讨", 5),
    ("trade", "茶市风云", "🤝", "茶品交流、求购转让", 6),
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


def main():
    database_url = load_env()
    if not database_url:
        print("错误: 请设置 DATABASE_URL", file=sys.stderr)
        sys.exit(1)

    conn = psycopg.connect(database_url)
    cur = conn.cursor()

    inserted = 0
    skipped = 0
    for slug, name, icon, desc, sort_order in BOARDS:
        cur.execute("SELECT id FROM boards WHERE slug = %s", (slug,))
        if cur.fetchone():
            print(f"  [SKIP] {name} ({slug}) 已存在")
            skipped += 1
            continue
        cur.execute(
            "INSERT INTO boards (id, name, slug, description, icon, \"sortOrder\") VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s)",
            (name, slug, desc, icon, sort_order),
        )
        print(f"  [OK]   {name} ({slug})")
        inserted += 1

    conn.commit()
    print(f"\n完成: 新增 {inserted} 个版块，跳过 {skipped} 个")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
