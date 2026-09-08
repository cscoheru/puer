# Tea Collector — 茶文化内容采集框架

模块化采集系统，从多个平台采集茶叶相关内容并导入 puer-hub 论坛。

## 安装

```bash
cd scripts
pip install -r tea_collector/requirements.txt
playwright install chromium
```

## 使用

### 1. 登录（首次使用贴吧需要）

```bash
python -m tea_collector.pipeline --adapter tieba --login
```

浏览器会打开，手动登录百度后按回车，cookie 自动保存。

### 2. 采集内容

```bash
# 采集贴吧精华帖（默认20篇）
python -m tea_collector.pipeline --adapter tieba --mode essence --limit 20

# 采集指定帖子
python -m tea_collector.pipeline --adapter tieba --mode thread --tid 10660525526

# 关键词搜索
python -m tea_collector.pipeline --adapter tieba --mode keyword --keyword "老班章" --limit 10
```

### 3. 导入到 puer-hub

```bash
# 本地测试（dry run）
node scripts/import-to-puerhub.mjs --dry-run tieba

# 正式导入
node scripts/import-to-puerhub.mjs tieba

# 只创建 Board 不导入数据
node scripts/import-to-puerhub.mjs --create-board tieba
```

### 4. 服务器部署

```bash
# 上传数据
scp scripts/scraped_content/ready_tieba.json root@207:~/opt/puer-hub/scripts/scraped_content/
scp -r scripts/collected_images/ root@207:~/opt/puer-hub/scripts/collected_images/

# 在服务器上执行
ssh root@207
cd /opt/puer-hub
docker compose up -d app  # 重启加载新 volume
docker exec puer-hub-app node scripts/import-to-puerhub.mjs tieba
```

## 架构

```
adapters/          → 各平台适配器（tieba, web_search, tea_site, auction）
transformers/      → HTML 转换器（tieba 专用 + 通用）
pipeline.py        → CLI 入口，编排采集→转换→输出
config.py          → 配置管理（路径、茶叶关键词词典）
```

## 扩展新平台

1. 在 `adapters/` 下新建文件，继承 `BaseAdapter`
2. 实现 `collect()` 和 `download_images()` 方法
3. 用 `@register_adapter` 装饰器注册
4. 运行 `python -m tea_collector.pipeline --adapter your_adapter`

## 输出文件

| 文件 | 说明 |
|------|------|
| `scraped_content/raw_{source}_{timestamp}.json` | 采集摘要 |
| `scraped_content/full_raw_{source}_{timestamp}.json` | 完整原始数据 |
| `scraped_content/ready_{source}.json` | 转换后的导入数据 |
| `collected_images/` | 下载的图片 |
