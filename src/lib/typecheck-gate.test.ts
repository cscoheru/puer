import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * 类型检查闸门的自检。
 *
 * 2026-10-23 出过一次真事故：`GET /api/cellar` 里引用了没声明的
 * `requestedPage`（348b6f6 删那行时漏了），于是**每次**列表请求都
 * ReferenceError → 500。整个「我的茶仓」列表页是坏的，而我当时报出去
 * 的是「tsc 对 src/ 干净」。
 *
 * tsc 当时为什么一声不吭？根因不在 tsc，在 `.next/dev/types/validator.ts`
 * —— 那是 dev server 每次改路由就重写的 66KB 生成文件，那次被写了一半，
 * 留下 4 个语法错。**一个文件的语法错会让 tsc 整程放弃语义检查**，
 * 于是 src/ 里任何类型错误都看不见，退出码还是 0。
 *
 * 也就是说：**一个会静默退化的验证命令，比没有验证命令更坏** ——
 * 它让人以为验过了。所以这里做三件事：
 *
 *  1. 闸门自检：故意放一个错进 program，跑一遍 tsc，**断言它被抓到**。
 *     哪天闸门又哑了，这条测试当场变红，而不是让下一个 bug 溜过去。
 *  2. 断言 program 不是空的 —— 否则自检会「因为没东西可查」而假装通过。
 *  3. 断言 program 里**一个生成文件都没有** —— 这是「语法错毒死整程
 *     检查」的根治：没有生成文件，就没有被写坏的可能。
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const TSC_BIN = join(REPO_ROOT, "node_modules", "typescript", "bin", "tsc");
const TYPECHECK_CONFIG = join(REPO_ROOT, "tsconfig.typecheck.json");

/**
 * 读 tsconfig。
 *
 * tsconfig 允许写注释（这份配置里的「为什么」就该待在它旁边），
 * 而 JSON.parse 遇到注释直接抛 —— 用 TypeScript 自己的解析器。
 */
function readTsConfig(path: string): {
  include?: string[];
  exclude?: string[];
} {
  const parsed = ts.parseConfigFileTextToJson(path, readFileSync(path, "utf8"));
  if (parsed.error) {
    throw new Error(
      `解析 ${path} 失败：${ts.flattenDiagnosticMessageText(parsed.error.messageText, " ")}`,
    );
  }
  return parsed.config as { include?: string[]; exclude?: string[] };
}

interface GateRun {
  status: number | null;
  error: Error | undefined;
  out: string;
  files: string[];
}

let cached: GateRun | null = null;

/**
 * 跑一次「带探针」的类型检查，结果缓存 —— 下面两条断言共用同一次 tsc。
 *
 * 探针放在**仓库外**（系统临时目录）：放仓库里的话，进程被 SIGKILL /
 * CI 超时杀掉就会留下一个永久的类型错误，把 typecheck 与 next build
 * 一起搞挂 —— 一次中断的测试能让仓库再也构建不出来。
 */
