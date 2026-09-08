#!/usr/bin/env python3
"""
从 Evernote 品鉴笔记生成论坛内容。
- 创建 50 个用户
- 创建 100 个主题帖（含回帖嵌套）
- 回帖可带图片

用法:
  # 先预览（不写入数据库）
  python3 scripts/generate_forum_content.py --dry-run

  # 执行生成
  python3 scripts/generate_forum_content.py --db-host 172.19.0.2

  # 从 checkpoint 继续（断点续跑）
  python3 scripts/generate_forum_content.py --db-host 172.19.0.2 --checkpoint checkpoint.json

环境变量:
  DB_PASSWORD: 数据库密码（默认 TeaHub2026Secure）
"""

import os, sys, json, re, random, argparse, hashlib, math
from datetime import datetime, timedelta
from difflib import SequenceMatcher

# ─── 配置 ────────────────────────────────────────
EXPORT_DIR = os.path.join(os.path.dirname(__file__), "..", "evernote_export")
CHECKPOINT_FILE = os.path.join(EXPORT_DIR, "_forum_content_checkpoint.json")

# 分类及其模板数量
TOPIC_CONFIG = [
    ("小众厂揭秘", 15),
    ("经典批次深挖", 20),
    ("仓储品鉴", 12),
    ("茶区风土", 12),
    ("对冲评测", 15),
    ("真假鉴别", 8),
    ("冲泡心得", 8),
    ("市场闲话", 10),
]

# 论坛版块
BOARDS = {
    "puer": "普洱醇香",
    "knowledge": "习茶问道",
    "trade": "茶市风云",
}

random.seed(42)

# ─── 用户人设 ─────────────────────────────────────

USER_PERSONAS = [
    # (username, level, bio, style_tag)
    ("茶痴老张", 5, "喝茶三十年，大益铁粉", "老成"),
    ("普洱小白兔", 2, "刚入坑的小白，啥都想试试", "好奇"),
    ("东莞藏锋", 4, "广东仓玩家，存茶过吨", "实战"),
    ("昆明老茶头", 4, "昆明干仓拥护者", "执着"),
    ("布朗山民", 3, "常驻茶山，每年春茶必到", "行家"),
    ("评测哥", 3, "打分派，每泡茶都做笔记", "数据"),
    ("卖茶郎中小", 2, "开茶叶店的，天天泡茶", "接地气"),
    ("老伍茶话", 4, "退休喝茶，爱写茶评", "絮叨"),
    ("茶界梁朝伟", 2, "颜值喝茶，好看就行", "随意"),
    ("陈化论道", 3, "专研仓储陈化", "技术"),
    ("易武小王子", 3, "易武茶区的忠实粉丝", "偏执"),
    ("班章狂热粉", 3, "非班章不喝", "极端"),
    ("下山虎喝茶", 2, "喝茶解渴，也喝点好的", "随性"),
    ("一叶知春秋", 4, "老茶收藏家，普洱史话库", "博学"),
    ("熟茶大叔", 3, "只喝熟茶，暖胃养身", "固执"),
    ("生茶小清新", 2, "只喝新生茶，清甜派", "少女"),
    ("广州茶客阿强", 3, "芳村跑腿，行情通", "消息灵"),
    ("普洱蔡澜", 4, "吃吃喝喝一辈子，茶是最终归宿", "洒脱"),
    ("干仓派掌门", 3, "干仓万岁，湿仓滚粗", "激进"),
    ("湿仓品鉴师", 3, "湿仓才是普洱的灵魂", "反驳"),
    ("茶山摄影师", 2, "拍照比喝茶多", "文艺"),
    ("数据帝喝茶", 3, "每泡茶都要量化", "理工"),
    ("老北京茶缸", 2, "以前喝花茶，现在喝普洱", "转变"),
    ("深圳搬砖茶", 2, "996续命茶，好喝不贵", "实用"),
    ("茶语者", 4, "品茶如品人", "哲理"),
    ("壶中岁月长", 3, "喜欢老茶的历史感", "怀旧"),
    ("普洱小诸葛", 2, "懂得不多但爱问", "好学"),
    ("茶窝头", 3, "蹲了十年茶论坛", "老油条"),
    ("品茗轩主", 4, "开茶空间，天天陪客喝茶", "社交"),
    ("散茶收集者", 2, "各种茶样收集癖", "收集"),
    ("茶底观察员", 3, "看叶底识茶", "技术"),
    ("一泡成名", 2, "追求极致口感", "挑剔"),
    ("古树守护者", 3, "古树茶的死忠粉", "坚持"),
    ("茶市风向标", 3, "关注普洱行情和投资", "市场"),
    ("茶农小王", 2, "自家有茶园，卖原料的", "朴实"),
    ("京城茶客", 3, "北方的普洱爱好者", "干燥"),
    ("大益脑残粉", 4, "非大益不喝", "狂热"),
    ("下关党代表", 3, "下关铁饼爱好者", "情怀"),
    ("福海老顾客", 2, "福海茶厂忠实用户", "专一"),
    ("老茶虫", 4, "喝过上千种茶的老炮", "阅历"),
    ("普洱新手村", 1, "刚注册，来学习的", "萌新"),
    ("茶博士", 5, "茶学专业出身", "学术"),
    ("芳村黄牛", 2, "炒茶为主，喝为辅", "炒作"),
    ("茶人一叶", 3, "茶道修习者", "禅意"),
    ("性价比猎人", 2, "只找好喝不贵的", "精打细算"),
    ("古普研习社", 3, "研究古董普洱", "学术"),
    ("茶器控", 2, "玩壶比喝茶多", "偏题"),
    ("澜沧江畔", 3, "临沧茶区的支持者", "地域"),
    ("掌柜老李", 3, "开网店卖茶的", "广告"),
    ("吃茶去也", 2, "随缘喝茶", "佛系"),
]

