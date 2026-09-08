#!/usr/bin/env python3
"""
Tieba scraper using browse CLI (CAPTCHA bypass).
V2: includes comment extraction + more posts.
"""
import json
import subprocess
import re
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from tea_collector.adapters.base import RawArticle, RawComment, ImageRef
from tea_collector.transformers.tieba import TiebaTransformer
from tea_collector.config import config, OUTPUT_DIR

B = str(Path.home() / ".claude/skills/gstack/browse/dist/browse")

# Target posts: (tid, expected_title)
TARGET_POSTS = [
    ("10660525526", "分享这些年喝茶的一些心得体会"),
    ("10700666830", "喝茶路上交过的智商税和踩过的坑"),
    ("10747987366", "冒险试一个旧熟茶"),
    ("10753844180", "这应该是鸟金"),
]

# JS to extract main post content
EXTRACT_POST_JS = r"""
(() => {
    const title = document.querySelector('span.pb-title')?.textContent?.trim() || '';
    const headInfo = document.querySelector('.head-info')?.textContent?.trim() || '';
    const author = headInfo.split(/\s+/)[0] || '';
    const dateMatch = headInfo.match(/\d{2}-\d{2}/);
    const date = dateMatch ? dateMatch[0] : '';
    const wrap = document.querySelector('.pb-content-wrap');
    const contentHtml = wrap ? wrap.innerHTML : '';
    const imgs = wrap ? Array.from(wrap.querySelectorAll('img')).map(i => i.src || i.dataset.src).filter(s => s && (s.includes('baidu') || s.includes('tiebapic'))) : [];
    const statsEl = document.querySelector('.pc-pb-first-floor-interactive');
    const statsText = statsEl?.textContent?.trim() || '';
    const nums = statsText.match(/\d+/g) || [];
    // Reply count from "全部回复 (N)" text
    const replyTop = document.querySelector('.pc-pb-reply-top');
    const replyMatch = replyTop?.textContent?.match(/\((\d+)\)/);
    const replyCount = replyMatch ? replyMatch[1] : (nums[1] || '0');
    return JSON.stringify({title, author, date, contentHtml, images: imgs, viewCount: nums[0] || '0', replyCount});
})()
"""

# JS to extract comments after they've loaded
EXTRACT_COMMENTS_JS = r"""
(() => {
    const items = document.querySelectorAll('.pb-comment-item');
    const comments = [];
    for (const item of items) {
        const nameInfo = item.querySelector('.name-info');
        const author = nameInfo?.childNodes[0]?.textContent?.trim() || '';
        const contentEl = item.querySelector('.comment-content');
        const contentText = contentEl?.textContent?.trim() || '';
        const contentHTML = contentEl?.innerHTML || '';
        // Strip date/location/actions from end: "05-09 广东 赞 回复"
        const cleanContent = contentText.replace(/\d{2}-\d{2}[\s\S]*$/, '').replace(/[\s赞回复]+$/, '').trim();
        const fullText = item.textContent || '';
        const floor = fullText.match(/第(\d+)楼/)?.[1] || '0';
        const date = fullText.match(/(\d{2}-\d{2})/)?.[1] || '';
        if (author || cleanContent) {
            comments.push({author, content: cleanContent, contentHTML, floor, date});
        }
    }
    return JSON.stringify(comments);
})()
"""


def browse_js(js_code: str) -> str:
    result = subprocess.run([B, "js", js_code], capture_output=True, text=True, timeout=30)
    return result.stdout.strip()


def browse_goto(url: str) -> bool:
    result = subprocess.run([B, "goto", url], capture_output=True, text=True, timeout=30)
    return "200" in result.stdout or "Navigated" in result.stdout


def browse_click(ref: str) -> bool:
    result = subprocess.run([B, "click", ref], capture_output=True, text=True, timeout=15)
    return result.returncode == 0


def browse_scroll():
    subprocess.run([B, "scroll"], capture_output=True, text=True, timeout=15)


def download_image(url: str, output_dir: Path) -> str:
    import hashlib
    url_hash = hashlib.md5(url.encode()).hexdigest()[:16]
    ext = ".jpg"
    if "png" in url.lower(): ext = ".png"
    filename = f"{url_hash}{ext}"
    filepath = output_dir / filename
    if filepath.exists():
        return f"/uploads/collected/{filename}"
    try:
        subprocess.run([B, "download", url, str(filepath)], capture_output=True, text=True, timeout=30)
        if filepath.exists():
            return f"/uploads/collected/{filename}"
    except Exception:
        pass
    return ""


def extract_json(raw: str) -> dict | list | None:
    """Extract JSON from browse output (may contain markers)."""
    match = re.search(r'\[.*\]|\{.*\}', raw, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group())
    except json.JSONDecodeError:
        return None


