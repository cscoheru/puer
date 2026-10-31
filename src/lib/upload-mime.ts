/**
 * 上传文件的 **MIME 判定** —— 客户端与服务端共用同一份白名单。
 *
 * ## 为什么要有这个文件
 *
 * 2026-10-31 站长报「手机端发帖图片上传失败，文本帖可以发」。查出来根因**不在
 * 服务端**：服务端从一开始就把 avif/heic/heif 列进了白名单
 * （`upload-types.ts` 的 `IMAGE_MIMES`），入库时还用 ffmpeg + sharp 把
 * HEIC/AVIF 转成 JPEG，全链路都验过是通的。
 *
 * 真正的原因是**客户端自己手抄了一份更窄的白名单**：
 *
 * ```ts
 * const allowedTypes = ["image/jpeg","image/png","image/gif","image/webp", ...];
 * const newItems = Array.from(files).filter((f) => allowedTypes.includes(f.type));
 * ```
 *
 * 手机相册里的照片是 HEIC（iPhone 默认）或 AVIF（Android 10+），`f.type` 不在
 * 那份手抄列表里 → **被静默丢掉**：文件不进列表、不发请求、界面上连缩略图都没有
 * → 到了点提交才报「请至少上传一个文件」。文本帖不走这段代码，所以照常能发 ——
 * 这正是「只有图片失败、文本正常」的原因。
 *
 * 这也是 AGENTS.md 说的**数据双轨**：同一份白名单抄了好几遍，改服务端那份
 * 完全不影响客户端那份。
 *
 * ## 这个文件解决两件事
 *
 * 1. **格式够宽** —— 直接用 `upload-types.ts` 里服务端那份白名单（多 avif /
 *    heic / heif），不再手抄。
 * 2. **浏览器不给 type 时救回来** —— Android 的 WebView、微信内置浏览器从相册
 *    取文件时经常给 `type: ""` 或 `application/octet-stream`；这时按**扩展名**
 *    推断。推断不出来才拒绝。
 *
 * ## 不含 node 依赖
 *
 * 没有 fs / path / crypto，客户端组件可直接 import；纯函数，`node --test` 也能跑。
 */
// 带 .ts 后缀：node --test 直接跑 .ts 时不做扩展名补全（与 upload-policy.ts 一致）
import { IMAGE_MIMES, VIDEO_MIMES } from "./upload-types.ts";

/** 全部允许的上传 MIME（图片 + 视频）—— 与服务端 `upload-policy.ts` 同一份。 */
export const ALLOWED_UPLOAD_MIMES: readonly string[] = [...IMAGE_MIMES, ...VIDEO_MIMES];

const ALLOWED_SET = new Set<string>(ALLOWED_UPLOAD_MIMES);

/**
 * 扩展名 → MIME。
 *
 * 只覆盖「浏览器可能给不出 type」的那些常见后缀 —— 推断只是兜底，真正的判据
 * 仍然是内容（服务端入库前用 sharp 嗅探真实格式，不信声明的 MIME）。
 */
const EXT_MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jfif: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  heic: "image/heic",
  heif: "image/heif",
  hif: "image/heif",
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  qt: "video/quicktime",
};

/** 浏览器给不出（或给了个没意义的）type 时，用扩展名去猜。 */
const BLANK_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** 提示文案：各处保持一致，别再各写一份「只支持 JPG/PNG」。 */
export const UPLOAD_FORMAT_HINT =
  "支持 JPG / PNG / GIF / WebP / HEIC / AVIF 图片与 MP4 / WebM / MOV 视频";

/** 这个 MIME 允许吗？ */
export function isAllowedUploadMime(mime: string): boolean {
  return ALLOWED_SET.has(mime);
}

/**
 * 按文件名后缀猜 MIME。猜不出、或猜出来不在白名单里 → null。
 */
export function guessMimeFromName(name: string): string | null {
  const m = String(name || "")
    .toLowerCase()
    .match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const mime = EXT_MIME[m[1]];
  return mime && ALLOWED_SET.has(mime) ? mime : null;
}

export interface ResolvedUploadFile {
  /** 送进上传流程的文件 —— `type` 一定是非空且在白名单里的 MIME。 */
  file: File;
  /** 生效的 MIME。 */
  mime: string;
  /** true = 浏览器没给 type，按扩展名猜出来的。 */
  guessed: boolean;
  /** 是视频吗。 */
  isVideo: boolean;
}

/**
 * 把用户选的文件解析成「可以上传的文件」。
 *
 * - 返回 `null` = 这个格式不支持 —— 调用方**必须告诉用户**，不能静默丢弃。
 *   静默丢弃正是这次线上事故的形态：文件凭空消失，界面上没有任何提示。
 * - `kind` 限定只收图片或只收视频（品鉴笔记只收图，茶仓快速品鉴只收视频）。
 *
 * 猜出来的 MIME 会**写回文件**（`new File([...], name, {type})`）：multipart 的
 * Content-Type 与分片上传的 `X-File-Type` 头都是从 `file.type` 取的，不写回去
 * 服务端会收到空 type 并以「不支持的文件类型」拒绝。
 */
export function resolveUploadFile(
  file: File,
  kind?: "image" | "video",
): ResolvedUploadFile | null {
  const raw = String(file.type || "")
    .trim()
    .toLowerCase();

  let mime: string | null = null;
  let guessed = false;

  if (ALLOWED_SET.has(raw)) {
    mime = raw;
  } else if (BLANK_TYPES.has(raw)) {
    mime = guessMimeFromName(file.name);
    guessed = true;
  }
  if (!mime) return null;

  const isVideo = mime.startsWith("video/");
  if (kind === "image" && isVideo) return null;
  if (kind === "video" && !isVideo) return null;

  const resolvedFile = guessed
    ? new File([file], file.name, { type: mime, lastModified: file.lastModified })
    : file;

  return { file: resolvedFile, mime, guessed, isVideo };
}

/**
 * 汇总被跳过的文件，给用户一句人话。
 *
 * @param names 被拒绝的文件名
 * @param limit 最多列出几个文件名（超出用「等 N 个」收尾）
 */
export function describeRejectedFiles(names: string[], limit = 3): string {
  const shown = names.slice(0, limit).join("、");
  const rest = names.length > limit ? ` 等 ${names.length} 个文件` : "";
  return `${shown}${rest} 的格式不支持，已跳过（${UPLOAD_FORMAT_HINT}）`;
}
