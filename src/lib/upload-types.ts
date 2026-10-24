/**
 * 上传的**类型与分类白名单** —— 客户端与服务端共用一份。
 *
 * ## 为什么单独立这个文件
 *
 * 这三样东西之前各写各的：服务端的 `upload-policy.ts`、客户端组件手抄的
 * 分类联合类型、评论区与茶仓各拼一遍的 video MIME 列表。加一个分类要改
 * 三个地方，漏一处**不会报错** —— 只表现为「前端能选、后端 400」，或者
 * 「评论里能传 quicktime、茶仓里不能」。
 *
 * 这个文件**不含任何 node 依赖**（没有 fs / path / crypto），所以客户端
 * 组件能直接 import 它 —— `upload-policy.ts` 讲的是文件系统与路径安全，
 * 客户端用不上那部分。
 */

/** 允许的上传分类。空串 = 未分类（落在默认子目录）。 */
export const UPLOAD_CATEGORIES = [
  "",
  "session",
  "avatar",
  "inventory",
  "tea",
] as const;
export type UploadCategory = (typeof UPLOAD_CATEGORIES)[number];

/** 分类 → uploads 下的子目录。 */
export const UPLOAD_SUBDIRS: Record<Exclude<UploadCategory, "">, string> = {
  session: "sessions",
  avatar: "avatars",
  inventory: "inventory",
  tea: "tea",
};

/**
 * 服务端允许的图片 MIME。
 *
 * 比客户端的 accept 宽：手机相册会送 avif/heic，浏览器选文件框给不出
 * 这些格式，但服务端得收（不然 iPhone 用户传不了图）。
 */
export const IMAGE_MIMES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
] as const;

/** 视频的 MIME 白名单 —— 服务端与两个前端控件共用。 */
export const VIDEO_MIMES = [
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

/** file input 的 accept 属性（图片）—— 选文件框给得出这些格式。 */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/gif,image/webp";

/** file input 的 accept 属性（视频）。 */
export const VIDEO_ACCEPT = VIDEO_MIMES.join(",");
