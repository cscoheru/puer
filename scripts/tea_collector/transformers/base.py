"""
Base transformer interface for converting raw HTML to puer-hub format.
"""

from abc import ABC, abstractmethod
from pathlib import Path
from typing import Optional

from ..adapters.base import RawArticle


class BaseTransformer(ABC):
    """Abstract base class for content transformers."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Transformer identifier."""
        pass

    @abstractmethod
    def transform(self, article: RawArticle) -> dict:
        """
        Transform a RawArticle into puer-hub-ready format.

        Returns a dict with keys:
            - title: str
            - content: str (cleaned HTML with attribution)
            - summary: str
            - tags: list[str]
            - images: list[str] (local image paths)
            - original_author: str
            - source_url: str
            - source_platform: str
            - published_at: str
            - comments: list[dict]
        """
        pass

    def generate_attribution_block(
        self,
        source_platform: str,
        source_url: str,
        original_author: str,
        import_date: str,
    ) -> str:
        """Generate a styled attribution HTML block."""
        return (
            '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0" />'
            '<div style="color:#999;font-size:12px;line-height:1.8;padding:12px 16px;'
            'background:#fafafa;border-radius:6px">'
            f'<strong>📌 来源：</strong>{source_platform}<br>'
            f'<strong>原文作者：</strong>{original_author}<br>'
            f'<strong>原文链接：</strong><a href="{source_url}" target="_blank" '
            f'rel="noopener">查看原帖</a><br>'
            f'<strong>导入时间：</strong>{import_date}<br>'
            '<span style="font-size:11px">'
            '本文由系统自动导入，版权归原作者所有。如有异议请联系管理员。</span>'
            '</div>'
        )

    def auto_tag(self, title: str, content: str, keyword_map: dict) -> list[str]:
        """Auto-generate tags from title and content using keyword matching."""
        text = f"{title} {content[:2000]}"
        tags = set()
        for keyword, tag in keyword_map.items():
            if keyword in text:
                tags.add(tag)
        return list(tags)

    def truncate_summary(self, html: str, max_length: int = 200) -> str:
        """Extract plain text summary from HTML."""
        import re
        # Strip HTML tags
        text = re.sub(r'<[^>]+>', '', html)
        # Collapse whitespace
        text = re.sub(r'\s+', ' ', text).strip()
        if len(text) > max_length:
            text = text[:max_length] + '...'
        return text