# ─── 图片管理 ────────────────────────────────────

IMAGES_DIR = os.path.join(EXPORT_DIR, "images")

def get_note_images(note):
    """获取笔记的图片文件列表（路径/URL 皆可）。"""
    note_images = note.get("images", [])
    available = []
    for img in note_images:
        fpath = os.path.join(IMAGES_DIR, img)
        if os.path.exists(fpath):
            available.append(img)
    return available

# ─── 笔记处理 ────────────────────────────────────

def load_notes():
    """加载所有笔记 JSON，返回列表。"""
    notes = []
    for f in sorted(os.listdir(EXPORT_DIR)):
        if not f.endswith(".json") or f.startswith("_"):
            continue
        fpath = os.path.join(EXPORT_DIR, f)
        try:
            with open(fpath) as fh:
                notes.append(json.load(fh))
        except Exception:
            pass
    return notes

def extract_entities(note):
    """从笔记标题中提取年份、品牌、批次等。"""
    title = note.get("title", "")
    year = None
    for y in re.findall(r'(?:19|20)\d{2}', title):
        year = int(y)
    brand = None
    for b in ["大益", "下关", "福今", "今大福", "中茶", "陈升号",
              "勐库戎氏", "兴海", "黎明", "福海", "澜沧", "老同志",
              "龙园号", "八角亭", "昌泰", "鸿庆", "永年"]:
        if b in title:
            brand = b
            break
    batch = None
    batch_match = re.search(r'(\d{4,6})', title)
    if batch_match:
        batch = batch_match.group(1)

    # 茶区
    region = None
    for r in ["布朗", "易武", "班章", "冰岛", "昔归", "景迈",
              "南糯", "刮风寨", "麻黑", "邦崴", "老曼峨",
              "临沧", "勐海", "勐库"]:
        if r in title:
            region = r
            break

    return {"year": year, "brand": brand, "batch": batch, "region": region}

def strip_html(html):
    """去掉 HTML 标签，保留纯文本。"""
    text = re.sub(r'<[^>]+>', '', html)
    text = re.sub(r'\s+', ' ', text).strip()
    return text[:300]

# ─── 内容生成模板 ─────────────────────────────────

ALL_TITLES = {}   # category -> list of templates
ALL_CONTENT = {}  # category -> list of templates

# 知名大厂（不适合归入"小众厂"类别）
MAJOR_BRANDS = {"大益", "下关", "中茶", "福今", "今大福", "陈升号",
                 "勐库戎氏", "澜沧", "老同志", "八角亭", "龙园号"}

# ----- 小众厂揭秘 -----

ALL_TITLES["小众厂揭秘"] = [
    "{brand}{name}？这牌子有人听过吗",
    "喝了个小众厂——{name}，{year}年的，{reaction}",
    "小众厂{name}的{year}年款，{opinion}",
    "{brand}这个厂是不是已经倒闭了",
    "{name}——{year}年{city}小厂的诚意之作",
    "喝了一款{year}年的{name}，{reaction}",
    "不是大益不是下关，{brand}的{year}年{batch}怎么样",
    "小众但惊艳：{name}开汤感受",
    "这个厂的东西你们喝过吗？{name} {year}年",
    "翻出来的老货——{name}，{year}年{city}出品",
    "茶友送的{name}，{year}年的，{opinion}",
    "{brand}还有人记得吗？当年也是{comment}",
    "{year}年{name}，小众厂里的{comment}",
    "什么{brand}？我喝了三泡没喝明白",
    "{name}这名字起得{reaction}，茶倒是{comment}",
]

