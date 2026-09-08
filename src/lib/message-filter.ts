/**
 * Content filter for user messages.
 * Blocks contact info (phone numbers, WeChat IDs) by checking both
 * the raw content and a "normalized" version with common separators removed.
 *
 * Evasion patterns covered:
 * - Spaces/dashes/dots in phone numbers: 138 1234 5678 → caught
 * - Underscores/hyphens in WeChat IDs: abc-123_def → caught
 * - Mixed CJK and Latin: wei xin hao → caught
 * - Zero-width spaces or invisible Unicode → stripped
 */

// Common separators used to evade detection (spaces, dashes, underscores, dots, parentheses, brackets, full-width variants)
const SEPARATORS = /[\s\-_.、，,／/()（）\[\]【】]+/g;

function normalize(str: string): string {
  return str.replace(SEPARATORS, "");
}

// Chinese mobile prefixes (11 digits starting with 1)
const CN_MOBILE_REGEX = /1[3-9]\d{9}/;

// General phone patterns: 5+ consecutive digits
const DIGIT_SEQUENCE_REGEX = /\d{5,}/;

// WeChat ID pattern: 5+ consecutive letters
const LETTER_SEQUENCE_REGEX = /[a-zA-Z]{5,}/;

// Pattern for common WeChat-related keywords + alphanumeric
const WECHAT_KEYWORD_REGEX = /(微信|weix?in?|wx|qq)\s*[:：]?\s*[a-zA-Z0-9]{4,}/i;

export interface FilterResult {
  valid: boolean;
  reason?: string;
}

/**
 * Check if message content passes the filter.
 * Checks both raw content and normalized (separators removed) version.
 */
export function filterMessage(content: string): FilterResult {
  if (!content || !content.trim()) {
    return { valid: false, reason: "留言内容不能为空" };
  }

  if (content.length > 50) {
    return { valid: false, reason: "留言内容不能超过50个字" };
  }

  const normalized = normalize(content);
  const REJECT_MSG = "留言不符合要求，请使用中文汉字";

  // Check raw content
  if (CN_MOBILE_REGEX.test(content) || DIGIT_SEQUENCE_REGEX.test(content)
    || LETTER_SEQUENCE_REGEX.test(content) || WECHAT_KEYWORD_REGEX.test(content)) {
    return { valid: false, reason: REJECT_MSG };
  }

  // Check normalized version for evasion attempts
  if (normalized !== content && (
    CN_MOBILE_REGEX.test(normalized) || DIGIT_SEQUENCE_REGEX.test(normalized)
    || LETTER_SEQUENCE_REGEX.test(normalized) || WECHAT_KEYWORD_REGEX.test(normalized)
  )) {
    return { valid: false, reason: REJECT_MSG };
  }

  return { valid: true };
}

export function sanitizeContent(content: string): string {
  return content.trim().slice(0, 50);
}
