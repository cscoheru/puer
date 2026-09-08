#!/usr/bin/env python3
"""Sync images from evernote_export/images/ to public/uploads/evernote/."""

import os, shutil, sys

EXPORT_IMAGES = os.path.join(os.path.dirname(__file__), "..", "evernote_export", "images")
PUBLIC_IMAGES = os.path.join(os.path.dirname(__file__), "..", "public", "uploads", "evernote")


def main():
    if not os.path.isdir(EXPORT_IMAGES):
        print(f"源目录不存在: {EXPORT_IMAGES}", file=sys.stderr)
        sys.exit(1)

    os.makedirs(PUBLIC_IMAGES, exist_ok=True)

    source_files = {f for f in os.listdir(EXPORT_IMAGES) if os.path.isfile(os.path.join(EXPORT_IMAGES, f))}
    dest_files = {f for f in os.listdir(PUBLIC_IMAGES) if os.path.isfile(os.path.join(PUBLIC_IMAGES, f))}

    missing = source_files - dest_files
    if not missing:
        print("所有图片已同步，无需操作。")
        return

    for fname in sorted(missing):
        src = os.path.join(EXPORT_IMAGES, fname)
        dst = os.path.join(PUBLIC_IMAGES, fname)
        shutil.copy2(src, dst)

    print(f"同步完成: 共 {len(missing)} 张图片复制到 {PUBLIC_IMAGES}")
    print(f"当前状态: 源 {len(source_files)} 张，目标 {len(dest_files) + len(missing)} 张")


if __name__ == "__main__":
    main()