ALL_CONTENT["小众厂揭秘"] = [
    "翻出一饼{name}，{year}年的，说实话之前都没听过{brand}这个厂。开汤后{flavor}，{comment}。{detail}。{closing}",
    "茶友强烈安利的一款——{name}，{year}年{region}料子。{flavor}，{comment}。{detail}。{closing}",
    "在朋友那蹭到的{name}，{year}年{city}那带小厂的出品。{flavor}，{comment}。{detail}。{closing}",
]

# ----- 经典批次深挖 -----

ALL_TITLES["经典批次深挖"] = [
    "{year}年{brand}{batch}开汤，{reaction}",
    "都说{brand}{batch}是神作，我喝了{opinion}",
    "{year}年{brand}{batch}到底有几个版本？",
    "再喝{year}年{brand}{batch}，{comment}",
    "{brand}{batch}的{year}年款，现在喝会不会太早",
    "花高价买了{brand}{batch}，{year}年的，{reaction}",
    "{year}年{brand}{batch} vs {year2}年款，差距有多大",
    "为什么{brand}{batch}在二手市场这么贵？",
    "终于喝到了{brand}{batch}，{year}年存储至今",
    "帮大家鉴定一下这饼{brand}{batch}，{year}年的",
    "据说{brand}{batch}是仿品最多的，我手里的这饼{opinion}",
    "{year}年{brand}{batch}茶样试喝，{reaction}",
]

ALL_CONTENT["经典批次深挖"] = [
    "今天开了{brand}{batch}，{year}年的。{flavor}。{detail}。{comment}。{closing}",
    "朋友寄来的茶样——{brand}{batch}，{year}年。{flavor}，{comment}。{detail}。{closing}",
    "翻出存了{X}年的{brand}{batch}，{year}年到现在，{comment}。{flavor}，{detail}。{closing}",
]

# ----- 仓储品鉴 -----

ALL_TITLES["仓储品鉴"] = [
    "同一款茶，广东仓和昆明仓差了这么多？",
    "{year}年{region}料，存了这么多年变成了{comment}",
    "仓储对口感的影响有多大？试了{year}年{name}",
    "南方存了{year}年的{name}，这仓储水平怎么样",
    "干仓派VS湿仓派，这饼{year}年{name}你们怎么看",
    "这饼{name}的仓储我给{分数}分，{comment}",
    "从茶饼外观判断仓储——{year}年{name}",
    "老茶入仓前后对比：{name}的{year}年变化",
    "传统仓放了{year}年的{name}，第一次喝有点惊艳",
    "这个仓储水平可以吗？{name} {year}年开汤",
]

ALL_CONTENT["仓储品鉴"] = [
    "同样都是{name}，{year}年的，朋友那饼广东仓{flavor}，我这饼昆明仓{flavor2}。仓储真的是普洱茶的第二生命。{comment}。{closing}",
    "{name}，{year}年至今{X}年陈化{flavor}。{detail}。{comment}。{closing}",
    "今天试了{year}年的{name}，仓储{comment}。{flavor}。{detail}。{closing}",
]

# ----- 茶区风土 -----

ALL_TITLES["茶区风土"] = [
    "{region}茶到底什么味？{year}年{name}告诉你",
    "有人说{region}茶{comment}，我不太同意",
    "{region}和{region2}，同年的原料差距有多大",
    "喝了一款{year}年{region}的{name}，{reaction}",
    "茶区漫谈：我理解的{region}风格",
    "{region}的{year}年纯料，{comment}",
    "入门{region}茶，从这款{year}年{name}开始",
    "{region}茶是不是被神话了？喝喝{name}再说",
    "同一茶区不同年份：{region}的{year}年vs{year2}年",
    "{region}料的{name}，{year}年压制，{comment}",
]

ALL_CONTENT["茶区风土"] = [
    "对{region}茶的印象来自这饼{name}，{year}年的。{flavor}。{detail}。{comment}。{closing}",
    "很多人问我{region}茶什么特点，拿{name}举例吧——{flavor}。{detail}。{comment}。{closing}",
    "试了{year}年的{region}茶{name}，{flavor}。{detail}。{comment}。{closing}",
]

# ----- 对冲评测 -----

ALL_TITLES["对冲评测"] = [
    "对冲：{name1} vs {name2}，{year}年同台竞技",
    "左右开弓——{brand1}{batch1}和{brand2}{batch2}对冲",
    "{year}年的{brand1}{batch1}和{batch2}，哪个更值得存",
    "{name1} vs {name2}：{year}年同日喝",
    "两饼{year}年{region}料对冲，{reaction}",
    "盲喝对比：{brand1}还是{brand2}，我分不出来",
    "同一价位段的{name1}和{name2}，{opinion}",
    "一直想做的对冲：{year}年{region} vs {region2}",
]

