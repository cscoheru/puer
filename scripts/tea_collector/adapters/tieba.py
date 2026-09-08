"""
Baidu Tieba (百度贴吧) adapter for tea-collector.

Uses Playwright with stealth plugin to handle anti-bot protection.

Modes:
    essence   — Collect essence/quality threads from a tieba
    thread    — Collect a single thread by ID
    keyword   — Search within a tieba by keyword

Usage:
    python -m tea_collector.pipeline --adapter tieba --mode essence --limit 20
    python -m tea_collector.pipeline --adapter tieba --mode thread --tid 10660525526
    python -m tea_collector.pipeline --adapter tieba --login
"""

import hashlib
import json
import re
import time
from pathlib import Path
from typing import Optional

from .base import BaseAdapter, RawArticle, RawComment, ImageRef
from ..config import config
from ..registry import register_adapter

try:
    from playwright.sync_api import sync_playwright, Page, BrowserContext
    from playwright_stealth import Stealth
    HAS_PLAYWRIGHT = True
except ImportError:
    HAS_PLAYWRIGHT = False


@register_adapter
class TiebaAdapter(BaseAdapter):
    """Baidu Tieba content adapter."""

    BASE_URL = "https://tieba.baidu.com"
    TIEBA_NAME = "普洱茶"

    @property
    def name(self) -> str:
        return "tieba"

    @property
    def description(self) -> str:
        return "百度贴吧"

    def get_default_board_slug(self) -> str:
        return "tieba-essence"

    def get_default_board_name(self) -> str:
        return "贴吧精华"

    def collect(self, params: dict) -> list[RawArticle]:
        if not HAS_PLAYWRIGHT:
            raise RuntimeError(
                "playwright is required for Tieba adapter. "
                "Install with: pip install playwright && playwright install chromium"
            )

        mode = params.get("mode", "essence")
        limit = params.get("limit", 20)

        if mode == "login" or params.get("login"):
            self.login()
            return []

        articles = []
        with sync_playwright() as p:
            # Must use headed mode — headless triggers Baidu CAPTCHA
            browser = p.chromium.launch(headless=False)
            context = self._setup_context(browser)
            page = context.new_page()
            Stealth().use_sync(page)

            try:
                if mode == "essence":
                    articles = self._collect_essence(page, limit, params.get("resume", False))
                elif mode == "thread":
                    tid = params.get("tid")
                    if not tid:
                        print("Error: --tid is required for thread mode")
                        return []
                    articles = [self._collect_thread(page, str(tid))]
                elif mode == "keyword":
                    keyword = params.get("keyword", "")
                    articles = self._collect_by_keyword(page, keyword, limit)
                else:
                    print(f"Unknown mode: {mode}")
            finally:
                context.close()
                browser.close()

        return articles

    def login(self):
        """Interactive login — opens browser for user to log in manually."""
        if not HAS_PLAYWRIGHT:
            raise RuntimeError("playwright is required")

        print("🌐 Opening browser for Tieba login...")
        print("   Please log in to Baidu, then press Enter when done.")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=False)
            context = browser.new_context()
            page = context.new_page()
            page.goto(f"{self.BASE_URL}")
            input("\n   Press Enter after logging in... ")
            cookies = context.cookies()
            cookie_path = config.tieba_cookie_file
            with open(cookie_path, "w") as f:
                json.dump(cookies, f, indent=2)
            print(f"✅ Cookies saved to {cookie_path}")
            context.close()
            browser.close()

    def _setup_context(self, browser) -> BrowserContext:
        """Create browser context with saved cookies."""
        context = browser.new_context(
            user_agent=(
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
            ),
            viewport={"width": 1280, "height": 800},
        )
        cookie_path = config.tieba_cookie_file
        if cookie_path.exists():
            with open(cookie_path) as f:
                cookies = json.load(f)
            if cookies:
                context.add_cookies(cookies)
                print("   🍪 Loaded saved cookies")
        return context

    def _collect_essence(self, page: Page, limit: int, resume: bool = False) -> list[RawArticle]:
        """Collect essence/quality threads from the tieba."""
        articles = []
        # Navigate to essence tab
        url = f"{self.BASE_URL}/f?kw={self.TIEBA_NAME}&ie=utf-8&tab=301"
        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(2)
        print(f"   📋 Loaded essence page: {page.title()}")

        # Extract thread list from the page
        thread_links = self._extract_thread_links(page)
        print(f"   Found {len(thread_links)} threads on page")

        # Resume support: skip already collected
        collected_ids = set()
        if resume:
            state_file = config.output_dir / "tieba_state.json"
            if state_file.exists():
                with open(state_file) as f:
                    collected_ids = set(json.load(f).get("collected_ids", []))

        for i, (tid, title, author, replies, views) in enumerate(thread_links):
            if len(articles) >= limit:
                break
            if tid in collected_ids:
                print(f"   [{i+1}] Skipping already collected: {title[:40]}...")
                continue

            print(f"   [{i+1}/{min(len(thread_links), limit)}] Collecting: {title[:50]}...")
            try:
                article = self._collect_thread(page, tid)
                if article:
                    articles.append(article)
                    collected_ids.add(tid)
                    self._save_state(collected_ids)
            except Exception as e:
                print(f"   ⚠️  Failed: {e}")

            # Polite delay
            time.sleep(config.request_delay + (i % 3) * 0.5)

        return articles

    def _extract_thread_links(self, page: Page) -> list[tuple]:
        """Extract thread links, titles, authors, reply/view counts from list page."""
        links = []
        # Get all links and filter for thread URLs
        elements = page.query_selector_all("a[href*='/p/']")
        seen = set()
        for el in elements:
            href = el.get_attribute("href") or ""
            # Extract thread ID
            match = re.search(r'/p/(\d+)', href)
            if not match:
                continue
            tid = match.group(1)
            if tid in seen:
                continue
            seen.add(tid)

            # Get parent row for metadata
            text = (el.inner_text() or "").strip()
            if len(text) < 5:  # skip short/clickbait links
                continue

            title = text.split('\n')[0][:100]
            # Try to get author and stats from nearby elements
            author = ""
            replies = 0
            views = 0

            links.append((tid, title, author, replies, views))

        return links

    def _collect_thread(self, page: Page, tid: str) -> Optional[RawArticle]:
        """Collect a single thread with all content, images, and comments.

        Updated for 2025-2026 new Tieba UI (Vue SPA).
        Key selectors:
          - Title: span.pb-title
          - Content: .pb-content-wrap (contains .richtext-item divs)
          - Images: img[src*="tiebapic"] inside .pb-content-wrap
          - Author: .name-info first text node
          - Date: .head-info contains "MM-DD" pattern
        """
        url = f"{self.BASE_URL}/p/{tid}"
        page.goto(url, wait_until="networkidle", timeout=30000)
        time.sleep(2)

        # Extract title (new UI)
        title_el = page.query_selector("span.pb-title, .pb-title")
        title = (title_el.inner_text() or "").strip() if title_el else f"帖子 {tid}"

        # Extract main post content
        content_parts = []
        images = []
        author = ""
        post_date = ""

        # New UI: content is in .pb-content-wrap > .richtext-item
        content_wrap = page.query_selector(".pb-content-wrap")
        if content_wrap:
            # Get all richtext-item elements (text + images)
            richtext_items = content_wrap.query_selector_all(".richtext-item")
            for item in richtext_items:
                item_html = item.inner_html() or ""
                if item_html.strip():
                    content_parts.append(item_html)

                # Extract images from this item
                for img in item.query_selector_all("img"):
                    src = img.get_attribute("src") or img.get_attribute("data-src") or ""
                    if src and ("baidu" in src or "tiebapic" in src):
                        images.append(ImageRef(original_url=src))

        content_html = "".join(content_parts)

        # Extract author from .name-info or .head-info
        name_el = page.query_selector(".name-info")
        if name_el:
            # First text content is the author name
            full_text = (name_el.inner_text() or "").strip()
            author = full_text.split("\n")[0].strip().split(" ")[0].strip()

        # Extract date from .head-info
        head_info = page.query_selector(".head-info")
        if head_info:
            head_text = (head_info.inner_text() or "").strip()
            # Pattern: "茶痴之家  贴吧成长等级  ... 04-23 浙江"
            date_match = re.search(r'(\d{2}-\d{2})', head_text)
            if date_match:
                post_date = date_match.group(1)

        # Extract view/reply counts from the page stats area
        view_count = 0
        reply_count = 0
        page_text = page.inner_text("body") or ""
        # Look for patterns like "453 48" (views, replies) near top of page
        stats_el = page.query_selector(".pc-pb-first-floor-interactive")
        if stats_el:
            stats_text = stats_el.inner_text() or ""
            nums = re.findall(r'\d+', stats_text)
            if len(nums) >= 2:
                view_count = int(nums[0])
                reply_count = int(nums[1])

        # Extract comments (replies) — new UI uses different structure
        # Comments are often loaded lazily; try to get what's visible
        comments = []
        comment_items = page.query_selector_all(".reply-list-item, .pc-reply-item, .reply-item-wrapper")
        for comment_el in comment_items:
            comment_author = ""
            cauthor_el = comment_el.query_selector(".name-info, .user-name, [class*='author']")
            if cauthor_el:
                comment_author = (cauthor_el.inner_text() or "").strip().split("\n")[0]

            comment_content_el = comment_el.query_selector(".richtext-item, .reply-content, [class*='content']")
            comment_html = (comment_content_el.inner_html() or "").strip() if comment_content_el else ""

            if comment_author or comment_html:
                comments.append(RawComment(
                    floor=len(comments) + 2,
                    author=comment_author,
                    content_html=comment_html,
                    images=[],
                    created_at="",
                ))

        return RawArticle(
            source="tieba",
            source_url=url,
            source_id=tid,
            title=title,
            author=author,
            content_html=content_html,
            images=images,
            comments=comments,
            published_at=post_date,
            view_count=view_count,
            reply_count=len(comments),
            is_essence=True,
            extra={"tieba_name": self.TIEBA_NAME},
        )

    def _collect_by_keyword(self, page: Page, keyword: str, limit: int) -> list[RawArticle]:
        """Search within tieba by keyword and collect results."""
        articles = []
        search_url = f"{self.BASE_URL}/f?kw={self.TIEBA_NAME}&ie=utf-8&kw={keyword}"
        page.goto(search_url, wait_until="networkidle", timeout=30000)
        time.sleep(2)

        thread_links = self._extract_thread_links(page)
        for i, (tid, title, author, replies, views) in enumerate(thread_links[:limit]):
            print(f"   [{i+1}] Collecting: {title[:50]}...")
            try:
                article = self._collect_thread(page, tid)
                if article:
                    articles.append(article)
            except Exception as e:
                print(f"   ⚠️  Failed: {e}")
            time.sleep(config.request_delay)

        return articles

    def download_images(self, articles: list[RawArticle], output_dir: Path) -> list[RawArticle]:
        """Download all images using browser context to bypass Referer checks."""
        output_dir.mkdir(parents=True, exist_ok=True)
        total = sum(len(a.images) + sum(len(c.images) for c in a.comments) for a in articles)
        if total == 0:
            return articles

        print(f"   Downloading {total} images...")

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            context = self._setup_context(browser)
            page = context.new_page()

            downloaded = 0
            for article in articles:
                # Download main article images
                for img in article.images:
                    if img.local_path:
                        continue
                    local = self._download_single_image(page, img.original_url, output_dir)
                    if local:
                        img.local_path = local
                        downloaded += 1

                # Download comment images
                for comment in article.comments:
                    for img in comment.images:
                        if img.local_path:
                            continue
                        local = self._download_single_image(page, img.original_url, output_dir)
                        if local:
                            img.local_path = local
                            downloaded += 1

            context.close()
            browser.close()

        print(f"   Downloaded {downloaded}/{total} images")
        return articles

    def _download_single_image(self, page: Page, url: str, output_dir: Path) -> Optional[str]:
        """Download a single image via browser context to bypass Referer."""
        try:
            # Use page.evaluate to fetch in browser context
            result = page.evaluate("""
                async (url) => {
                    try {
                        const resp = await fetch(url);
                        const blob = await resp.blob();
                        const reader = new FileReader();
                        return new Promise((resolve) => {
                            reader.onload = () => resolve(reader.result);
                            reader.readAsDataURL(blob);
                        });
                    } catch(e) {
                        return null;
                    }
                }
            """, url)

            if not result or not result.startswith("data:"):
                return None

            # Parse data URL
            import base64
            header, data = result.split(",", 1)
            img_bytes = base64.b64decode(data)

            # Generate filename from URL hash
            url_hash = hashlib.md5(url.encode()).hexdigest()[:16]
            # Determine extension
            ext = ".jpg"
            if "png" in url.lower():
                ext = ".png"
            elif "gif" in url.lower():
                ext = ".gif"
            elif "webp" in url.lower():
                ext = ".webp"

            filename = f"{url_hash}{ext}"
            filepath = output_dir / filename

            # Resize if needed
            try:
                from PIL import Image
                import io
                img = Image.open(io.BytesIO(img_bytes))
                if img.width > config.max_image_width:
                    ratio = config.max_image_width / img.width
                    new_size = (config.max_image_width, int(img.height * ratio))
                    img = img.resize(new_size, Image.Resampling.LANCZOS)
                img.save(filepath, "JPEG", quality=config.image_quality)
            except Exception:
                # Fallback: save raw bytes
                filepath = filepath.with_suffix(ext)
                with open(filepath, "wb") as f:
                    f.write(img_bytes)

            return f"/uploads/collected/{filename}"

        except Exception as e:
            return None

    def _save_state(self, collected_ids: set):
        """Save collection state for resume support."""
        state_file = config.output_dir / "tieba_state.json"
        with open(state_file, "w") as f:
            json.dump({"collected_ids": list(collected_ids)}, f)
