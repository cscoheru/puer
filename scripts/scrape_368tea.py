"""
Scrape high-quality content from 368tea.com/bbs (雅茗居茶叶论坛, Discuz! 6.1)
as initialization material for puer-hub.

Target: 普洱茶论坛 (fid=16), 紫砂壶论坛 (fid=25)
Criteria: high reply/view counts, essence (精华) markers

Usage:
    python scripts/scrape_368tea.py                  # scrape all
    python scripts/scrape_368tea.py --forum puer     # only Pu'er
    python scripts/scrape_368tea.py --forum zisha    # only Zisha
    python scripts/scrape_368tea.py --limit 10       # max 10 threads per forum

Output: scripts/scraped_content/{puer,zisha}.json
"""

import argparse
import json
import os
import re
import time
from datetime import datetime
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE_URL = "http://www.368tea.com/bbs"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36",
}
DELAY = 3.0  # be respectful
OUTPUT_DIR = Path(__file__).parent / "scraped_content"

TARGET_FORUMS = [
    {"fid": 16, "name": "普洱茶论坛", "slug": "puer"},
    {"fid": 372, "name": "紫砂壶论坛", "slug": "zisha"},
]

# Quality thresholds
MIN_REPLIES = 5
MIN_VIEWS = 300


# ─── Utilities ────────────────────────────────────────────────

_session = requests.Session()
_session.headers.update(HEADERS)


def fetch(url: str) -> str | None:
    for attempt in range(3):
        try:
            resp = _session.get(url, timeout=15)
            resp.encoding = "gbk"  # Discuz! 6.1 charset
            if resp.status_code == 200:
                return resp.text
            print(f"  [WARN] HTTP {resp.status_code}")
        except requests.RequestException as e:
            print(f"  [RETRY] {e} (attempt {attempt + 1}/3)")
            time.sleep(DELAY * (attempt + 1))
    return None


def extract_tid_from_th(th) -> int | None:
    """Extract thread ID from <th> containing <a href='thread-TID-...'>."""
    link = th.select_one("a[href*=thread-]")
    if not link:
        return None
    m = re.search(r"thread-(\d+)-", link.get("href", ""))
    return int(m.group(1)) if m else None


# ─── Parse forum list page ────────────────────────────────────