ALL_CONTENT["对冲评测"] = [
    "下午没事做了个对冲——{name1}和{name2}，都是{year}年的。{flavor}。{detail}。{comment}。{closing}",
    "左{brand1}右{brand2}，同时开泡。{flavor}。{detail}。{comment}。{closing}",
    "一直好奇{region}和{region2}的差异，今天拿两款{year}年的对冲。{flavor}。{detail}。{comment}。{closing}",
]

# ----- 真假鉴别 -----

ALL_TITLES["真假鉴别"] = [
    "帮看看这饼{name}是不是正的？{year}年买的",
    "网上买的{name}，{year}年的，求鉴定",
    "这饼{brand}{batch}的包装纸是不是有问题",
    "市场上有多少假{name}？聊聊我的经验",
    "关于{name}的真假鉴别，我说几点",
    "朋友送了一饼{name}，{year}年，感觉{opinion}",
    "现在的假茶水平：{name}高仿vs正品对比",
]

ALL_CONTENT["真假鉴别"] = [
    "最近入手了一饼{name}，{year}年的，价格{price}。{detail}。{comment}。大家帮看看？{closing}",
    "关于{brand}的防伪标识，分享一下我的经验。{detail}。{comment}。{closing}",
    "{name}（{year}年）的真假判断主要看{detail}。{comment}。{closing}",
]

# ----- 冲泡心得 -----

ALL_TITLES["冲泡心得"] = [
    "试了好几种泡法，终于找到了{name}的最佳打开方式",
    "{name}的正确冲泡姿势，{comment}",
    "同一泡{name}，盖碗和壶泡差这么多",
    "{year}年的老{region}，怎么泡才对味",
    "{name}的{year}年款，我建议{opinion}",
    "你们泡{name}一般用多少度水？",
]

ALL_CONTENT["冲泡心得"] = [
    "{name}试了好几次终于找到舒服的泡法。{detail}。{comment}。{closing}",
    "分享一下{name}（{year}年）的冲泡参数——{detail}。{comment}。{closing}",
    "之前泡{name}总觉得不对味，后来{detail}，{comment}。{closing}",
]

# ----- 市场闲话 -----

ALL_TITLES["市场闲话"] = [
    "今年的{brand}价格涨疯了，{name}直接翻倍",
    "{name}这行情看不懂了，去年{X}现在{X2}",
    "聊聊{brand}的流通品种，{name}算不算硬通货",
    "现在入手{year}年的{name}还来得及吗",
    "芳村行情：{name}最近{comment}",
    "老茶该不该出手？手上有几饼{year}年{name}",
]

ALL_CONTENT["市场闲话"] = [
    "最近关注{brand}的行情，{name}从去年{X}涨到现在{X2}！{comment}。{closing}",
    "群里有人在出{year}年的{name}，开价{price}，{comment}。{closing}",
    "说说我的看法——{brand}的{name}在{year}年这个批次，{comment}。{closing}",
]

# ─── 填充函数 ────────────────────────────────────

COMMENT_PHRASES = [
    "可以说是相当到位了", "这个评价中肯", "我喝的感觉不太一样",
    "同意楼上，这款确实不错", "价格再下来点就好了",
    "种草了，回头搞一饼试试", "这款茶确实有争议",
    "喝过同款，楼主说的没错", "我手里也有一饼，改天开了对比",
    "不知道现在还能不能买到", "这茶现在溢价太高了",
    "学习了", "感谢分享", "这个仓储水平确实重要",
    "同感！", "完全不同意楼上的说法",
    "你确定是正品吗？", "这个年份的茶要注意仓储",
    "有没有更详细的描述？", "能看看叶底吗？",
]

NESTED_COMMENT_PHRASES = [
    "对，就是这个意思", "补充一下，{detail}",
    "你试试用盖碗泡，效果不一样", "建议再放两年",
    "是的，我在芳村也看到这个价", "这个批次的包装纸确实有特点",
    "可以看看我发的图片，很清晰", "楼主方便私信一下购买渠道吗？",
    "我也觉得，握手", "其实还有另一个版本",
    "这个说法我听过，但不完全准确", "你去看看那个帖子，里面有详细图",
]

# 分数级别的描述
def random_score_desc():
    return random.choice([
        "75", "78", "80", "82", "83", "85", "86", "87", "88", "90", "92", "93", "95"
    ])

