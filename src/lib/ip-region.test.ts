import { test } from "node:test";
import assert from "node:assert/strict";

import { isPublicIp, parseRegionResponse } from "./ip-region.ts";

test("私网/保留地址不查（查了也没省份）", () => {
  for (const ip of [
    null,
    undefined,
    "",
    "unknown",
    "127.0.0.1",
    "::1",
    "10.0.0.5",
    "192.168.1.1",
    "172.16.0.1",
    "172.31.255.255",
    "169.254.1.1",
    "fd00::1",
  ]) {
    assert.equal(isPublicIp(ip as string | null), false, `${ip} 不该查`);
  }
});

test("公网地址要查", () => {
  for (const ip of ["114.114.114.114", "8.8.8.8", "223.5.5.5", "172.32.0.1"]) {
    assert.equal(isPublicIp(ip), true, `${ip} 该查`);
  }
});

test("从服务商的返回里抠出省份", () => {
  assert.equal(
    parseRegionResponse({
      status: "success",
      country: "中国",
      countryCode: "CN",
      region: "SD",
      regionName: "山东",
    }),
    "山东",
  );
  // 境外地址带国名
  assert.equal(
    parseRegionResponse({
      status: "success",
      country: "United States",
      countryCode: "US",
      region: "CA",
      regionName: "California",
    }),
    "United States · California",
  );
  // 失败 / 空 / 非对象 → 查不到
  assert.equal(parseRegionResponse({ status: "fail", message: "reserved range" }), null);
  assert.equal(parseRegionResponse({ status: "success" }), null);
  assert.equal(parseRegionResponse(null), null);
  assert.equal(parseRegionResponse("boom"), null);
});
