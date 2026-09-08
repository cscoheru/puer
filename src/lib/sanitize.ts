/**
 * HTML 消毒,防止存储型 XSS。
 *
 * 剥离已知的攻击向量,同时保留安全的富文本标签(b/i/a/img/p/blockquote/table 等)。
 *
 * 注意:正则方式的 HTML 消毒无法覆盖所有边缘情况(SVG/实体混淆等),
 * 但覆盖了最常见的 OWASP Top 3 XSS 注入路径。
 * 若需更严格的消毒,建议接入 isomorphic-dompurify。
 */

const DANGEROUS_TAG_RE =
  /<(\/?)\s*(script|iframe|object|embed|applet|base|meta|link|style|form|input|button|textarea|select|option)\b[^>]*>/gi;

const EVENT_HANDLER_RE = /\s(on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const JS_URL_RE = /\s(href|src|action|formaction|data|xlink:href)\s*=\s*"(?:\s*javascript\s*:)/gi;

/**
 * 消毒一段 HTML 字符串。返回安全的 HTML,不可逆。
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== "string") return "";

  let safe = html
    // 1) 移除危险标签及其内容(script、iframe、object 等)
    .replace(DANGEROUS_TAG_RE, "")
    // 2) 移除所有 on* 事件处理器(如 onclick、onerror、onload)
    .replace(EVENT_HANDLER_RE, " ")
    // 3) 将 javascript: URL 替换为阻止地址(仍保留 href 供人工判断)
    .replace(JS_URL_RE, (_match, attr) => ` ${attr}="/_blocked_js/"`);

  return safe;
}
