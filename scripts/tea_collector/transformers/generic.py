"""
Generic HTML transformer — works with any source platform.
Strips platform-specific markup, rewrites image URLs, adds attribution.
"""

import re
from datetime import datetime
from typing import Optional

from .base import BaseTransformer
from ..adapters.base import RawArticle
from ..config import config


class GenericTransformer(BaseTransformer):
    """Generic transformer that handles basic HTML cleanup for any source."""

    @property
    def name(self) -> str:
        return "generic"

    def transform(self, article: RawArticle) -> dict:
        content = self._clean_html(article.content_html)
        content = self._rewrite_images(content, article.images)

        # Add attribution block
        attribution = self.generate_attribution_block(
            source_platform=self._platform_display_name(article.source),
            source_url=article.source_url,
            original_author=article.author,
            import_date=datetime.now().strftime("%Y年%m月%d日"),
        )
        content += attribution

        # Auto-generate tags
        tags = article.tags or []
        auto_tags = self.auto_tag(article.title, content, config.tea_keywords)
        for t in auto_tags:
            if t not in tags:
                tags.append(t)
        tags.append("搬运内容")

        # Collect local image paths
        image_paths = [
            img.local_path for img in article.images if img.local_path
        ]

        # Transform comments
        comments = []
        for c in article.comments:
            comment_html = self._clean_html(c.content_html)
            if c.reply_to_author:
                comment_html = (
                    f'<span style="color:#1a7f37;font-weight:600">@{c.reply_to_author}</span> '
                    f'{comment_html}'
                )
            comment_images = [
                img.local_path for img in c.images if img.local_path
            ]
            comments.append({
                "content": comment_html,
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
            "originalAuthor": article.author,
            "sourceUrl": article.source_url,
            "sourcePlatform": article.source,
            "publishedAt": article.published_at,
            "viewCount": article.view_count,
            "replyCount": article.reply_count,
            "isEssence": article.is_essence,
            "comments": comments,
            "extra": article.extra,
        }

    def _clean_html(self, html: str) -> str:
        """Remove common noise from collected HTML."""
        if not html:
            return ""
        # Remove script and style tags
        html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.DOTALL | re.IGNORECASE)
        html = re.sub(r'<style[^>]*>.*?</style>', '', html, flags=re.DOTALL | re.IGNORECASE)
        # Remove empty paragraphs
        html = re.sub(r'<p[^>]*>\s*</p>', '', html)
        # Clean up excessive line breaks
        html = re.sub(r'(<br\s*/?>){3,}', '<br><br>', html)
        return html.strip()

    def _rewrite_images(self, html: str, images: list) -> str:
        """Replace original image URLs with local paths."""
        url_to_local = {}
        for img in images:
            if img.local_path:
                url_to_local[img.original_url] = img.local_path
        for original_url, local_path in url_to_local.items():
            html = html.replace(original_url, local_path)
        return html

    def _platform_display_name(self, source: str) -> str:
        """Convert source identifier to display name."""
        names = {
            "tieba": "百度贴吧",
            "web_search": "网络搜索",
            "tea_site": "茶文化网站",
            "auction": "拍卖平台",
        }
        return names.get(source, source)