# 口感描述词库
FLAVOR_WORDS = {
    "正面": ["烟香", "蜜香", "花果香", "兰香", "樟香", "参香", "药香",
             "陈香", "木质香", "枣香", "糯香", "坚果香", "干果香"],
    "口感": ["醇厚", "顺滑", "甘甜", "饱满", "细腻", "圆润", "鲜活",
             "厚重", "轻快", "柔和", "刚猛", "霸道", "绵柔"],
    "缺陷": ["仓味重", "锁喉", "酸感明显", "有堆味", "有点空",
             "水味重", "涩感化不开", "有杂味", "薄", "寡淡"],
}

def pick_flavors():
    n = random.randint(1, 3)
    return "、".join(random.sample(FLAVOR_WORDS["正面"], min(n, len(FLAVOR_WORDS["正面"]))))

def pick_texture():
    n = random.randint(1, 2)
    return "、".join(random.sample(FLAVOR_WORDS["口感"], min(n, len(FLAVOR_WORDS["口感"]))))

def pick_flaw():
    return random.choice(FLAVOR_WORDS["缺陷"])

# ─── 模板扩展函数 ─────────────────────────────────

def expand_template(template, note, entities):
    """用笔记数据和随机内容填充模板。"""
    title = note.get("title", "")
    summary = note.get("summary", "") or strip_html(note.get("content_html", ""))
    tag_list = note.get("tags", [])

    # 基本字段
    year = entities.get("year") or random.randint(1998, 2021)
    brand = entities.get("brand") or random.choice(["大益", "下关", "兴海", "黎明"])
    batch = entities.get("batch") or str(random.randint(1000, 9999))
    region = entities.get("region") or random.choice(["布朗", "易武", "勐库"])
    region2 = random.choice(["临沧", "勐海", "易武", "布朗", "景迈"])
    name = title[:30] if len(title) > 15 else title
    year2 = year + random.randint(1, 5)
    city = random.choice(["勐海", "下关", "昆明", "普洱", "临沧"])
    price = random.choice(["300多", "500出头", "800左右", "一千出头", "两千多", "三百块"])
    X = random.randint(1, 15)
    X2 = X * random.choice([2, 3, 5])

    # 反应/观点类
    reaction = random.choice([
        "出乎意料的好", "有点失望", "中规中矩吧",
        "惊喜", "不太行", "对得起价格",
        "值得一试", "比预期好很多",
    ])
    opinion = random.choice([
        "有惊喜", "一般般", "确实不错",
        "性价比很高", "价格虚高", "值得收藏",
    ])
    comment = random.choice([
        "后劲很足", "层次感丰富", "适合存一下",
        "现在喝有点浪费", "口感很干净", "仓储是加分项",
        "茶底看得出是好料子", "很有代表性的一款",
        "放放会更好喝", "这个价位无敌了",
    ])
    closing = random.choice([
        "各位茶友有喝过这款的吗？", "大家觉得怎么样？",
        "准备再囤两饼。", "个人观点，不喜勿喷。",
        "欢迎交流！", "你们遇到过类似的情况吗？", "",
    ])

    # 口感描述
    flavors = pick_flavors()
    texture = pick_texture()
    scores = f"{random_score_desc()}/{random_score_desc()}/{random_score_desc()}"
    flavor_text = f"{flavors}，{texture}，回甘{'明显' if random.random() > 0.5 else '持久'}"

    # 详细描述
    detail_parts = [
        f"茶汤{'橙黄' if random.random() > 0.5 else '橙红'}明亮",
        f"{'前几泡' if random.random() > 0.5 else '中段'}表现{'很好' if random.random() > 0.5 else '稳定'}",
        f"叶底{'肥厚' if random.random() > 0.5 else '匀整'}",
        f"耐泡度不错，{random.choice(['十泡', '十二泡', '十五泡'])}仍有余味",
        f"官方评分{random_score_desc()}分",
        f"投茶{random.choice(['8克', '10克', '7.5克'])}，{random.choice(['盖碗', '紫砂壶'])}冲泡",
        f"这茶在芳村现在行情{price}左右",
    ]
    detail = "。".join(random.sample(detail_parts, min(2, len(detail_parts))))

    # 对冲评测用的双品牌/批次/名称
    brand2_val = random.choice(["大益", "下关", "兴海", "黎明", "福海", "老同志", "中茶"])
    batch2_val = str(random.randint(1000, 9999))
    name2_val = f"{brand2_val}{batch2_val}" if random.random() > 0.5 else random.choice([
        f"{brand2_val} {region}",
        f"{year}年{brand2_val}{batch2_val}",

    ])

    values = {
        "name": name, "year": str(year), "year2": str(year2),
        "brand": brand or "某品牌", "batch": batch,
        "brand1": brand or "某品牌", "batch1": batch, "name1": name,
        "brand2": brand2_val, "batch2": batch2_val, "name2": name2_val,
        "region": region or "未知", "region2": region2,
        "city": city, "price": price,
        "X": str(X), "X2": str(X2),
        "reaction": reaction, "opinion": opinion,
        "comment": comment, "closing": closing,
        "flavor": flavor_text, "flavor2": flavor_text,
        "detail": detail, "scores": scores,
        "texture": texture, "flavors": flavors,
        "分数": random_score_desc(),
    }

    result = template
    for k, v in values.items():
        result = result.replace("{" + k + "}", v)

    # 清理多余的空白
    result = re.sub(r'\s+', ' ', result).strip()
    # 去掉末尾非中文/英文标点
    result = result.rstrip("，。、？！,.")
    # 加上合适标点
    result += random.choice(["", "。", "！", "？"])
    return result