function runGate(): GateRun {
  if (cached) return cached;

  const dir = mkdtempSync(join(tmpdir(), "typecheck-gate-"));
  try {
    const probe = join(dir, "probe.ts");
    writeFileSync(
      probe,
      [
        "export const probe: number = 'not a number';",
        // 用了没声明的名字 —— **就是这次漏掉 requestedPage 那一类**，
        // 它在 tsc 活着的时候必然报错，闸门哑了的时候必然不报。
        "export const called = someNameNobodyDeclared();",
        "",
      ].join("\n"),
      "utf8",
    );

    // 临时配置继承仓库那份，再把探针加进 program。
    // include 的相对路径按**声明它的那份配置**所在目录解析 —— 从基配置抄到
    // 临时配置里就得改成绝对路径，否则 program 里只剩探针，
    // 自检会「因为没东西可查」而假通过。
    const base = readTsConfig(TYPECHECK_CONFIG);
    const include = (base.include ?? []).map((p) => join(REPO_ROOT, p));
    const configPath = join(dir, "tsconfig.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        extends: TYPECHECK_CONFIG,
        include: [...include, probe],
        compilerOptions: { incremental: false },
      }),
      "utf8",
    );

    const res = spawnSync(
      process.execPath,
      [TSC_BIN, "--noEmit", "--listFiles", "-p", configPath],
      { cwd: REPO_ROOT, encoding: "utf8", timeout: 120_000 },
    );
    cached = {
      status: res.status,
      error: res.error,
      out: `${res.stdout ?? ""}\n${res.stderr ?? ""}`,
      files: `${res.stdout ?? ""}`.split("\n"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return cached!;
}

test("类型检查闸门是活的：故意塞的类型错误必须被抓到", () => {
  const run = runGate();
  assert.equal(run.error, undefined, `tsc 跑不起来：${run.error?.message}`);
  assert.notEqual(
    run.status,
    0,
    "tsc 退出码是 0 —— 探针的类型错误没让 tsc 失败",
  );

  // 语法错才是「闸门哑掉」的真正 signature：它会让 tsc 整程放弃语义检查。
  // 注意**不要**用 /error TS1\d{3}/ 这种号段通配 —— TS18048（可能是
  // undefined）这类语义错也在 TS1xxx 里，会把警报指向错误的根因
  // （半截写坏的生成文件），而闸门其实好好活着。
  assert.doesNotMatch(
    run.out,
    /error TS(1005|1109|1128|1136|1144|1160)\b/,
    "program 里有语法错误 —— 语法错会让 tsc 整程放弃语义检查（这才是闸门哑掉的样子）",
  );
  assert.match(
    run.out,
    /probe\.ts\(\d+,\d+\): error TS2322/,
    "闸门没抓到探针的类型错误 —— tsc 已经不做语义检查了",
  );
  assert.match(
    run.out,
    /probe\.ts\(\d+,\d+\): error TS2304/,
    "闸门没抓到探针的未声明标识符 —— 正是 requestedPage 漏掉的那一类",
  );
});

test("类型检查的 program 是健康的：有源码、探针在里、一个生成文件都没有", () => {
  const run = runGate();

  // 自检最容易假通过的方式：program 里压根没有东西可查。
  assert.ok(
    run.files.some((f) => f.endsWith("src/lib/pagination-limits.ts")),
    "类型检查的 program 里没有源码 —— 自检会「因为没东西可查」而假装通过",
  );
  assert.ok(
    run.files.some((f) => f.endsWith("probe.ts")),
    "探针不在 program 里 —— 这条自检根本没在测 tsc",
  );
  // 「语法错毒死整程检查」的根治：program 里没有生成文件，就没有写坏的可能。
  const generated = run.files.filter((f) => f.includes("/.next/"));
  assert.deepEqual(
    generated,
    [],
    `类型检查的 program 里混进了生成文件：${generated.join(", ")}`,
  );
});

test("类型检查的配置不含 next-env.d.ts", () => {
  // 它 import 的是 .next/dev/types/routes.d.ts —— 同样是 dev server 每次
  // 改路由就重写的文件，写坏时一样会毒死整程检查。
  const cfg = readTsConfig(TYPECHECK_CONFIG);
  assert.ok(
    !(cfg.include ?? []).some((p) => p.includes("next-env.d.ts")),
    "类型检查的配置里带了 next-env.d.ts —— 它 import 的 dev 生成文件会把闸门毒死",
  );
});

test("构建用的 tsconfig 排除了 dev 生成的类型文件", () => {
  // 构建走 tsconfig.json（next build 用它）。那里的 include 有
  // .next/dev/types/** —— 写坏时会让构建的类型检查整程放弃，
  // 构建失败得响亮，但别被一个跟构建无关的文件拖累。
  const tsconfig = readTsConfig(join(REPO_ROOT, "tsconfig.json"));
  assert.ok(
    (tsconfig.exclude ?? []).some((p) => p.includes(".next/dev/types")),
    "tsconfig.json 没排除 .next/dev/types —— dev server 每次改路由就重写的" +
      "生成文件，写坏时会让构建的类型检查整程放弃",
  );
});

test("package.json 有一个能跑的类型检查命令", () => {
  const pkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const cmd = pkg.scripts?.typecheck;
  assert.ok(cmd, "package.json 没有 typecheck 脚本 —— 闸门没有入口");
  assert.match(cmd, /tsc\b/, `typecheck 脚本不是 tsc：${cmd}`);
  assert.match(
    cmd,
    /tsconfig\.typecheck\.json/,
    "typecheck 脚本没用干净配置 —— 生成文件会把闸门毒死",
  );
});
