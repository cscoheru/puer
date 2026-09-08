# puer-hub 微信小程序实施计划(2026-07-15)

> 状态:**已制定,待决策**。用户暂不开发,晚点再考虑是否做。
> 决策已锁定:**原生微信小程序 + 全功能(含视频) + 微信登录打通**;网站继续保留不动。

## 核心架构

小程序 = **新建独立前端工程**,通过 HTTPS `wx.request` 调用现有 Next.js `/api/*`。
后端(审核/鉴权/Prisma/DB/uploads)零改动复用,前端 UI 全部用 WXML/WXSS 重写。
网站(Next.js 全栈)不动,Web 与小程序共享同一套数据。

```
微信小程序(新,原生) ──wx.request──► /api/* ──► Postgres/uploads
puer-hub 网站(保留) ──浏览器────────► /api/* ──┘
```

## 4 个阶段

### 阶段 0:前置准备(行政/资质 · 1~4 周 · 用户操作)
- [ ] 注册小程序账号(mp.weixin.qq.com),**企业主体**(社交类目+视频基本要企业)
- [ ] 微信认证(300 元/年)→ 才能选社交类目、用获取手机号等接口
- [ ] 选类目:**社交 → 社区/论坛**(UGC 必选)
- [ ] puer.im 已 ICP 备案 + 小程序后台配 `request 合法域名`(HTTPS)
- [ ] 视频资质评估(见下方策略)
- [ ] 装微信开发者工具
- 产出:`AppID` + `AppSecret`(AppSecret 仅放服务器环境变量,禁入 git)

### 阶段 1:后端适配(1 周 · 改 puer-hub 仓库)
现有 API 给浏览器 NextAuth(cookie)用,小程序要改 4 处:

1. **新增微信登录端点** `src/app/api/auth/wechat-login/route.ts`
   - 收 `wx.login()` code → 后端调微信 `code2session` 换 openid + session_key
   - User 表关联 openid:首次登录自动建号 / 绑定已有账号(打通)
   - 签发 JWT(复用 `AUTH_SECRET`)
2. **schema 改动**:`User` 加 `wechatOpenid String? @unique` + 迁移
3. **token 验证中间件**:解析 `Authorization: Bearer` 头,和现有 `auth()` cookie 通道并存(网站不受影响)
4. **内容安全替代**:Web 的 Turnstile 在小程序用不了 → 换微信官方 `security.msgSecCheck`(文本)/`imgSecCheck`(图片);**`moderation.ts` DeepSeek 审核闸端无关,直接复用**
5. **上传适配**:确认 `/api/upload` 接 `wx.uploadFile` multipart;视频上传改走腾讯云点播 VOD

> 关键风险:鉴权要从 cookie-only 扩展成 cookie + token 双通道。小程序 cookie 持久化不可靠,必须用显式 JWT token 存 storage + Authorization 头。

### 阶段 2:小程序前端工程(原生 · 2~4 周 · 新建独立工程)
```
mp-weixin/
├── app.js / app.json / app.wxss
├── pages/
│   ├── index/      # 首页(热榜/最新/精华)
│   ├── thread/     # 帖子详情+评论
│   ├── new-post/   # 发帖(图片上传)
│   ├── exchange/   # 互换大厅
│   ├── sessions/   # 云喝茶
│   ├── tasting/    # 茶记
│   ├── video/      # 视频播放(一期只播服务端已有)
│   └── user/       # 个人中心
└── utils/{request,auth}.js
```
可从现有 `src/lib/` 抽出共享:TS 类型、接口字段约定、`forum-constants.ts`、时间格式化。UI 全重写。

### 阶段 3:联调 · 提审 · 上线(1~2 周)
- 真机调试 + 体验版测试
- 提审:类目对齐、内容安全接入证据、隐私政策
- 发布

## ⚠️ 视频过审策略(关键)
微信对"用户上传视频(UGC 视频)"要求视听类资质,个人主体几乎过不了、企业也难。
**务实做法:技术上一期全做完,但第一期提审时只开"播放服务端已有历史视频"(展示型),
用户视频上传入口隐藏。先靠"社交>社区"类目过审拿账号,第二期再开用户上传。**

## 3 个关键决策
| 决策 | 推荐 | 原因 |
|------|------|------|
| 主体类型 | 企业主体 | 社交类目+视频,个人主体走不通 |
| 视频上传上线 | 第二期再开 | 一期先过审拿资质,避免一次性被拒 |
| 视频存储 | 腾讯云点播 VOD | 自家服务器扛不住转码+流量,VOD 自带审核 |

## 启动条件
AppID/AppSecret 到手 + 企业认证通过 → 即可开工阶段 1。
阶段 0(注册/认证/备案)可与阶段 1 并行,建议尽早注册(企业认证要几天)。