# ─── 数据库操作 ───────────────────────────────────

DB_CONFIG = {
    "dbname": "puerhub",
    "user": "puerhub",
    "password": os.environ.get("DB_PASSWORD", "TeaHub2026Secure"),
    "host": "172.19.0.2",
    "port": 5432,
}

def get_db():
    import psycopg
    return psycopg.connect(**DB_CONFIG)

def create_user(conn, username, email, password, level, bio):
    """创建用户，返回 id。"""
    import bcrypt
    pw_hash = bcrypt.hashpw(password.encode(), bcrypt.gensalt(rounds=10)).decode()
    cur = conn.execute("""
        INSERT INTO users (id, username, email, "passwordHash", level, exp, bio, "createdAt", "updatedAt")
        VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s, NOW(), NOW())
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING id
    """, (username, email, pw_hash, level, level * 100, bio))
    conn.commit()
    return cur.fetchone()[0]

def get_board_id(conn, slug):
    cur = conn.execute('SELECT id FROM boards WHERE slug = %s', (slug,))
    row = cur.fetchone()
    return row[0] if row else None

def create_thread(conn, title, content_html, author_id, board_id, images, created_at):
    """创建帖子，返回 id。"""
    cur = conn.execute("""
        INSERT INTO articles (id, type, title, content, status, "authorId", "boardId",
                              images, "createdAt", "updatedAt", "lastRepliedAt")
        VALUES (gen_random_uuid(), 'discussion', %s, %s, 'published', %s, %s,
                %s, %s, %s, %s)
        RETURNING id
    """, (title, content_html, author_id, board_id, images, created_at, created_at, created_at))
    conn.commit()
    return cur.fetchone()[0]

def create_comment(conn, content, author_id, article_id, images, created_at, parent_id=None):
    """创建评论/回复。"""
    cur = conn.execute("""
        INSERT INTO comments (id, content, images, "authorId", "articleId",
                              "parentId", "createdAt")
        VALUES (gen_random_uuid(), %s, %s, %s, %s, %s, %s)
        RETURNING id
    """, (content, images, author_id, article_id, parent_id, created_at))
    conn.commit()
    return cur.fetchone()[0]

def update_thread_counts(conn, article_id, reply_count):
    """更新帖子回复计数和版块计数器。"""
    conn.execute('UPDATE articles SET "replyCount" = %s WHERE id = %s',
                 (reply_count, article_id))
    conn.execute('UPDATE boards SET "postCount" = "postCount" + 1 WHERE id = '
                 '(SELECT "boardId" FROM articles WHERE id = %s)', (article_id,))

def thread_exists(conn, title):
    """检查帖子是否已存在（用于断点续跑）。"""
    cur = conn.execute('SELECT COUNT(*) FROM articles WHERE title = %s', (title,))
    return cur.fetchone()[0] > 0

# ─── 主题生成 ────────────────────────────────────

def select_topics(notes, count=100):
    """从笔记中选出 count 个作为话题素材，确保多样性。"""
    scored = []
    for n in notes:
        title = n.get("title", "")
        entities = extract_entities(n)
        has_year = entities["year"] is not None
        has_brand = entities["brand"] is not None
        has_images = len(get_note_images(n)) > 0
        # 评分：有图片+有品牌+有年份 = 最佳素材
        score = sum([has_images * 3, has_brand * 2, has_year * 1,
                     len(title) > 10 and 1 or 0])
        scored.append((score, n))

    scored.sort(key=lambda x: -x[0])
    return scored[:count]