def scrape_post(tid: str) -> dict | None:
    """Scrape a single post with comments."""
    url = f"https://tieba.baidu.com/p/{tid}"
    print(f"  📖 Navigating to {url}...")
    browse_goto(url)
    time.sleep(3)

    # Extract main post content
    print(f"  📖 Extracting post content...")
    raw = browse_js(EXTRACT_POST_JS)
    data = extract_json(raw)
    if not data or not isinstance(data, dict):
        print(f"  ⚠️ Failed to extract post data")
        return None

    data["tid"] = tid
    data["url"] = url

    # Extract comments — need to click "全部回复" first
    comments = []
    reply_count = int(data.get("replyCount", "0"))
    if reply_count > 0:
        print(f"  💬 Loading {reply_count} comments...")
        try:
            # Click "全部回复" link to load comments
            browse_click("@e1")
            time.sleep(3)

            # Extract comment data
            raw_comments = browse_js(EXTRACT_COMMENTS_JS)
            parsed = extract_json(raw_comments)
            if parsed and isinstance(parsed, list):
                comments = parsed
                print(f"  💬 Extracted {len(comments)} comments")
        except Exception as e:
            print(f"  💬 Comment extraction failed: {e}")

    data["comments"] = comments
    return data


def main():
    print("╔══════════════════════════════════════════════╗")
    print("║  Tieba Scraper v2 (with comments)            ║")
    print("╚══════════════════════════════════════════════╝\n")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    config.images_dir.mkdir(parents=True, exist_ok=True)

    articles = []
    for i, (tid, expected) in enumerate(TARGET_POSTS):
        print(f"\n{'='*50}")
        print(f"[{i+1}/{len(TARGET_POSTS)}] Scraping tid={tid}")
        data = scrape_post(tid)
        if not data:
            print(f"  ❌ Failed")
            continue

        title = data.get("title") or expected
        if not title or len(title) < 3:
            title = expected

        print(f"  ✅ Title: {title[:50]}")
        print(f"     Author: {data['author']}, Date: {data['date']}")
        print(f"     Content: {len(data.get('contentHtml', ''))} chars, {len(data.get('images', []))} images")
        print(f"     Comments: {len(data.get('comments', []))}")

        # Download images
        downloaded_images = []
        for img_url in data.get("images", []):
            local = download_image(img_url, config.images_dir)
            if local:
                downloaded_images.append(local)
            time.sleep(0.3)

        # Build comment objects
        raw_comments = []
        for c in data.get("comments", []):
            # Use clean text content, wrap in <p> for HTML
            text = c.get("content", "")
            html = f"<p>{text}</p>" if text else ""
            raw_comments.append(RawComment(
                floor=int(c.get("floor", 0)),
                author=c.get("author", ""),
                content_html=html,
                created_at=c.get("date", ""),
            ))

        article = RawArticle(
            source="tieba",
            source_url=data["url"],
            source_id=tid,
            title=title,
            author=data.get("author", ""),
            content_html=data.get("contentHtml", ""),
            images=[ImageRef(original_url=u, local_path=p) for u, p in zip(data.get("images", []), downloaded_images)],
            comments=raw_comments,
            published_at=data.get("date", ""),
            view_count=int(data.get("viewCount", "0") or "0"),
            reply_count=len(raw_comments),
            is_essence=True,
            extra={"tieba_name": "普洱茶吧"},
        )
        articles.append(article)

    if not articles:
        print("\n❌ No articles collected.")
        return

    # Transform
    print(f"\n{'='*50}")
    print(f"🔄 Transforming {len(articles)} articles...")
    transformer = TiebaTransformer()
    transformed = []
    for art in articles:
        result = transformer.transform(art)
        transformed.append(result)
        ccount = len(result.get("comments", []))
        print(f"  ✅ {art.title[:45]}... ({ccount} comments)")

    # Save
    ready_data = {
        "boardSlug": "tieba-essence",
        "boardName": "贴吧精华",
        "importAuthor": "内容搬运工",
        "total": len(transformed),
        "articles": transformed,
    }

    latest_path = OUTPUT_DIR / "ready_tieba.json"
    with open(latest_path, "w", encoding="utf-8") as f:
        json.dump(ready_data, f, ensure_ascii=False, indent=2)

    total_comments = sum(len(a.get("comments", [])) for a in transformed)
    total_images = sum(len(a.get("images", [])) for a in transformed)
    print(f"\n✅ Saved {len(transformed)} articles, {total_comments} comments, {total_images} images")
    print(f"   Output: {latest_path}")
    print(f"\n   Next: upload + import on server")


if __name__ == "__main__":
    main()
