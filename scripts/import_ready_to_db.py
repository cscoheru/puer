"""
Import transformed ready JSON data into PostgreSQL via docker exec psql.

Uses PostgreSQL dollar-quoting ($tag$) to handle arbitrary HTML content.

Usage:
    python scripts/import_ready_to_db.py [puer|zisha|all]
"""

import json
import subprocess
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent / "scraped_content"
SSH_HOST = "hk-jump"
DB_CONTAINER = "puer-hub-postgres"
DB_USER = "puerhub"
DB_NAME = "puerhub"
AUTHOR_USERNAME = "古道茶人"

TAG = "importtag"


def psql(sql: str, tuples_only: bool = False) -> subprocess.CompletedProcess:
    """Execute SQL via docker exec psql with stdin pipe."""
    cmd = [
        "ssh", SSH_HOST,
        "docker", "exec", "-i", DB_CONTAINER,
        "psql", "-U", DB_USER, "-d", DB_NAME,
        "--no-align", "--quiet",
        "-v", "ON_ERROR_STOP=1",
    ]
    if tuples_only:
        cmd.append("--tuples-only")
    return subprocess.run(cmd, input=sql.encode("utf-8"), capture_output=True, timeout=30)


def resolve_id(query: str, label: str) -> str:
    r = psql(query, tuples_only=True)
    val = r.stdout.decode("utf-8").strip()
    if not val or r.returncode != 0:
        print(f"  ✗ {label}: {r.stderr.decode('utf-8', errors='replace')[:200]}")
        sys.exit(1)
    print(f"  ✓ {label}: {val[:8]}...")
    return val


def insert_article(title: str, content: str, summary: str,
                   board_id: str, author_id: str,
                   published_at: str, tags: list[str]) -> bool:
    """Insert article using dollar-quoting for safe HTML handling."""
    tags_sql = "{" + ",".join(tags) + "}"
    # Escape dollar quotes in content by replacing $importtag$ → $importtag_$
    content_safe = content.replace(f"${TAG}$", f"${TAG}_$")
    title_safe = title.replace(f"${TAG}$", f"${TAG}_$")
    summary_safe = (summary or "").replace(f"${TAG}$", f"${TAG}_$")

    sql = f"""
INSERT INTO articles (id, type, title, content, summary, "boardId", "authorId",
                      status, tags, "viewCount", "replyCount", "isPinned", "isEssence",
                      "createdAt", "updatedAt")
VALUES (
  gen_random_uuid()::text,
  'discussion',
  ${TAG}${title_safe}${TAG}$,
  ${TAG}${content_safe}${TAG}$,
  ${TAG}${summary_safe}${TAG}$,
  '{board_id}'::text,
  '{author_id}'::text,
  'published',
  '{tags_sql}',
  {abs(hash(title)) % 3000 + 200},
  0,
  false,
  false,
  '{published_at}'::timestamp,
  '{published_at}'::timestamp
);
"""
    r = psql(sql)
    if r.returncode != 0:
        err = r.stderr.decode("utf-8", errors="replace")[:150]
        print(f"\n  SQL ERROR: {err}")
        return False
    return True


def update_board_counters(board_id: str):
    """Recalculate threadCount and postCount for a board."""
    sql = f"""
UPDATE boards SET
  "threadCount" = (SELECT COUNT(*) FROM articles WHERE "boardId" = '{board_id}'::text AND status = 'published'),
  "postCount" = (SELECT COALESCE(SUM("replyCount"), 0) FROM articles WHERE "boardId" = '{board_id}'::text AND status = 'published')
WHERE id = '{board_id}'::text;
"""
    psql(sql)


def main():
    forum = sys.argv[1] if len(sys.argv) > 1 else "all"
    slugs = ["puer", "zisha"] if forum == "all" else [forum]

    print(f"\n{'='*60}")
    print("  Importing to database")
    print(f"{'='*60}")

    author_id = resolve_id(
        "SELECT id FROM users WHERE username='古道茶人';",
        f"Author '{AUTHOR_USERNAME}'",
    )

    for slug in slugs:
        file_path = DATA_DIR / f"ready_{slug}.json"
        if not file_path.exists():
            print(f"  ✗ {file_path} not found")
            continue

        with open(file_path, encoding="utf-8") as f:
            data = json.load(f)

        board_slug = data["boardSlug"]
        board_name = data["boardName"]
        articles = data["articles"]

        board_id = resolve_id(
            f"SELECT id FROM boards WHERE slug='{board_slug}';",
            f"Board '{board_slug}' ({board_name})",
        )

        print(f"\n  📂 {board_name} — {len(articles)} articles")

        imported = 0
        errors = 0
        for i, art in enumerate(articles):
            short = art["title"][:55]
            pub = art.get("publishedAt", "2025-06-15")
            ok = insert_article(
                title=art["title"],
                content=art["content"],
                summary=art.get("summary", ""),
                board_id=board_id,
                author_id=author_id,
                published_at=pub,
                tags=art.get("tags", ["茶文化"]),
            )
            status = "OK" if ok else "FAILED"
            imported += ok
            errors += not ok
            print(f"\r  [{i+1}/{len(articles)}] {short}... {status}" + " " * 10)

        update_board_counters(board_id)
        print(f"  ✓ {imported} imported, {errors} errors")

    print(f"\n{'='*60}")
    print("  Done")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
