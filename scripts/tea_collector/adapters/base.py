"""
Base adapter interface and data models for tea-collector.

All platform adapters must inherit from BaseAdapter and implement
collect() and download_images() methods.
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


@dataclass
class ImageRef:
    """Reference to an image in a collected article."""
    original_url: str
    local_path: Optional[str] = None  # set after download
    width: Optional[int] = None
    height: Optional[int] = None
    alt_text: str = ""


@dataclass
class RawComment:
    """A comment/reply in a collected article."""
    floor: int = 0  # floor number (1-based, 0 = main post)
    author: str = ""
    content_html: str = ""
    images: list[ImageRef] = field(default_factory=list)
    created_at: str = ""
    reply_to_floor: Optional[int] = None  # for nested replies
    reply_to_author: Optional[str] = None


@dataclass
class RawArticle:
    """Unified data model for a collected article, regardless of source platform."""
    source: str = ""           # platform name (tieba, web_search, auction, etc.)
    source_url: str = ""       # original URL
    source_id: str = ""        # platform-specific ID (e.g., Tieba thread ID)
    title: str = ""
    author: str = ""           # original author name
    content_html: str = ""     # raw HTML from source
    images: list[ImageRef] = field(default_factory=list)
    comments: list[RawComment] = field(default_factory=list)
    published_at: str = ""     # ISO-ish date string
    tags: list[str] = field(default_factory=list)
    view_count: int = 0
    reply_count: int = 0
    is_essence: bool = False   # marked as quality/essence post on source
    extra: dict = field(default_factory=dict)  # platform-specific data


class BaseAdapter(ABC):
    """Abstract base class for all platform adapters."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Adapter identifier (e.g., 'tieba', 'web_search')."""
        pass

    @property
    @abstractmethod
    def description(self) -> str:
        """Human-readable description of this adapter."""
        pass

    @abstractmethod
    def collect(self, params: dict) -> list[RawArticle]:
        """
        Collect content from the source platform.

        Args:
            params: Adapter-specific parameters. Common keys:
                - mode: 'essence', 'thread', 'keyword', 'url'
                - limit: max number of articles
                - keyword: search keyword
                - tid: specific thread/post ID
                - url: specific URL to scrape

        Returns:
            List of RawArticle objects.
        """
        pass

    @abstractmethod
    def download_images(self, articles: list[RawArticle], output_dir: Path) -> list[RawArticle]:
        """
        Download all images referenced in articles to local storage.

        Args:
            articles: Articles with image references
            output_dir: Directory to save images

        Returns:
            Articles with updated image local_path fields.
        """
        pass

    def get_default_board_slug(self) -> str:
        """Return the default board slug for this adapter's content."""
        return f"{self.name}-essence"

    def get_default_board_name(self) -> str:
        """Return the default board display name."""
        return f"{self.description}"
