#!/usr/bin/env node

/**
 * probe-password-pattern.mjs — 探查机器账号的密码模式。
 *
 * 站长给的判据：合成账号的密码是 **uid + "88"**（如 uid1073 → "107388"），
 * 真人账号的密码是各自设的、与 uid 无关。批量注册后送给真实茶友的账号
 * （黑马 1073、俗尘满腹 1072）如果本人改过密码，就不再匹配该模式。
 *
 * 这个探查只做一件事：对每个账号 bcrypt.compare 一次，统计匹配情况。
 * **不改任何数据** —— 它是判据的取证工具。
 *
 * Run:
 *   node --import tsx scripts/probe-password-pattern.mjs [--pattern 88]
 */

import bcrypt from "bcryptjs";
import { PrismaClient } from "../src/generated/prisma/client.js";

const argi = process.argv.indexOf("--pattern");
const PATTERN = argi >= 0 ? process.argv[argi + 1] : "88";

function log(msg) {
  console.log(msg);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("ERROR: missing DATABASE_URL");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true,
        uid: true,
        username: true,
        email: true,
        role: true,
        passwordHash: true,
        isSynthetic: true,
        nickname: true,
        registrationIp: true,
        _count: { select: { comments: true, articles: true } },
      },
      orderBy: { uid: "asc" },
    });

    // 候选模式：站长给的 uid+88，加上两个种子脚本用的固定密码。
    const CANDIDATES = [
      { label: `uid+"${PATTERN}"`, make: (u) => `${u.uid}${PATTERN}` },
      { label: "固定 puer123", make: () => "puer123" },
      { label: "固定 test123456", make: () => "test123456" },
    ];

    const match = [];
    const noMatch = [];
    const noHash = [];

    for (const u of users) {
      if (!u.passwordHash) {
        noHash.push(u);
        continue;
      }
      let hit = null;
      for (const c of CANDIDATES) {
        let ok = false;
        try {
          ok = await bcrypt.compare(c.make(u), u.passwordHash);
        } catch {
          ok = false;
        }
        if (ok) {
          hit = c.label;
          break;
        }
      }
      if (hit) match.push({ ...u, hit });
      else noMatch.push(u);
    }

    log(`密码模式候选：uid + "${PATTERN}"`);
    log(`  账号总数 ${users.length}`);
    log(`  匹配任一候选密码（机器造号） ${match.length}`);
    log(`  不匹配（密码是个性化设的）    ${noMatch.length}`);
    log(`  无密码哈希（auto-register 造）  ${noHash.length}`);
    const byPattern = new Map();
    for (const m of match) byPattern.set(m.hit, (byPattern.get(m.hit) || 0) + 1);
    for (const [k, v] of byPattern) log(`    ${k}: ${v}`);

    log("");
    log("── 匹配候选密码、但当前判为真人（矛盾：机器密码却是真人）──");
    for (const u of match.filter((x) => !x.isSynthetic)) {
      log(`  uid=${u.uid} ${u.username} ${u.email} role=${u.role} 昵称=${u.nickname ?? "-"} 密码模式=${u.hit}`);
    }

    log("");
    log("── 无密码、但当前判为真人（矛盾：无密码登录不了）──");
    for (const u of noHash.filter((x) => !x.isSynthetic)) {
      log(`  uid=${u.uid} ${u.username} ${u.email} role=${u.role}`);
    }

    log("");
    log("── 密码个性化、但当前判为机器（候选：真人改了密码 / 被送出的机器号）──");
    for (const u of noMatch.filter((x) => x.isSynthetic)) {
      log(
        `  uid=${u.uid} ${u.username} ${u.email} 昵称=${u.nickname ?? "-"} ` +
          `ip=${u.registrationIp ?? "-"} 评${u._count.comments} 帖${u._count.articles}`,
      );
    }

    log("");
    log("── 不匹配该模式、但当前判为机器（矛盾：像是真人设了密码）──");
    for (const u of noMatch.filter((x) => x.isSynthetic)) {
      log(
        `  uid=${u.uid} ${u.username} ${u.email} 昵称=${u.nickname ?? "-"} ` +
          `ip=${u.registrationIp ?? "-"}`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e);
  process.exit(1);
});
