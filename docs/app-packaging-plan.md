# PuerHub 原生 App 打包方案（规划稿）

> **状态：规划完成，暂停开发** —— 待重启时从 Phase 0 开始。
> 创建：2026-09-10 · 基于 puer-hub 当前架构（Next.js 16 SSR / next-auth v5 / socket.io / puer.im）

## 一、目标

将 puer.im 整体打包为 iOS/Android 原生 App；**先 iOS App Store 上线，测试 OK 后再 Android**。
当前阶段仅完成可行性评估与方案设计，未投入开发。

## 二、可行性评估（已完成的代码/生产环境探查结论）

| 项 | 现状 | 对打包 App 的影响 |
|---|---|---|
| 站点形态 | Next.js 16 SSR 动态站（`output: standalone`），`puer.im` + HTTPS（nginx/Let's Encrypt） | 不能静态导出 → 放弃「本地打包页面」路线，走**远程加载壳** |
| 认证 | next-auth v5 Credentials（账号/UID/邮箱+密码），JWT session，httpOnly cookie | 同域 first-party cookie，WKWebView 友好；无三方 OAuth → 不触发「必须集成 Sign in with Apple」 |
| WebSocket | socket.io 同源（`NEXT_PUBLIC_WS_URL` 空 → same-origin） | WKWebView 支持 ✓ |
| 图片上传 | `/api/upload` 分片上传，同域 | 无跨域问题；file input 由 Capacitor 桥接相机/相册 ✓ |
| 人机验证 | Cloudflare Turnstile | ⚠️ 唯一高风险点：Turnstile 在 WKWebView 可能挑战失败，PoC 首验；失败对策 = 服务端按 App UA 豁免 + 频控 |
| UGC | 有举报 API（`/api/reports`） | 满足 App Store 1.2 UGC 要求（举报+阻断），提审时说明 |
| 付费内容 | 无 | 无 IAP 风险 ✓ |

**结论：可行，走低改造路径。**

## 三、方案选型

**采用：Capacitor 壳 + 远程加载 `https://puer.im`**
- 一个工程双端（iOS WKWebView / Android WebView）复用；网站迭代即时生效，App 发版解耦；服务端改造近零
- 否决项：PWA/TWA（iOS 不能上 App Store）、React Native/Expo 重写（tiptap 等大量 web-only 功能，成本极高）

## 四、分阶段计划

### Phase 0 · 可行性验证 PoC（零成本，≈1 工作日）
1. 新建 `app-shell/` Capacitor 工程（独立目录，不动现有网站代码）
2. iOS Simulator 冒烟清单：登录/cookie 持久（杀进程重开）→ 发帖+tiptap+图片上传（相册/相机）→ socket.io 在线状态 → **Turnstile（第一优先）** → 视频播放/外链行为
3. 产出《可行性报告》+ 风险关闭清单

### Phase 1 · iOS App Store 上线（≈2–4 天开发 + 1–3 天审核）
- **前置（用户操作）**：注册 Apple Developer Program（个人，688 元/年）——**可用免费 Apple ID 先行**：Simulator 免账号、真机 sideload 免费（7 天过期需重装）；仅 TestFlight/上架/推送/Universal Links 必须付费。交费决策推迟到 PoC 成功之后。
- 开发：图标/启动屏、原生增强（下拉刷新、外链→Safari、离线提示、分享 sheet）、`apple-app-site-association`（付费后）
- TestFlight 内测 → 用户验收
- App Store Connect：截图（6.7"）、隐私标签（按实际：联系方式/用户内容/标识符）、审核备注（提供 demo 账号 + UGC 举报机制说明）→ 提审

### Phase 2 · Android（iOS 验收后，≈1 天 + 渠道时间）
- 同一 Capacitor 工程加 Android 平台，复用全部逻辑
- 渠道决策：Google Play（$25 一次性，海外）vs 国内商店（需软著+备案 1–2 月）——届时再定

### 服务端可选改动（均不阻塞）
- `/api/app/version` 壳版本检查；Turnstile 的 App-UA 豁免（仅 PoC 失败时）

## 五、风险清单

| # | 风险 | 对策 |
|---|---|---|
| R1 | Turnstile 在 WKWebView 挑战失败 | PoC 首验；服务端按 App UA 豁免 + 频控兜底 |
| R2 | 审核 4.2（功能单薄的壳） | 原生增强 + 完整审核材料（demo 账号、举报机制说明）；内容型社区 4.3 风险低 |
| R3 | cookie 持久性 | JWT httpOnly + first-party 理论持久；PoC 实测杀进程重开 |
| R4 | 图片上传 file input | Capacitor 桥接成熟；PoC 实测相机/相册 |

## 六、重启入口

重启开发时：读本文档 → 从 Phase 0 第 1 步开始（`app-shell/` Capacitor 工程搭建）。
