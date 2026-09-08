"""
Tieba-specific HTML transformer.
Handles Tieba markup quirks: emoji codes, video placeholders, client footers, etc.
"""

import re
from datetime import datetime

from .base import BaseTransformer
from ..adapters.base import RawArticle
from ..config import config


class TiebaTransformer(BaseTransformer):
    """Transformer specialized for Baidu Tieba HTML content."""

    # Regex patterns for Tieba-specific cleanup
    CLIENT_FOOTER = re.compile(
        r'(来自\s*(?:iPhone|Android|iPad|Windows|Mac|贴吧|百度))\s*(?:客户端|版)?',
        re.IGNORECASE,
    )
    TIEBA_EMOJI = re.compile(r'\[([一-鿿]+)\]')  # [哈哈] style emoji
    VIDEO_PLACEHOLDER = re.compile(
        r'<div[^>]*class="[^"]*video[^"]*"[^>]*>.*?</div>',
        re.DOTALL,
    )
    EMPTY_DIV = re.compile(r'<div[^>]*>\s*</div>')
    BR_SPAM = re.compile(r'(<br\s*/?>){3,}')

    @property
    def name(self) -> str:
        return "tieba"

    def transform(self, article: RawArticle) -> dict:
        content = self._clean_tieba_html(article.content_html)
        content = self._rewrite_images(content, article.images)
        content = self._wrap_images(content)

        # Add attribution block
        attribution = self.generate_attribution_block(
            source_platform=f"百度贴吧 · {article.extra.get('tieba_name', '普洱茶吧')}",
            source_url=article.source_url,
            original_author=article.author or "贴吧用户",
            import_date=datetime.now().strftime("%Y年%m月%d日"),
        )
        content += attribution

        # Auto-generate tags
        tags = list(article.tags) if article.tags else []
        auto_tags = self.auto_tag(article.title, article.content_html, config.tea_keywords)
        for t in auto_tags:
            if t not in tags:
                tags.append(t)
        tags.append("贴吧精华")
        tags.append("搬运内容")

        # Collect local image paths
        image_paths = [img.local_path for img in article.images if img.local_path]

        # Transform comments
        comments = []
        for c in article.comments:
            comment_html = self._clean_tieba_html(c.content_html)
            # Add reply-to prefix
            prefix = ""
            if c.reply_to_author:
                prefix = (
                    f'<span style="color:#1a7f37;font-weight:600">'
                    f'回复 @{c.reply_to_author}：</span>'
                )
            # Embed original commenter name
            author_prefix = (
                f'<span style="color:#666;font-size:12px">——{c.author}（{c.floor}楼）</span><br>'
            )
            comment_images = [img.local_path for img in c.images if img.local_path]
            comments.append({
                "content": prefix + comment_html + author_prefix,
                "originalAuthor": c.author,
                "floor": c.floor,
                "parentId": None,
                "createdAt": c.created_at,
                "images": comment_images,
            })

        return {
            "title": article.title,
            "content": content,
            "summary": self.truncate_summary(article.content_html),
            "tags": tags,
            "images": image_paths,
            "originalAuthor": article.author or "贴吧用户",
            "sourceUrl": article.source_url,
            "sourcePlatform": "tieba",
            "publishedAt": article.published_at,
            "viewCount": article.view_count,
            "replyCount": article.reply_count,
            "isEssence": article.is_essence,
            "comments": comments,
            "extra": article.extra,
        }

    def _clean_tieba_html(self, html: str) -> str:
        """Remove Tieba-specific noise from HTML."""
        if not html:
            return ""
        # Remove client footers
        html = self.CLIENT_FOOTER.sub("", html)
        # Remove video placeholders
        html = self.VIDEO_PLACEHOLDER.sub("", html)
        # Remove empty divs
        html = self.EMPTY_DIV.sub("", html)
        # Fix excessive line breaks
        html = self.BR_SPAM.sub("<br><br>", html)
        # Generic cleanup (inherited)
        html = self._clean_generic(html)
        return html.strip()

    def _clean_generic(self, html: str) -> str:
        """Basic HTML cleanup shared with GenericTransformer."""
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<p[^>]*>\s*</p>', '', html)
        return html

    def _rewrite_images(self, html: str, images: list) -> str:
        """Replace original image URLs with local paths."""
        url_to_local = {}
        for img in images:
            if img.local_path:
                url_to_local[img.original_url] = img.local_path
        for original_url, local_path in url_to_local.items():
            html = html.replace(original_url, local_path)
        return html

    def _wrap_images(self, html: str) -> str:
        """Wrap <img> tags in <figure> elements for better styling."""
        def replacer(match):
            attrs = match.group(1)
            src_match = re.search(r'src="([^"]*)"', attrs)
            if not src_match:
                return match.group(0)
            src = src_match.group(1)
            alt_match = re.search(r'alt="([^"]*)"', attrs)
            alt = alt_match.group(1) if alt_match else ""
            return (
                f'<figure style="margin:12px 0;text-align:center">'
                f'<img src="{src}" alt="{alt}" style="max-width:100%;border-radius:8px" />'
                f'</figure>'
            )
        return re.sub(r'<img([^>]+)>', replacer, html)
