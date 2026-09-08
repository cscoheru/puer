"""
Configuration management for tea-collector.
"""

from pathlib import Path
from dataclasses import dataclass, field

# Base paths
SCRIPTS_DIR = Path(__file__).parent.parent
PROJECT_DIR = SCRIPTS_DIR.parent
OUTPUT_DIR = SCRIPTS_DIR / "scraped_content"
IMAGES_DIR = SCRIPTS_DIR / "collected_images"
COOKIES_DIR = SCRIPTS_DIR

# Ensure output directories exist
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
IMAGES_DIR.mkdir(parents=True, exist_ok=True)


@dataclass
class CollectorConfig:
    """Global configuration for the collector pipeline."""
    # Output paths
    output_dir: Path = field(default_factory=lambda: OUTPUT_DIR)
    images_dir: Path = field(default_factory=lambda: IMAGES_DIR)

    # Download settings
    max_image_width: int = 1200
    image_quality: int = 82
    request_delay: float = 3.0  # seconds between requests

    # Tieba settings
    tieba_cookie_file: Path = field(default_factory=lambda: COOKIES_DIR / "tieba_cookies.json")

    # Tag dictionary for auto-tagging
    tea_keywords: dict = field(default_factory=lambda: {
        # Tea types
        "生茶": "生茶", "生普": "生茶", "熟茶": "熟茶", "熟普": "熟茶",
        "普洱": "普洱茶", "普洱茶": "普洱茶",
        # Regions / Mountains
        "老班章": "老班章", "班章": "班章", "冰岛": "冰岛",
        "易武": "易武", "昔归": "昔归", "景迈": "景迈",
        "布朗": "布朗山", "勐海": "勐海", "临沧": "临沧",
        "西双版纳": "西双版纳", "思茅": "思茅",
        "倚邦": "倚邦", "莽枝": "莽枝", "蛮砖": "蛮砖",
        "革登": "革登", "攸乐": "攸乐",
        # Brands
        "大益": "大益", "下关": "下关", "勐库戎氏": "勐库戎氏",
        "陈升号": "陈升号", "澜沧古茶": "澜沧古茶",
        # Topics
        "品鉴": "品鉴", "开汤": "开汤", "仓储": "仓储",
        "收藏": "收藏", "投资": "投资", "拍卖": "拍卖",
        "冲泡": "冲泡", "入门": "入门", "鉴别": "鉴别",
        "古树": "古树", "台地": "台地",
        # Years
        "老茶": "老茶", "年份": "年份茶",
        # Shapes
        "饼茶": "饼茶", "沱茶": "沱茶", "砖茶": "砖茶", "散茶": "散茶",
    })


# Singleton config instance
config = CollectorConfig()
