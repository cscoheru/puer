/**
 * 茶仓开关必须同时声明在**三个** compose 源里。
 *
 * 背景（2026-10-23 实测）：`3588a61 feat(cellar): 把 FEATURE_CELLAR 透传进容器`
 * 只把开关加进了**仓库的** docker-compose.yml，但生产的
 * `/opt/puer-hub/docker-compose.yml` 是由 `scripts/deploy-standby.sh` 与
 * `scripts/failover.sh` 里的 heredoc 生成的 —— 而 app service **没有 env_file**，
 * `.env` 里的同名变量不会自动进容器。
 *
 * 结果：站长在服务器 .env 写 FEATURE_CELLAR=1，开关依然打不开；
 * 新加的 CELLAR_UIDS 也进不去，内测种子用户看不见茶仓 —— 且**没有任何报错**，
 * 表现只是「功能像是没生效」。这是「半切换等于没切换」的又一次现场。
 *
 * 这条测试就是让「半切换」不可能再悄悄发生。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

/** 会写到生产 `/opt/puer-hub/docker-compose.yml` 的三个来源。 */
const COMPOSE_SOURCES = [
  "docker-compose.yml",
  "scripts/deploy-standby.sh",
  "scripts/failover.sh",
] as const;

/** 茶仓需要透传进容器的变量。 */
const CELLAR_ENV_VARS = ["FEATURE_CELLAR", "CELLAR_UIDS"] as const;

/**
 * 取一份 compose 文本里 `app:` service 那一段。
 *
 * compose 里 service 名是 2 空格缩进，嵌套键是 4 空格，所以按「2 空格 + 词 + 冒号」
 * 切分就能定位到下一个 service。
 */
function appServiceBlock(compose: string, source: string): string {
  const services = [...compose.matchAll(/^ {2}([a-zA-Z0-9_-]+):[ \t]*$/gm)];
  const appIdx = services.findIndex((m) => m[1] === "app");
  assert.ok(appIdx >= 0, `${source} 里找不到 app service`);
  const start = services[appIdx].index!;
  const end = services[appIdx + 1]?.index ?? compose.length;
  return compose.slice(start, end);
}

/**
 * 取一份 compose 源里的 compose 正文。
 *
 * 脚本里的 compose 是 heredoc，正文要从 heredoc 里剥出来 —— 直接对整个
 * bash 脚本做 service 切分会误伤脚本正文里的缩进行。
 */
function composeText(source: string): string {
  const raw = readFileSync(path.join(process.cwd(), source), "utf8");
  if (!source.endsWith(".sh")) return raw;
  const heredoc = raw.match(
    /cat > \/opt\/puer-hub\/docker-compose\.yml << 'DOCKERCOMPOSE'\n([\s\S]*?)\nDOCKERCOMPOSE/,
  );
  assert.ok(heredoc, `${source} 里找不到生成 /opt/puer-hub/docker-compose.yml 的 heredoc`);
  return heredoc[1];
}

test("每个 compose 来源的 app service 都透传茶仓开关与白名单", () => {
  for (const source of COMPOSE_SOURCES) {
    const app = appServiceBlock(composeText(source), source);
    for (const name of CELLAR_ENV_VARS) {
      const decl = `${name}: \${${name}:-`;
      assert.ok(
        app.includes(decl),
        `${source} 的 app service 必须声明 "${decl}" —— app service 没有 env_file，` +
          `漏在这里就等于「站长改了 .env 但开关打不开」`,
      );
    }
  }
});

test("compose 透传的 CELLAR_UIDS 能被白名单判定读到", () => {
  // 接上「compose 透传」与「代码读取」两段：白名单函数认的是 env 里的逗号串，
  // compose 写的格式如果变了（比如从逗号改成别的分隔符），这里会红。
  const compose = composeText("docker-compose.yml");
  const match = compose.match(/CELLAR_UIDS:\s*\$\{CELLAR_UIDS:-([^}]*)\}/);
  assert.ok(match, "docker-compose.yml 里找不到 CELLAR_UIDS 透传");
  const injected = match[1].trim();
  assert.equal(injected, "", "仓库 compose 里 CELLAR_UIDS 默认应为空（名单由站长在 .env 里给）");
});
