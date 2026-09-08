#!/usr/bin/env python3 -u
"""
将 export_mvp.py 导出的笔记导入 PostgreSQL 数据库。

用法:
  # 导入所有笔记（通过环境变量或内嵌 DATABASE_URL）
  python3 -u scripts/import_from_export.py

  # 指定管理员用户 ID（文章作者）
  python3 -u scripts/import_from_export.py --admin-id <user_id>

  # 仅预览，不写入数据库
  python3 -u scripts/import_from_export.py --dry-run

环境变量:
  DATABASE_URL: PostgreSQL 连接字符串（默认从 .env 读取）
"""

import os, sys, json, glob, re, argparse

try:
    import psycopg
except ImportError:
    import psycopg2 as psycopg  # fallback

EXPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")


def load_env():
    """获取 DATABASE_URL（环境变量优先，.env 回退）"""
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
    # 移除 ?schema= 参数（psycopg 不支持）
    if url:
        url = re.sub(r"\?schema=[^&]*(&|$)", "?", url).rstrip("?")
    return url


def find_admin_user(cursor):
    """查找第一个管理员用户（作为文章作者）"""
    cursor.execute("SELECT id, username FROM users WHERE role = 'admin' LIMIT 1")
    row = cursor.fetchone()
    if row:
        return row[0], row[1]
    # 回退：找第一个注册的用户
    cursor.execute("SELECT id, username FROM users ORDER BY created_at ASC LIMIT 1")
    row = cursor.fetchone()
    if row:
        return row[0], row[1]
    return None, None


def import_notes(database_url: str, admin_id: str | None = None, dry_run: bool = False):
    if dry_run:
        print("DRY RUN 模式（跳过数据库连接）", flush=True)
        admin_id = admin_id or "dry-run-user"
    else:
        print(f"连接到数据库...", flush=True)
        conn = psycopg.connect(database_url)
        cursor = conn.cursor()

        # 如果未指定 admin_id，自动查找
        if not admin_id:
            admin_id, username = find_admin_user(cursor)
            if admin_id:
                print(f"  使用作者: {username} ({admin_id})", flush=True)
            else:
                print("  [!] 数据库中无用户，无法导入", flush=True)
                return 0

    # 读取所有导出的 JSON 文件
    json_files = sorted(glob.glob(os.path.join(EXPORT_DIR, "*.json")))
    json_files = [f for f in json_files if not os.path.basename(f).startswith("_")]

    if not json_files:
        print("  [!] 未找到导出的 JSON 文件", flush=True)
        return 0

    print(f"\n找到 {len(json_files)} 篇笔记，开始导入...", flush=True)

    imported = 0
    errors = 0

    for fpath in json_files:
        try:
            with open(fpath, "r", encoding="utf-8") as f:
                note = json.load(f)
        except Exception as e:
            print(f"  [!] 读取失败 {os.path.basename(fpath)}: {e}", flush=True)
            errors += 1
            continue

        title = note.get("title", "未命名")[:200]
        content_html = note.get("content_html", "")
        tags = note.get("tags", [])

        # 生成纯文本摘要
        plain = re.sub(r"<[^>]+>", "", content_html).strip()
        summary = plain[:200] + "..." if len(plain) > 200 else plain

        # 创建草稿文章
        sql = """
            INSERT INTO articles (id, type, title, content, summary, tags, status, "authorId", "createdAt", "updatedAt")
            VALUES (gen_random_uuid()::text, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """

        created_ts = note.get("created", None)
        if created_ts:
            from datetime import datetime, timezone
            created_dt = datetime.fromtimestamp(created_ts / 1000, tz=timezone.utc)
        else:
            from datetime import datetime, timezone
            created_dt = datetime.now(timezone.utc)

        params = (
            "tasting",  # type
            title,
            content_html,
            summary,
            tags,       # PostgreSQL text[]
            "draft",    # status
            admin_id,
            created_dt,
            created_dt,
        )

        if dry_run:
            print(f"  [DRY RUN] {title}", flush=True)
            imported += 1
            continue

        try:
            cursor.execute(sql, params)
            conn.commit()
            print(f"  [{imported + 1}/{len(json_files)}] {title}", flush=True)
            imported += 1
        except Exception as e:
            conn.rollback()
            print(f"  [{imported + errors + 1}/{len(json_files)}] {title}: 导入失败 - {e}", flush=True)
            errors += 1

    if not dry_run:
        cursor.close()
        conn.close()

    print(f"\n完成! 导入 {imported} 篇，失败 {errors} 篇", flush=True)
    return imported


def main():
    parser = argparse.ArgumentParser(description="导入 Evernote 笔记到数据库")
    parser.add_argument("--admin-id", help="管理员用户 ID（文章作者）")
    parser.add_argument("--dry-run", action="store_true", help="仅预览，不写入数据库")
    args = parser.parse_args()

    database_url = load_env()
    if not database_url:
        print("错误: 请设置 DATABASE_URL 环境变量或在 .env 中配置", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("=== DRY RUN 模式 ===")

    import_notes(database_url, admin_id=args.admin_id, dry_run=args.dry_run)


if __name__ == "__main__":
    main()
