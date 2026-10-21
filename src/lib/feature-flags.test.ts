import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isFeatureEnabled,
  featureFlagEnvKey,
  featureFlagSnapshot,
  FEATURE_FLAGS,
  type FeatureFlagName,
} from "./feature-flags.ts";

const NAMES = Object.keys(FEATURE_FLAGS) as FeatureFlagName[];

test("每个 flag 都有对应的环境变量名", () => {
  for (const name of NAMES) {
    const key = featureFlagEnvKey(name);
    assert.match(key, /^FEATURE_[A-Z0-9_]+$/, `${name} 的 env key 命名不对`);
  }
});

test("无环境变量时用代码内默认值", () => {
  for (const name of NAMES) {
    assert.equal(isFeatureEnabled(name, {}), FEATURE_FLAGS[name]);
  }
});

test("环境变量显式覆盖默认值（1/0 与 true/false 都认）", () => {
  for (const name of NAMES) {
    const key = featureFlagEnvKey(name);
    assert.equal(isFeatureEnabled(name, { [key]: "0" }), false);
    assert.equal(isFeatureEnabled(name, { [key]: "1" }), true);
    assert.equal(isFeatureEnabled(name, { [key]: "false" }), false);
    assert.equal(isFeatureEnabled(name, { [key]: "true" }), true);
    assert.equal(isFeatureEnabled(name, { [key]: "on" }), true);
    assert.equal(isFeatureEnabled(name, { [key]: "off" }), false);
    // 大小写与空白
    assert.equal(isFeatureEnabled(name, { [key]: " TRUE " }), true);
  }
});

test("无法识别的环境变量值按默认值处理，不当作关闭", () => {
  // 关键：值写错（比如 "yes please"）时**不能**静默变成关闭 ——
  // 保护性功能被一个拼错的变量静默关掉，比不生效更危险。
  for (const name of NAMES) {
    const key = featureFlagEnvKey(name);
    assert.equal(isFeatureEnabled(name, { [key]: "maybe" }), FEATURE_FLAGS[name]);
    assert.equal(isFeatureEnabled(name, { [key]: "" }), FEATURE_FLAGS[name]);
  }
});

test("反滥用类 flag 默认开启（保护不能默认失效）", () => {
  assert.equal(FEATURE_FLAGS.antiAbuseRateLimit, true);
  assert.equal(FEATURE_FLAGS.antiAbusePaginationCap, true);
});

test("快照列出全部 flag 状态", () => {
  const snap = featureFlagSnapshot({});
  assert.deepEqual(Object.keys(snap).sort(), [...NAMES].sort());
  for (const name of NAMES) {
    assert.equal(typeof snap[name], "boolean");
  }
});