def build_topic_content(note, category):
    """为给定分类和笔记生成帖子内容。"""
    entities = extract_entities(note)
    brand = entities.get("brand")
    is_major = brand in MAJOR_BRANDS if brand else False

    if category == "小众厂揭秘" and is_major:
        # 知名品牌不适合用"小众厂"角度，改用讨论/评价角度
        alt_titles = [
            "{brand}{batch}还有人记得吗",
            "今天开了{brand}{batch}，{year}年的",
            "{brand}{batch}的{year}年款，{opinion}",
            "{year}年{brand}{batch}开汤，{reaction}",
        ]
        alt_contents = [
            "翻出存了几年的{brand}{batch}，{year}年到现在，{flavor}。{detail}。{comment}。{closing}",
            "朋友寄来的茶样——{brand}{batch}，{year}年。{flavor}，{comment}。{detail}。{closing}",
            "今天开了{brand}{batch}，{year}年的。{flavor}。{detail}。{comment}。{closing}",
        ]
        title_template = random.choice(alt_titles)
        content_template = random.choice(alt_contents)
    else:
        title_template = random.choice(ALL_TITLES[category])
        content_template = random.choice(ALL_CONTENT[category])

    title = expand_template(title_template, note, entities)
    content = expand_template(content_template, note, entities)
    content_html = f"<p>{content}</p>"
    return title, content_html, entities

def build_reply(note, user_persona, context=""):
    """生成一条回复内容。"""
    if random.random() < 0.3:
        # 使用嵌套模板
        tpl = random.choice(NESTED_COMMENT_PHRASES)
        entities = extract_entities(note)
        return expand_template(tpl, note, entities)
    else:
        return random.choice(COMMENT_PHRASES)