def parse_list_page(html: str, fid: int) -> list[dict]:
    """Extract thread metadata from a forum list page.

    Discuz! 6.1 structure:
      <table summary="forum_{fid}">
        <tr> <th>标题</th> <td class="author">作者</td> ... </tr>  (header)
        <tr> <td class="folder"><img.../></td> <td class="icon"/> <th class="hot|common">
               <span id="thread_{tid}"><a href="thread-{tid}-1-1.html">title</a></span>
             </th>
             <td class="author"><cite><a>author</a></cite><em>date</em></td>
             <td class="nums"><strong>replies</strong> / <em>views</em></td>
             <td class="lastpost"><em>date</em><cite>by name</cite></td>
        </tr>
      </table>
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", summary=f"forum_{fid}")
    if not table:
        return []

    threads = []
    rows = table.find_all("tr")[1:]  # skip header row

    for row in rows:
        title_th = row.find("th")
        if not title_th:
            continue

        tid = extract_tid_from_th(title_th)
        if not tid:
            continue

        # Title text
        title_el = title_th.select_one("span a, a[href*=thread-]")
        title = title_el.get_text(strip=True) if title_el else ""

        # Has essence? Look for digest/recommend images
        essence_img = title_th.select_one(
            "img[src*=digest], img[alt*=精华], img[src*=recommend]"
        )
        is_essence = essence_img is not None

        # Author
        author_td = row.find("td", class_="author")
        author = ""
        post_date = ""
        if author_td:
            cite = author_td.find("cite")
            if cite:
                a = cite.find("a")
                if a:
                    author = a.get_text(strip=True)
            em = author_td.find("em")
            if em:
                post_date = em.get_text(strip=True)

        # Replies / Views
        nums_td = row.find("td", class_="nums")
        replies = 0
        views = 0
        if nums_td:
            strong = nums_td.find("strong")
            em = nums_td.find("em")
            if strong:
                try:
                    replies = int(strong.get_text(strip=True))
                except ValueError:
                    pass
            if em:
                try:
                    views = int(em.get_text(strip=True))
                except ValueError:
                    pass

        threads.append({
            "tid": tid,
            "title": title,
            "author": author,
            "post_date": post_date,
            "replies": replies,
            "views": views,
            "is_essence": is_essence,
            "url": f"{BASE_URL}/thread-{tid}-1-1.html",
        })

    return threads


# ─── Parse thread detail page ─────────────────────────────────

def parse_thread_detail(html: str, tid: int) -> dict | None:
    """Extract main post content from a thread view page.

    Discuz! 6.1: each post is in <table summary="pid_{pid}"> with
    <div class="t_msgfont" id="postmessage_{pid}"> containing the content.
    The first such div is the main post; subsequent ones are replies.
    """
    soup = BeautifulSoup(html, "html.parser")

    # Main post content — first t_msgfont div
    content_div = soup.find("div", class_="t_msgfont", id=re.compile(r"^postmessage_"))
    if not content_div:
        return None

    # Get full HTML but remove quote blocks (nested replies quoting prior posts)
    # We keep them for authenticity but may want to trim for excerpt
    content_html = str(content_div)

    # Images in the post
    images = []
    for img in content_div.select("img"):
        src = img.get("src", "")
        if not src:
            continue
        # Resolve relative
        if src.startswith("/"):
            src = f"{BASE_URL}{src}"
        elif not src.startswith("http"):
            src = f"{BASE_URL}/{src.lstrip('/')}"
        # Skip smilies and icons
        lower_src = src.lower()
        if any(k in lower_src for k in ["smilie", "icon", "avatar", "logo"]):
            continue
        images.append(src)

    # Title from page <title>
    title = ""
    title_el = soup.select_one("title")
    if title_el:
        raw = title_el.get_text(strip=True)
        title = raw.split(" - ")[0] if " - " in raw else raw

    # Author from the first post table
    author = ""
    first_post_table = soup.find("table", summary=re.compile(r"^pid_"))
    if first_post_table:
        author_links = first_post_table.select("a[href*=space-uid]")
        if author_links:
            author = author_links[0].get_text(strip=True)

    # Text excerpt
    text_content = content_div.get_text(strip=True)
    excerpt = text_content[:300] if text_content else ""

    return {
        "tid": tid,
        "title": title,
        "author": author,
        "excerpt": excerpt,
        "content_html": content_html,
        "images": images,
        "image_count": len(images),
        "url": f"{BASE_URL}/thread-{tid}-1-1.html",
    }


# ─── Main scraping logic ──────────────────────────────────────

def scrape_forum(fid: int, name: str, slug: str, max_threads: int = 20):
    """Scrape high-quality threads from a forum."""
    print(f"\n{'='*60}")
    print(f"  {name} (fid={fid})")
    print(f"{'='*60}")

    all_candidates = []
    page = 1
    empty_pages = 0

    while len(all_candidates) < max_threads * 3:
        url = f"{BASE_URL}/forum-{fid}-{page}.html"
        print(f"  Page {page}... ", end="", flush=True)

        html = fetch(url)
        if not html:
            print("FAILED")
            break

        threads = parse_list_page(html, fid)
        if not threads:
            empty_pages += 1
            if empty_pages >= 3:
                print("(end)")
                break
        else:
            empty_pages = 0

        print(f"{len(threads)} threads")

        for t in threads:
            if t["is_essence"] or t["replies"] >= MIN_REPLIES or t["views"] >= MIN_VIEWS:
                all_candidates.append(t)

        page += 1
        if page > 50:
            break
        time.sleep(DELAY)

    # Score & rank
    for t in all_candidates:
        t["score"] = t["replies"] * 3 + t["views"] // 100 + (50 if t["is_essence"] else 0)
    all_candidates.sort(key=lambda x: x["score"], reverse=True)

    selected = all_candidates[:max_threads]
    print(f"\n  Scoring: {len(all_candidates)} candidates, selected top {len(selected)}")

    # Fetch detail for each
    results = []
    for i, thread in enumerate(selected):
        short_title = thread["title"][:50]
        print(f"  [{i+1}/{len(selected)}] tid={thread['tid']} {short_title}... ", end="", flush=True)

        html = fetch(thread["url"])
        if not html:
            print("FAILED")
            continue

        detail = parse_thread_detail(html, thread["tid"])
        if detail and detail.get("content_html"):
            detail["replies"] = thread["replies"]
            detail["views"] = thread["views"]
            detail["is_essence"] = thread["is_essence"]
            detail["post_date"] = thread["post_date"]
            # Use list page author as fallback
            if not detail["author"]:
                detail["author"] = thread["author"]
            results.append(detail)
            print(f'OK ({thread["replies"]} replies, {thread["views"]} views)')
        else:
            print("SKIP (no content)")

        time.sleep(DELAY)

    # Save
    if results:
        output_path = OUTPUT_DIR / f"{slug}.json"
        output_path.parent.mkdir(parents=True, exist_ok=True)

        output = {
            "source": f"368tea.com/bbs - {name}",
            "fid": fid,
            "scraped_at": datetime.now().isoformat(),
            "total_threads": len(results),
            "threads": results,
        }
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)

        print(f"\n  ✓ Saved {len(results)} threads to {output_path}")
    else:
        print(f"\n  ✗ No content scraped")

    return results


def main():
    parser = argparse.ArgumentParser(description="Scrape 368tea.com/bbs content")
    parser.add_argument("--limit", type=int, default=20, help="Max threads per forum")
    parser.add_argument(
        "--forum", choices=["puer", "zisha", "all"], default="all",
        help="Forum to scrape (default: all)",
    )
    args = parser.parse_args()

    os.chdir(Path(__file__).parent)

    forums = TARGET_FORUMS
    if args.forum != "all":
        forums = [f for f in TARGET_FORUMS if f["slug"] == args.forum]

    summary = {}
    for forum in forums:
        results = scrape_forum(
            fid=forum["fid"],
            name=forum["name"],
            slug=forum["slug"],
            max_threads=args.limit,
        )
        if results:
            summary[forum["slug"]] = len(results)

    print(f"\n{'='*60}")
    print("  SUMMARY")
    for slug, count in summary.items():
        print(f"    {slug}: {count} threads")
    print(f"  Output: {OUTPUT_DIR}/")
    print(f"{'='*60}\n")


if __name__ == "__main__":
    main()
