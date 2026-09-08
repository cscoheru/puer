"""
Tea Collector — Modular content collection pipeline for puer-hub.

Usage:
    python -m tea_collector.pipeline --adapter tieba --mode essence --limit 20
    python -m tea_collector.pipeline --adapter tieba --mode thread --tid 123456
    python -m tea_collector.pipeline --adapter tieba --login
    python -m tea_collector.pipeline --adapter web_search --keyword "50年代思普贡茗"
    python -m tea_collector.pipeline --adapter tea_site --url "https://..."
    python -m tea_collector.pipeline --adapter auction --keyword "思普贡茗"
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

from .config import config, OUTPUT_DIR, IMAGES_DIR
from .registry import ADAPTERS


def discover_adapters():
    """Import all adapter modules to trigger registration."""
    try:
        from .adapters import tieba as _  # noqa: F401
    except ImportError:
        pass
    try:
        from .adapters import web_search as _  # noqa: F401
    except ImportError:
        pass
    try:
        from .adapters import tea_site as _  # noqa: F401
    except ImportError:
        pass
    try:
        from .adapters import auction as _  # noqa: F401
    except ImportError:
        pass


def get_transformer(adapter_name: str):
    """Get the appropriate transformer for an adapter."""
    # Try adapter-specific transformer first
    try:
        if adapter_name == "tieba":
            from .transformers.tieba import TiebaTransformer
            return TiebaTransformer()
    except ImportError:
        pass
    # Fall back to generic
    from .transformers.generic import GenericTransformer
    return GenericTransformer()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="tea-collector",
        description="Tea content collection pipeline for puer-hub",
    )
    parser.add_argument(
        "--adapter", "-a",
        choices=list(ADAPTERS.keys()) if ADAPTERS else None,
        help="Source platform adapter to use",
    )
    parser.add_argument(
        "--mode", "-m",
        default="essence",
        help="Collection mode: essence, thread, keyword (default: essence)",
    )
    parser.add_argument("--limit", "-n", type=int, default=20, help="Max articles to collect")
    parser.add_argument("--keyword", "-k", help="Search keyword")
    parser.add_argument("--tid", "-t", help="Specific thread/post ID")
    parser.add_argument("--url", "-u", help="Specific URL to scrape")
    parser.add_argument("--login", action="store_true", help="Interactive login (save cookies)")
    parser.add_argument("--site", help="Specific site for auction adapter (shihong/poly/cguardian)")
    parser.add_argument(
        "--output", "-o",
        help="Output JSON filename (default: auto-generated)",
    )
    parser.add_argument(
        "--skip-download",
        action="store_true",
        help="Skip image download step",
    )
    parser.add_argument(
        "--skip-transform",
        action="store_true",
        help="Skip transform step (output raw data only)",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Resume from last checkpoint",
    )
    return parser


def run_pipeline(args):
    """Execute the full collection pipeline."""
    if not args.adapter:
        print("Error: --adapter is required. Available:", ", ".join(ADAPTERS.keys()))
        sys.exit(1)

    adapter = ADAPTERS.get(args.adapter)
    if not adapter:
        print(f"Error: adapter '{args.adapter}' not found. Available: {', '.join(ADAPTERS.keys())}")
        sys.exit(1)

    print(f"╔══════════════════════════════════════════════╗")
    print(f"║  Tea Collector — {adapter.description:<27s} ║")
    print(f"╚══════════════════════════════════════════════╝")

    # Build params
    params = {
        "mode": args.mode,
        "limit": args.limit,
        "keyword": args.keyword,
        "tid": args.tid,
        "url": args.url,
        "login": args.login,
        "site": args.site,
        "resume": args.resume,
    }

    # Step 1: Collect
    print(f"\n📥 Step 1: Collecting from {adapter.name}...")
    raw_articles = adapter.collect(params)
    print(f"   Collected {len(raw_articles)} articles")

    if not raw_articles:
        print("   No articles found. Exiting.")
        return

    # Step 2: Download images
    if not args.skip_download:
        print(f"\n🖼️  Step 2: Downloading images to {IMAGES_DIR}...")
        raw_articles = adapter.download_images(raw_articles, IMAGES_DIR)
        total_images = sum(len(a.images) for a in raw_articles)
        downloaded = sum(1 for a in raw_articles for img in a.images if img.local_path)
        print(f"   {downloaded}/{total_images} images downloaded")
    else:
        print("\n🖼️  Step 2: Skipping image download (--skip-download)")

    # Step 3: Transform
    source_tag = args.adapter
    if not args.skip_transform:
        print(f"\n🔄 Step 3: Transforming content...")
        transformer = get_transformer(args.adapter)
        transformed = []
        for i, article in enumerate(raw_articles):
            result = transformer.transform(article)
            transformed.append(result)
            print(f"   [{i+1}/{len(raw_articles)}] {article.title[:50]}...")
        print(f"   Transformed {len(transformed)} articles")
    else:
        print("\n🔄 Step 3: Skipping transform (--skip-transform)")
        transformed = None

    # Step 4: Save output
    output_name = args.output or f"{source_tag}_{args.mode}"
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

    # Save raw data
    raw_path = OUTPUT_DIR / f"raw_{output_name}_{timestamp}.json"
    raw_data = {
        "source": adapter.name,
        "collected_at": datetime.now().isoformat(),
        "params": {k: v for k, v in params.items() if v is not None},
        "total_articles": len(raw_articles),
        "articles": [
            {
                "source_url": a.source_url,
                "source_id": a.source_id,
                "title": a.title,
                "author": a.author,
                "published_at": a.published_at,
                "view_count": a.view_count,
                "reply_count": a.reply_count,
                "is_essence": a.is_essence,
                "tags": a.tags,
                "content_html_length": len(a.content_html),
                "images_count": len(a.images),
                "comments_count": len(a.comments),
                "extra": a.extra,
            }
            for a in raw_articles
        ],
    }
    with open(raw_path, "w", encoding="utf-8") as f:
        json.dump(raw_data, f, ensure_ascii=False, indent=2)
    print(f"\n💾 Raw data saved to {raw_path}")

    # Save full raw HTML (for debugging / re-transform)
    full_raw_path = OUTPUT_DIR / f"full_raw_{output_name}_{timestamp}.json"
    full_data = {
        "source": adapter.name,
        "collected_at": datetime.now().isoformat(),
        "total_articles": len(raw_articles),
        "articles": [
            {
                "source_url": a.source_url,
                "source_id": a.source_id,
                "title": a.title,
                "author": a.author,
                "content_html": a.content_html,
                "images": [
                    {"original_url": img.original_url, "local_path": img.local_path}
                    for img in a.images
                ],
                "comments": [
                    {
                        "floor": c.floor,
                        "author": c.author,
                        "content_html": c.content_html,
                        "created_at": c.created_at,
                        "reply_to_floor": c.reply_to_floor,
                        "reply_to_author": c.reply_to_author,
                    }
                    for c in a.comments
                ],
                "published_at": a.published_at,
                "tags": a.tags,
                "view_count": a.view_count,
                "reply_count": a.reply_count,
                "is_essence": a.is_essence,
                "extra": a.extra,
            }
            for a in raw_articles
        ],
    }
    with open(full_raw_path, "w", encoding="utf-8") as f:
        json.dump(full_data, f, ensure_ascii=False, indent=2)
    print(f"💾 Full raw data saved to {full_raw_path}")

    # Save transformed data (ready for import)
    if transformed:
        ready_path = OUTPUT_DIR / f"ready_{output_name}_{timestamp}.json"
        ready_data = {
            "boardSlug": adapter.get_default_board_slug(),
            "boardName": adapter.get_default_board_name(),
            "importAuthor": "内容搬运工",
            "total": len(transformed),
            "articles": transformed,
        }
        # Also save as latest (overwrite)
        latest_path = OUTPUT_DIR / f"ready_{source_tag}.json"
        with open(ready_path, "w", encoding="utf-8") as f:
            json.dump(ready_data, f, ensure_ascii=False, indent=2)
        with open(latest_path, "w", encoding="utf-8") as f:
            json.dump(ready_data, f, ensure_ascii=False, indent=2)
        print(f"💾 Ready data saved to {ready_path}")
        print(f"💾 Latest copy saved to {latest_path}")

    print(f"\n✅ Pipeline complete! {len(raw_articles)} articles collected.")
    if transformed:
        print(f"   Run: node scripts/import-to-puerhub.mjs {source_tag}")
        print(f"   to import into puer-hub database.")


def main():
    discover_adapters()
    parser = build_parser()
    args = parser.parse_args()

    if args.login and args.adapter:
        adapter = ADAPTERS.get(args.adapter)
        if adapter and hasattr(adapter, "login"):
            adapter.login()
            return

    run_pipeline(args)


if __name__ == "__main__":
    main()