# ─── 主流程 ───────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只预览，不写入数据库")
    parser.add_argument("--db-host", default="172.19.0.2")
    parser.add_argument("--checkpoint")
    args = parser.parse_args()

    DB_CONFIG["host"] = args.db_host

    print("=" * 60)
    print("  论坛内容生成器")
    print(f"  来源: {len(load_notes())} 篇笔记 → 50 用户 × 100 主题")
    print("=" * 60)

    # 加载笔记
    notes = load_notes()
    print(f"\n[1/5] 加载笔记: {len(notes)} 篇")

    # 选择话题
    topics = select_topics(notes, 100)
    print(f"[2/5] 选择话题: {len(topics)} 个")

    # 分配分类
    random.shuffle(topics)
    topic_assignments = []
    idx = 0
    for cat_name, cat_count in TOPIC_CONFIG:
        for _ in range(cat_count):
            if idx < len(topics):
                topic_assignments.append((topics[idx][1], cat_name))
                idx += 1

    print(f"[3/5] 分类分配:")
    cat_counts = {}
    for _, cat in topic_assignments:
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
    for cat, cnt in cat_counts.items():
        print(f"      {cat}: {cnt}")

    if args.dry_run:
        # 打印样例会展示
        print(f"\n[4/5] 生成示例（前5条）:")
        for i, (note, cat) in enumerate(topic_assignments[:5]):
            title, content, entities = build_topic_content(note, cat)
            print(f"\n  --- 主题 {i+1} [{cat}] ---")
            print(f"  标题: {title}")
            print(f"  内容: {content[:120]}...")
            images = get_note_images(note)
            if images:
                print(f"  图片: {images[:2]}")
        print(f"\n[5/5] ⚡ Dry-run 模式，未写入数据库")
        print(f"      去掉 --dry-run 执行实际写入")
        return

    # ── 实际执行 ──
    conn = get_db()
    print(f"\n[4/5] 连接数据库: {DB_CONFIG['host']}")

    # 加载 checkpoint
    checkpoint_data = {"users": [], "threads": []}
    if args.checkpoint and os.path.exists(args.checkpoint):
        with open(args.checkpoint) as f:
            checkpoint_data = json.load(f)
        print(f"  恢复 checkpoint: {len(checkpoint_data['threads'])} 个已完成的主题")

    completed_users = set(checkpoint_data.get("users", []))
    completed_titles = set(checkpoint_data.get("threads", []))

    # 获取版块 ID
    board_ids = {slug: get_board_id(conn, slug) for slug in BOARDS}

    print(f"\n[5/5] 开始生成...")

    # 1. 创建用户（跳过已存在的）
    user_ids = {}
    user_pool = []
    for persona in USER_PERSONAS:
        username, level, bio, _ = persona
        if username in completed_users:
            # 从数据库找回 ID
            cur = conn.execute('SELECT id FROM users WHERE username = %s', (username,))
            row = cur.fetchone()
            if row:
                user_ids[username] = row[0]
                user_pool.append(username)
                continue

        email = f"{username.lower()}@puer.tea"
        password = "puer123"
        try:
            uid = create_user(conn, username, email, password, level, bio)
            user_ids[username] = uid
            user_pool.append(username)
            completed_users.add(username)
            print(f"  ✓ 用户 {username} (Lv.{level})")
        except Exception as e:
            print(f"  ✗ 用户 {username}: {e}")

    checkpoint_data["users"] = list(completed_users)
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump(checkpoint_data, f, ensure_ascii=False)

    # 2. 创建主题
    thread_count = 0
    for i, (note, category) in enumerate(topic_assignments):
        title, content_html, entities = build_topic_content(note, category)

        if title in completed_titles:
            continue

        # 选择发帖人（从不那么极端的用户中选）
        host = random.choice([u for u in user_pool if "狂热" not in str(u) and
                            "激进" not in str(u) and "极端" not in str(u)] or user_pool)
        host_id = user_ids[host]

        # 选择版块
        if category in ("市场闲话", "真假鉴别"):
            board_slug = "trade"
        elif category in ("冲泡心得", "茶区风土"):
            board_slug = "knowledge"
        else:
            board_slug = "puer"
        board_id = board_ids[board_slug]

        # 图片
        images = get_note_images(note)[:5]
        image_urls = [f"/uploads/evernote/{img}" for img in images]

        # 把图片嵌入到内容中（<img> 标签跟在正文后）
        if image_urls:
            img_tags = "".join(
                f'<img src="{url}" alt="" />' for url in image_urls
            )
            content_html = content_html[:-5] + img_tags + content_html[-5:]

        # 发布时间（过去30天内随机分布）
        base_time = datetime.now() - timedelta(days=random.randint(0, 30),
                                                hours=random.randint(0, 23))

        try:
            article_id = create_thread(conn, title, content_html, host_id, board_id,
                                       image_urls, base_time)
            thread_count += 1
            print(f"  [{i+1}/{len(topic_assignments)}] {category}: {title[:50]}...")

            # 3. 生成回帖
            reply_users = random.sample(
                [u for u in user_pool if u != host],
                min(random.randint(3, 5), len(user_pool) - 1)
            )

            reply_ids = []
            for ri, ruser in enumerate(reply_users):
                rid = user_ids[ruser]
                rtime = base_time + timedelta(hours=random.randint(1, 48),
                                             minutes=random.randint(0, 59))

                # 某些回帖带图片
                r_images = []
                if random.random() < 0.25 and images:
                    r_images = [random.choice(image_urls)]

                r_content = build_reply(note, ruser)
                if len(r_content) > 200:
                    r_content = r_content[:200]

                try:
                    cid = create_comment(conn, r_content, rid, article_id,
                                        r_images, rtime)
                    reply_ids.append(cid)
                except Exception as e:
                    print(f"    ✗ 回帖失败: {e}")
                    continue

                # 嵌套回复（30%概率）
                if ri > 0 and random.random() < 0.3 and reply_ids:
                    nested_user = random.choice([u for u in reply_users if u != ruser])
                    nested_id = user_ids[nested_user]
                    ntime = rtime + timedelta(minutes=random.randint(5, 120))
                    n_content = build_reply(note, nested_user)
                    n_images = []
                    if random.random() < 0.2 and images:
                        n_images = [random.choice(image_urls)]
                    try:
                        create_comment(conn, n_content, nested_id, article_id,
                                      n_images, ntime, parent_id=random.choice(reply_ids))
                    except Exception:
                        pass

            # 更新帖子计数
            update_thread_counts(conn, article_id, len(reply_ids))

        except Exception as e:
            print(f"  ✗ 创建失败: {e}")
            continue

        # 每10个主题保存一次 checkpoint
        if thread_count % 10 == 0:
            completed_titles.add(title)
            checkpoint_data["threads"] = list(completed_titles)
            with open(CHECKPOINT_FILE, "w") as f:
                json.dump(checkpoint_data, f, ensure_ascii=False)

        # 写入间隔，避免数据库压力
        if thread_count % 5 == 0 and thread_count > 0:
            time.sleep(1)

    # 最终 checkpoint
    completed_titles.add("__done__")  # 标记完成
    checkpoint_data["threads"] = list(completed_titles)
    with open(CHECKPOINT_FILE, "w") as f:
        json.dump(checkpoint_data, f, ensure_ascii=False)

    conn.close()
    print(f"\n{'=' * 60}")
    print(f"  完成!")
    print(f"  用户: {len(user_ids)}")
    print(f"  主题: {thread_count}")
    print(f"  Checkpoint: {CHECKPOINT_FILE}")
    print(f"{'=' * 60}")

import time

if __name__ == "__main__":
    main()
