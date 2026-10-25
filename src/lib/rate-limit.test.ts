import { test } from "node:test";
import assert from "node:assert/strict";

import { getClientIP, rateLimitKey } from "./rate-limit.ts";

/** 造一个只有 headers 的假 Request。 */
function req(headers: Record<string, string>): Request {
  return { headers: new Headers(headers) } as unknown as Request;
}

test("取 X-Real-IP（nginx 覆盖写的那一个）", () => {
  assert.equal(
    getClientIP(req({ "x-real-ip": "111.45.23.33" })),
    "111.45.23.33",
  );
});

test("伪造的 X-Forwarded-For **第一段**不作数", () => {
  // 客户端自己塞的第一段是假的，nginx 追加的最后一段才是真的
  assert.equal(
    getClientIP(
      req({
        "x-real-ip": "111.45.23.33",
        "x-forwarded-for": "8.8.8.8, 111.45.23.33",
      }),
    ),
    "111.45.23.33",
    "必须以 nginx 写的 X-Real-IP 为准",
  );
});

test("没有 X-Real-IP 时，取 X-Forwarded-For 的最后一段", () => {
  assert.equal(
    getClientIP(req({ "x-forwarded-for": "8.8.8.8, 111.45.23.33" })),
    "111.45.23.33",
    "第一段是客户端写的，不能信",
  );
  assert.equal(
    getClientIP(req({ "x-forwarded-for": "111.45.23.33" })),
    "111.45.23.33",
  );
});

test("两个头都没有 → unknown", () => {
  assert.equal(getClientIP(req({})), "unknown");
  assert.equal(getClientIP(req({ "x-forwarded-for": "  ,  " })), "unknown");
});

test("限速键把 IP 和用途拼在一起", () => {
  assert.equal(rateLimitKey("1.2.3.4", "login"), "1.2.3.4:login");
  assert.equal(rateLimitKey("1.2.3.4"), "1.2.3.4");
});
