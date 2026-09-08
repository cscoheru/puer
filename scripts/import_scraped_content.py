"""
Transform scraped 368tea content for import into puer-hub forum boards.

Two-step process:
  1. Run this script to transform content + generate import JSON
  2. Run the Node.js importer (generated below) on the server

Usage:
    python scripts/import_scraped_content.py                  # transform all
    python scripts/import_scraped_content.py --forum zisha    # only Zisha
    python scripts/import_scraped_content.py --dry-run        # preview only

Output: scripts/scraped_content/ready_{slug}.json
"""

import argparse
import json
import os
import re
import sys
from pathlib import Path

import bs4
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "scraped_content"
SOURCE_BASE = "http://www.368tea.com/bbs"

BOARD_MAP = {
    "puer": {"slug": "puer", "name": "普洱醇香"},
    "zisha": {"slug": "teacup", "name": "茶器清心"},
}

AUTHOR_USERNAME = "古道茶人"

IMAGE_CREDIT_HTML = (
    '<figcaption style="color:#999;font-size:11px;text-align:center;'
    'margin-top:-2px;margin-bottom:10px;font-style:italic">'
    '📷 图片来自网络，侵删</figcaption>'
)

DISCLAIMER = """
<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />
<div style="color:#999;font-size:12px;line-height:1.8;padding:12px 16px;background:#fafafa;border-radius:6px">
  <strong>📌 声明：</strong>本文素材整理自网络公开信息，版权归原作者所有。
  内容仅供茶友交流学习，不代表本网站立场。图片来自网络，侵删。
</div>
"""


def transform_content(html: str) -> str:
    """Transform scraped HTML: add image credits + disclaimer footer."""
    soup = BeautifulSoup(html, "html.parser")

    # Remove Discuz!-specific elements
    for tag in soup.select("script, style, .quote, div[class*=quote]"):
        tag.decompose()

    # Wrap images in figure + credit
    for img in soup.find_all("img"):
        src = img.get("src", "")
        # Skip smilies, icons, avatars
        if any(k in src.lower() for k in ["smilie", "icon", "avatar", "logo", "attachimg"]):
            img.decompose()
            continue
        # Resolve relative URLs to source site (images remain hotlinked with credit)
        if src.startswith("/"):
            src = f"{SOURCE_BASE}{src}"
            img["src"] = src
        elif src.startswith("attachments/"):
            src = f"{SOURCE_BASE}/{src}"
            img["src"] = src

        fig = soup.new_tag("figure", style="margin:16px auto;text-align:center;max-width:100%")
        credit = BeautifulSoup(IMAGE_CREDIT_HTML, "html.parser")
        parent = img.parent
        # Don't double-wrap
        if parent and parent.name == "figure":
            # already wrapped, just add credit if missing
            if not parent.find("figcaption"):
                parent.append(credit)
        else:
            img.wrap(fig)
            parent = img.parent
            img.insert_after(credit)

    # Remove empty tags
    for tag in soup.find_all(["p", "div"]):
        if not tag.get_text(strip=True) and not tag.find_all(["img", "br"]):
            tag.decompose()

    content = str(soup)
    if "素材整理自网络" not in content:
        content += DISCLAIMER

    return content


def make_excerpt(content: str, max_len: int = 150) -> str:
    text = BeautifulSoup(content, "html.parser").get_text(strip=True)
    text = re.sub(r"\s+", " ", text)
    if len(text) <= max_len:
        return text
    cutoff = text.rfind(" ", 0, max_len)
    return text[:cutoff].rstrip("，。；") + "..." if cutoff > 0 else text[:max_len] + "..."


