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

// 成对出现、内容必须连坐删除的标签。只删开闭标签会把里面的标记漏出来：
// `<style><img/src=x/onerror=alert(1)></style>` 删掉 <style> 标签后，
// 剩下的 <img/src=...> 会被浏览器当成正常标签解析 —— 2026-11-06 实测过的
// 存储型 XSS 载荷（帖子正文直接落库，渲染层只有这一道正则）。
const DANGEROUS_BLOCK_RE = /<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

// HTML5 的属性分隔符不只有空白：`<img/src=x/onerror=y>` 里的 `/` 也是分隔符，
// 浏览器会把它解析成 src + onerror 两个属性。旧的 `\s(on\w+)` 边界漏掉了这种写法。
const EVENT_HANDLER_RE = /(?:\s|\/)(on\w+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;

const JS_URL_RE = /\s(href|src|action|formaction|data|xlink:href)\s*=\s*"(?:\s*javascript\s*:)/gi;

/**
 * 消毒一段 HTML 字符串。返回安全的 HTML,不可逆。
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== "string") return "";

  const safe = html
    // 1) 先连内容一起删掉 script/style（只删标签会把内容漏成可执行标记）
    .replace(DANGEROUS_BLOCK_RE, "")
    // 2) 移除其余危险标签(iframe、object 等）
    .replace(DANGEROUS_TAG_RE, "")
    // 3) 移除所有 on* 事件处理器(如 onclick、onerror、onload)
    .replace(EVENT_HANDLER_RE, " ")
    // 4) 将 javascript: URL 替换为阻止地址(仍保留 href 供人工判断)
    .replace(JS_URL_RE, (_match, attr) => ` ${attr}="/_blocked_js/"`);

  return safe;
}
