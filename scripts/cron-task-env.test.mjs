/**
 * cron 包装层的**接线**断言。
 *
 * ## 为什么需要这个测试
 *
 * `scripts/cellar-reminders.mjs` 认 `CELLAR_REMINDERS_PAUSED=1` 这个暂停开关，
 * `scripts/crontab.txt` 与 `scripts/KILL_SWITCHES.md` 也都告诉运维
 * 「写在 .env 里就能一键暂停」——
 *
 * 但 cron 实际跑的是 `scripts/cron-task.sh`，它要**自己**把 .env 里的变量
 * export 出来。漏一个，脚本就拿不到 → **「一键暂停」是死的**：站长在 .env 里
 * 写了 `CELLAR_REMINDERS_PAUSED=1`，提醒照发不误，而且没有任何报错。
 *
 * 这跟「半切换等于没切换」是同一类事故，而且**不会报错**。
 * 所以这里直接把两边的 env 清单求差集：脚本读的每一个 env，包装层必须传。
 *
 * Run: npm run test:unit
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const CRON = readFileSync(
  new URL("./cron-task.sh", import.meta.url),
  "utf8",
);

/** 脚本里读的 env 变量名（process.env.X）。 */
function envNamesUsed(src) {
  const out = new Set();
  for (const m of src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) {
    out.add(m[1]);
  }
  return out;
}

/** 包装层传下去的变量名（`export X=` 与 `docker exec -e X` 都算）。 */
function envNamesExported(src) {
  const out = new Set();
  for (const m of src.matchAll(/export\s+([A-Z][A-Z0-9_]*)=/g)) {
    out.add(m[1]);
  }
  for (const m of src.matchAll(/(?:^|\s)-e\s+([A-Z][A-Z0-9_]*)=/gm)) {
    out.add(m[1]);
  }
  return out;
}

const SCRIPTS = [
  { file: "cellar-reminders.mjs", task: "cellar-reminders" },
  { file: "auto-post.mjs", task: "auto-post" },
  { file: "ai-news-draft.mjs", task: "ai-news-draft" },
  { file: "rag-post.mjs", task: "rag-post" },
];

test("脚本读的每一个 env，cron-task.sh 都必须 export 下去", () => {
  const exported = envNamesExported(CRON);
  for (const { file } of SCRIPTS) {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    for (const name of envNamesUsed(src)) {
      // 少数是「可选增强」：脚本内部有默认值，不传就用默认值，不会让功能失效。
      // ⚠️ **暂停开关不在这个名单里** —— 它们没有默认值，不传就等于「开关是死的」。
      const optional = new Set([
        "NODE_ENV",
        "PENTAGI_ARTIFACT_HOST",
        "EDITOR_AUTHOR_UIDS",
        "NEWS_ARTIFACT_LOCAL_DIR",
        "NEWS_ARTIFACT_MAX_AGE_DAYS",
        "NEWS_AUTHOR_USERNAME",
        "NEWS_DRAFT_LIMIT",
        "PENTAGI_ARTIFACT_DIR",
        "PENTAGI_FEEDBACK_DIR",
        "RAG_CHUNKS_FILE",
        "RAG_POST_DAILY_CAP",
        "DRY_RUN",
        // auto-post 的「只处理这几条笔记」白名单（不传 = 全部，由脚本内
        // 的其他闸门限流）
        "AUTO_TEA_DRAFT_NOTE_IDS",
        "AUTO_DRAFT_LIMIT",
        "AUTO_DRAFT_DAILY_CAP",
      ]);
      if (optional.has(name)) continue;
      assert.ok(
        exported.has(name),
        `${file} 读了 ${name}，但 cron-task.sh 没 export —— cron 跑起来它拿不到（多半是「开关是死的」）`,
      );
    }
  }
});

test("复饮提醒的暂停开关与上限必须被传下去", () => {
  const exported = envNamesExported(CRON);
  for (const name of [
    "CELLAR_REMINDERS_PAUSED",
    "CELLAR_REMINDERS_MAX_PER_RUN",
    "CELLAR_REMINDERS_MAX_PER_USER",
  ]) {
    assert.ok(
      exported.has(name),
      `${name} 没被 cron-task.sh export —— 「一键暂停」就是死的`,
    );
  }
});

test("cron-task.sh 认得所有在 crontab.txt 里出现的任务", () => {
  const crontab = readFileSync(new URL("./crontab.txt", import.meta.url), "utf8");
  const tasks = new Set();
  for (const m of crontab.matchAll(/cron-task\.sh\s+([a-z-]+)/g)) {
    tasks.add(m[1]);
  }
  assert.ok(tasks.size > 0, "crontab.txt 里应该能看到任务名");
  for (const task of tasks) {
    assert.ok(
      CRON.includes(`${task})`) || CRON.includes(`${task}|`),
      `crontab.txt 里有任务「${task}」，但 cron-task.sh 没有这个分支（会退到 exit 64）`,
    );
  }
});
