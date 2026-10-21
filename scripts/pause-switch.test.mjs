/**
 * F0「定时发布每日上限和一键暂停开关」的开关测试。
 *
 * 每日上限已存在（auto-post 的 AUTO_DRAFT_DAILY_CAP / tea-drafts 的
 * dailyCap），本文件只盯**一键暂停**：两条定时草稿管线在暂停时必须
 * 不查库、不写任何行、以退出码 0 结束（主动暂停不是故障，cron 不该记
 * ALERT 告警）。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

const CASES = [
  { file: "auto-post.mjs", env: "AUTO_DRAFT_PAUSED" },
  { file: "ai-news-draft.mjs", env: "AUTO_NEWS_DRAFT_PAUSED" },
];

test("暂停开关：开启时退出码 0 且明确打印已暂停", () => {
  for (const { file, env } of CASES) {
    const r = spawnSync(process.execPath, [path.join("scripts", file)], {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        [env]: "1",
        // 指向一个死地址：若脚本仍去连库/连网，这里会超时或报错而非退出 0。
        DATABASE_URL: "postgresql://nobody:nobody@127.0.0.1:1/none",
        MINIMAX_API_KEY: "",
      },
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.equal(r.status, 0, `${file} 暂停时应退出 0（stderr: ${r.stderr?.slice(0, 300)}）`);
    assert.match(
      r.stdout + r.stderr,
      /已暂停/,
      `${file} 暂停时应打印「已暂停」`,
    );
  }
});

test("暂停开关：未设置时不因开关本身失败（走后续正常校验）", () => {
  // 不设开关 → 脚本会继续往下走，可能因为缺 env 失败，但**不得**因为
  // 「开关没开」而失败。断言是：输出里不含「已暂停」。
  for (const { file, env } of CASES) {
    const childEnv = { ...process.env };
    delete childEnv[env];
    childEnv.DATABASE_URL = "postgresql://nobody:nobody@127.0.0.1:1/none";
    childEnv.MINIMAX_API_KEY = "";
    const r = spawnSync(process.execPath, [path.join("scripts", file)], {
      cwd: REPO_ROOT,
      env: childEnv,
      encoding: "utf8",
      timeout: 30_000,
    });
    assert.doesNotMatch(
      r.stdout + r.stderr,
      /已暂停/,
      `${file} 未开启暂停开关时不应打印「已暂停」`,
    );
  }
});
