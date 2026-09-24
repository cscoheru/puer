# deploy/nginx/

`puer.conf` 是 **puer.im 生产 nginx site 配置的逐字副本**（`/etc/nginx/sites-enabled/puer`）。

## 为什么要放在仓库里

见 AGENTS.md R27 规则 1：凡「先改服务器、后补提交」的热修复，当场必须回传 git，
否则下一次部署/重建会静默回滚。nginx 配置不在任何 rsync 白名单里，所以它**不会**
被自动同步 —— 本文件是**人工保管的权威副本**，用于：

1. 服务器配置损坏时快速重建；
2. review 时能看到线上真实的 location / header 策略；
3. 避免「改了服务器但没人知道原来的值是什么」。

## 同步纪律

- **改服务器后**：`scp puer-hk:/etc/nginx/sites-enabled/puer deploy/nginx/puer.conf` 回来并 commit。
- **改本文件后**：必须手工 `scp` 上服务器 + `nginx -t` + `nginx -s reload`（**不会**自动生效）。
- 本文件**不含密钥**：证书用的是 `/etc/letsencrypt/` 路径引用，私钥不在仓内。

## 已知运维状态（2026-09-24）

- nginx 由官方 mainline 源安装（1.31.6），`nginx` / `nginx-core` 已 `apt-mark hold`。
- **systemd 单元处于 failed 且 master 是手工启动的**（PID 1066704，2026-09-16 起）。
  `systemctl reload nginx` 会报 `nginx.service is not active` —— 用
  `nginx -s reload` 代替。单元仍是 `enabled`，重启后 systemd 会正常拉起。

## uploads 缓存策略

四个 uploads location 统一 `Cache-Control: public, max-age=2592000, immutable`（30 天）。
注意 `expires 30d` 与 `add_header Cache-Control` 同时存在时，nginx 只用后者作为
`Cache-Control` 的值（`expires` 仍输出 `Expires` 头），实测**不会**产生重复头 ——
这与 `docs/plans/2026-09-24-seo-geo-optimization.md` 里的初判不同。

## ⚠️ add_header 不叠加：uploads location 必须自带安全头

nginx 的 `add_header` **不做继承叠加**：一个 location 里只要出现**任意一条** `add_header`，
该 location 就不再继承 server 级的**全部** `add_header`。

server 级（本文件 `:42-46`）有 5 条安全头：HSTS / X-Frame-Options / nosniff / COOP /
Referrer-Policy。四个 uploads location 各自声明了 `add_header Cache-Control`，
因此在 2026-09-24 之前，`/uploads/*` 的响应里**一条安全头都没有** —— 其中
`/uploads/forum/` 是用户上传内容且与站点同源，缺 `nosniff` 属于实际攻击面。

已于 2026-09-24 在每个 uploads location 里补上这 5 条（线上实测已生效）。
**今后给这些 location 增删 `add_header` 时，必须连带维护这 5 行。**

同一原因，`location /pikafish/`（静态 SPA，`:96` 有 `add_header Cache-Control`）同样丢掉了
server 级安全头。它是另一套应用、不服务用户上传内容，本次未动 —— 待评估。