def generate_tags(title: str, board_slug: str) -> list[str]:
    tags = ["茶文化"]
    if board_slug == "puer":
        tags.append("普洱茶")
        if re.search(r"老班章|易武|景迈|古树|冰岛|班章|山头|产区", title):
            tags.append("名山名寨")
        if re.search(r"开汤|品鉴|试茶|口感|滋味|汤色|香气|茶汤|叶底", title):
            tags.append("品鉴")
        if re.search(r"功效|保健|健康|养生|美容|皮肤|减肥", title):
            tags.append("养生")
        if re.search(r"收藏|投资|市场|价格|炒作|升值|拍卖", title):
            tags.append("市场")
        if re.search(r"工艺|制作|发酵|生茶|熟茶|存放|转化|陈化", title):
            tags.append("工艺")
        if re.search(r"苦|涩|甜|回甘|生津|喉韵|体感", title):
            tags.append("口感")
    elif board_slug == "teacup":
        tags.append("紫砂")
        tags.append("茶器")
        if re.search(r"养护|开壶|泡养|清洗|养壶|包浆", title):
            tags.append("养护")
        if re.search(r"壶|罐|杯|盏|盘|公道|茶海", title):
            tags.append("器物")
        if re.search(r"名家|大师|传人|工艺师|纯手工|全手|半手", title):
            tags.append("名家")
        if re.search(r"泥料|紫泥|朱泥|段泥|本山绿|底槽清", title):
            tags.append("泥料")
    return tags


def transform_article(article: dict, scraped_slug: str, board_slug: str) -> dict:
    title = article.get("title", "")
    content_html = article.get("content_html", "")
    new_content = transform_content(content_html)

    # Count real images
    real_img_count = len([
        m for m in re.finditer(r'<img[^>]+src="(https?://[^"]+)"', new_content)
        if not any(k in m.group(1).lower() for k in ["smilie", "icon"])
    ])

    # Parse original date
    original_date = article.get("post_date", "")
    pub_month = 6
    pub_day = 15
    if original_date:
        m = re.match(r"(\d{4})\s*[-\s年]\s*(\d{1,2})\s*[-\s月]\s*(\d{1,2})", original_date)
        if m:
            pub_month = int(m.group(2))
            pub_day = int(m.group(3))

    date_str = f"2025-{pub_month:02d}-{pub_day:02d}"

    return {
        "title": title,
        "content": new_content,
        "summary": make_excerpt(new_content),
        "type": "discussion",
        "tags": generate_tags(title, board_slug),
        "boardSlug": BOARD_MAP[scraped_slug]["slug"],
        "boardName": BOARD_MAP[scraped_slug]["name"],
        "imageCount": real_img_count,
        "publishedAt": date_str,
        "originalDate": original_date,
        "sourceUrl": article.get("url", ""),
    }


def main():
    parser = argparse.ArgumentParser(description="Transform scraped 368tea content for import")
    parser.add_argument("--forum", choices=["puer", "zisha", "all"], default="all")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    args = parser.parse_args()

    os.chdir(BASE_DIR)

    slugs = ["puer", "zisha"]
    if args.forum != "all":
        slugs = [args.forum]

    for slug in slugs:
        data_file = DATA_DIR / f"{slug}.json"
        if not data_file.exists():
            print(f"  ✗ {data_file} not found")
            continue

        with open(data_file, encoding="utf-8") as f:
            data = json.load(f)

        board_slug = BOARD_MAP[slug]["slug"]
        board_name = BOARD_MAP[slug]["name"]
        threads = data.get("threads", [])
        if args.limit > 0:
            threads = threads[:args.limit]

        print(f"\n{'─'*60}")
        print(f"  {data['source']}")
        print(f"  → {len(threads)} articles → /forum/{board_slug} ({board_name})")
        print(f"{'─'*60}")

        ready = []
        for i, t in enumerate(threads, 1):
            transformed = transform_article(t, slug, board_slug)
            ready.append(transformed)
            imgs = transformed["imageCount"]
            print(f"  [{i:2d}] {transformed['title'][:58]}")
            print(f"        📷 {imgs}张 | 🏷 {', '.join(transformed['tags'][:4])}")

        if args.dry_run:
            continue

        # Save ready-to-import JSON
        out_file = DATA_DIR / f"ready_{slug}.json"
        output = {
            "boardSlug": board_slug,
            "boardName": board_name,
            "author": AUTHOR_USERNAME,
            "total": len(ready),
            "articles": ready,
        }
        with open(out_file, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        print(f"\n  ✓ Saved to {out_file.name}")

    print(f"\n{'='*60}")
    if not args.dry_run:
        print(f"  Next: Run the Node.js importer on the server")
        print(f"  $ python scripts/import_scraped_content.py --generate-importer")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
