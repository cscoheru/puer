#!/usr/bin/env python3 -u
"""
印象笔记茶品笔记导出脚本（网页 API 版）
使用浏览器 Cookie 认证，绕过 Developer Token 限流。
运行方式:
  python3 -u scripts/import_cookie.py
"""

import os
import sys
import re
import json
import html as html_mod
import glob
import time
import requests

COOKIE_STR = "_ga=GA1.2.438545071.1765509777; web50017PreUserGuid=0f38d323-0c00-42ea-bcc4-93661770db7c; _gid=GA1.2.1115335197.1779109596; auth_version=2; req_sec=\"U=6dc7e8:P=/:E=19e3b6fc288:S=75d20cd8003f7306e238c189caae6285\"; _gat=1; _ga_EKSR28CB4Q=GS2.2.s1779109595$o3$g1$t1779113041$j60$l0$h0"
NOTEBOOK_GUID = "d2cb6933-e741-40cb-95aa-579c201bc826"
OUTPUT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
STATE_FILE = os.path.join(OUTPUT_DIR, "_export_state.json")
BASE_URL = "https://app.yinxiang.com"

# 从之前 URL 获取的 shard ID
SHARD_ID = "s32"


def strip_enml(enml):
    content = enml
    content = re.sub(r'<\?xml[^>]*\?>', '', content)
    content = re.sub(r'<!DOCTYPE[^>]*>', '', content)
    body_match = re.search(r'<(?:body|en-note)[^>]*>(.*?)</(?:body|en-note)>', content, re.DOTALL)
    if body_match:
        content = body_match.group(1)
    content = re.sub(r'<en-media[^>]*type="([^"]*)"[^>]*/>',
                     r'<em style="color:#999">[附件: \1]</em>', content)
    content = re.sub(r'<en-media[^>]*/>', r'<em style="color:#999">[附件]</em>', content)
    content = re.sub(r'<en-todo[^>]*checked="true"[^>]*/>', '☑ ', content)
    content = re.sub(r'<en-todo[^>]*/>', '☐ ', content)
    content = re.sub(r'\s*\n\s*', '\n', content)
    return content.strip()


def parse_cookies(cookie_str):
    cookies = {}
    for item in cookie_str.split(";"):
        item = item.strip()
        if "=" in item:
            key, val = item.split("=", 1)
            cookies[key.strip()] = val.strip()
    return cookies


def make_session():
    session = requests.Session()
    session.cookies.update(parse_cookies(COOKIE_STR))
    session.headers.update({
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
        "Accept": "*/*",
        "Accept-Language": "zh-CN,zh;q=0.9",
    })
    return session


def get_html_note_list(session):
    """
    通过网页 HTML 接口获取笔记本中所有笔记的列表。
    Evernote 网页版使用 HTML 页面 + AJAX 加载笔记列表。
    """
    print("\n[1/3] 获取笔记列表...", flush=True)

    all_notes = []
    offset = 0
    page_size = 100

    while True:
        params = {
            "ajax": "true",
            "n": NOTEBOOK_GUID,
            "s": SHARD_ID,
            "offset": str(offset),
            "len": str(page_size),
        }
        resp = session.get(f"{BASE_URL}/Home.action", params=params, timeout=30)
        if resp.status_code != 200:
            print(f"  请求失败: HTTP {resp.status_code}", flush=True)
            break

        # 尝试从 JSON 响应中解析笔记列表
        try:
            data = resp.json()
        except json.JSONDecodeError:
            data = resp.text

        print(f"  响应类型: {type(data).__name__}, 长度: {len(str(data))}", flush=True)

        # 打印前 200 字符看看结构
        preview = str(data)[:200]
        print(f"  预览: {preview}", flush=True)
        break  # 先看看响应结构


def main():
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    session = make_session()

    print("=" * 60)
    print("  印象笔记 → 网站素材 导出工具（网页 API 版）")
    print("=" * 60)

    print(f"\nCookie 用户: {COOKIE_STR.split(';')[1].strip()}", flush=True)

    # Step 1: 验证 Cookie 是否有效 - 访问首页
    print("\n[0/3] 验证登录状态...", flush=True)
    resp = session.get(f"{BASE_URL}/Home.action", params={"s": SHARD_ID}, timeout=30)
    if "login" in resp.text.lower() and resp.status_code == 200:
        # 检查是否被重定向到登录页
        if "登录" in resp.text or "signin" in resp.url:
            print("  Cookie 已过期，需要重新登录获取！", flush=True)
            sys.exit(1)
    print(f"  状态码: {resp.status_code}", flush=True)
    print(f"  URL: {resp.url}", flush=True)

    # 尝试获取笔记列表
    get_html_note_list(session)


if __name__ == "__main__":
    main()
