#!/usr/bin/env python3
"""
Import Tieba posts via direct SQL into puer-hub PostgreSQL.
Runs inside the server, uses docker exec psql.
"""
import json
import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

READY_FILE = Path(__file__).parent / "scraped_content" / "ready_tieba.json"

def psql(sql: str) -> str:
    """Execute SQL via docker exec psql."""
    result = subprocess.run(
        ["docker", "exec", "puer-hub-postgres", "psql", "-U", "puerhub", "-d", "puerhub",
         "-t", "-A", "-c", sql],
        capture_output=True, text=True, timeout=30
    )
    return result.stdout.strip()

def psql_exec(sql: str) -> bool:
    """Execute SQL statement, return success."""
    result = subprocess.run(
        ["docker", "exec", "puer-hub-postgres", "psql", "-U", "puerhub", "-d", "puerhub",
         "-c", sql],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"  SQL Error: {result.stderr[:200]}")
        return False
    return True

def escape_sql(text: str) -> str:
    """Escape single quotes for SQL."""
    if not text:
        return ""
    return text.replace("'", "''")

def main():
    dry_run = "--dry-run" in sys.argv

    print("╔══════════════════════════════════════════════╗")
    print("║  puer-hub SQL Importer (Tieba)               ║")
    print("╚══════════════════════════════════════════════╝")
    if dry_run:
        print("  🔍 DRY RUN — no data will be written\n")

    data = json.loads(READY_FILE.read_text())
    articles = data["articles"]
    print(f"  Loaded {len(articles)} articles from {READY_FILE.name}\n")

    # Step 1: Create board
    board_id = str(uuid.uuid4())
    board_slug = data["boardSlug"]
    board_name = data["boardName"]

    existing = psql(f"SELECT id FROM boards WHERE slug = '{board_slug}'")
    if existing:
        board_id = existing
        print(f"  ✓ Board exists: {board_name} ({board_id[:8]}...)")
    else:
        print(f"  Creating board: {board_name}...")
        sql = f"""
        INSERT INTO boards (id, name, slug, description, icon, "sortOrder", "threadCount", "postCount")
        VALUES ('{board_id}', '{board_name}', '{board_slug}',
                '精选百度贴吧优质茶帖，一比一原汁原味', '📋', 7, 0, 0);
        """
        if not dry_run:
            if psql_exec(sql):
                print(f"  ✅ Board created: {board_name}")
        else:
            print(f"  📋 Would create board: {board_name}")

    # Step 2: Create system user
    user_id = str(uuid.uuid4())
    username = data["importAuthor"]

    existing_user = psql(f"SELECT id FROM users WHERE username = '{username}'")
    if existing_user:
        user_id = existing_user
        print(f"  ✓ User exists: {username} ({user_id[:8]}...)")
    else:
        print(f"  Creating system user: {username}...")
        import hashlib
        random_pw = hashlib.sha256(uuid.uuid4().bytes).hexdigest()
        sql = f"""
        INSERT INTO users (id, username, email, "passwordHash", role, bio, level, exp, karma)
        VALUES ('{user_id}', '{username}', 'collector@system.local',
                '{random_pw}', 'admin', '系统账号，用于导入各平台精选茶文化内容',
                3, 800, 50);
        """
        if not dry_run:
            if psql_exec(sql):
                print(f"  ✅ User created: {username}")
        else:
            print(f"  👤 Would create user: {username}")

    # Step 3: Import articles
    print(f"\n  Importing {len(articles)} articles...\n")
    imported = 0
    skipped = 0
    errors = 0

    for i, art in enumerate(articles):
        title = escape_sql(art["title"])
        content = escape_sql(art["content"])
        summary = escape_sql(art.get("summary", "")[:300])
        tags = art.get("tags", ["茶文化"])
        tags_sql = "{" + ",".join(f'"{escape_sql(t)}"' for t in tags) + "}"
        images = art.get("images", [])
        images_sql = "{" + ",".join(f'"{escape_sql(img)}"' for img in images) + "}"

        short_title = art["title"][:50]
        process_indicator = f"  [{i+1}/{len(articles)}] {short_title}... "

        # Check duplicate
        existing_art = psql(f"SELECT id FROM articles WHERE title = '{title}' AND \"boardId\" = '{board_id}'")
        if existing_art:
            print(process_indicator + "SKIP (duplicate)")
            skipped += 1
            continue

        if dry_run:
            print(process_indicator + "OK (dry-run)")
            imported += 1
            continue

        # Generate realistic dates spread over the last month
        days_ago = (len(articles) - i) * 3
        pub_date = (datetime.now() - timedelta(days=days_ago)).strftime("%Y-%m-%d")

        # View count from source or generate
        view_count = art.get("viewCount", 0)
        if isinstance(view_count, str):
            view_count = int(view_count) if view_count.isdigit() else 500
        view_count = max(int(view_count * 0.1), 50)

        upvotes = 3 + (i % 12)
        reply_count = len(art.get("comments", []))

        art_id = str(uuid.uuid4())
        sql = f"""
        INSERT INTO articles (id, type, title, content, summary, "boardId", "authorId",
            status, tags, images, "viewCount", "replyCount", upvotes, downvotes,
            "isPinned", "isEssence", flair, "createdAt", "updatedAt", "lastRepliedAt")
        VALUES ('{art_id}', 'discussion', '{title}', '{content}', '{summary}',
            '{board_id}', '{user_id}', 'published',
            '{tags_sql}', '{images_sql}',
            {view_count}, {reply_count}, {upvotes}, 0,
            false, true, 'tieba',
            '{pub_date}', '{pub_date}', '{pub_date}');
        """

        if psql_exec(sql):
            # Import comments
            for j, comment in enumerate(art.get("comments", [])):
                comment_content = escape_sql(comment.get("content", ""))
                if not comment_content.strip():
                    continue
                comment_id = str(uuid.uuid4())
                comment_date = (datetime.strptime(pub_date, "%Y-%m-%d") + timedelta(hours=j+1)).strftime("%Y-%m-%d %H:%M:%S")
                comment_sql = f"""
                INSERT INTO comments (id, content, "articleId", "authorId", "createdAt", "updatedAt")
                VALUES ('{comment_id}', '{comment_content}', '{art_id}', '{user_id}',
                        '{comment_date}', '{comment_date}');
                """
                psql_exec(comment_sql)

            print(process_indicator + f"OK (+{len(art.get('comments', []))} comments)")
            imported += 1
        else:
            print(process_indicator + "FAILED")
            errors += 1

    # Step 4: Update board stats
    if not dry_run:
        psql_exec(f"""
        UPDATE boards SET
            "threadCount" = (SELECT count(*) FROM articles WHERE "boardId" = '{board_id}' AND status = 'published'),
            "postCount" = (SELECT count(*) FROM comments WHERE "articleId" IN (SELECT id FROM articles WHERE "boardId" = '{board_id}')),
            "lastPostedAt" = NOW()
        WHERE id = '{board_id}';
        """)
        print(f"\n  ↻ Board stats updated")

    print(f"\n  📊 Results:")
    print(f"     ✅ Imported: {imported}")
    print(f"     ⏭️  Skipped: {skipped}")
    print(f"     ❌ Errors: {errors}")
    print(f"\n  ✅ Done!")


if __name__ == "__main__":
    main()
