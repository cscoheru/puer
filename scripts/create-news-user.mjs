#!/usr/bin/env node

/**
 * create-news-user.mjs — 创建专用资讯账号 `puer-news`（一次性、幂等）。
 *
 * 这个账号是 AI 资讯稿的固定署名作者（scripts/ai-news-draft.mjs 按 username 查它）。
 * 刻意不是 admin（不该有后台权限），也不随机挑真人（不能把资讯算到某个用户头上）。
 *
 * 幂等：先按 username 查，存在就只回显 id，不重建、不改密码。
 *
 * 密码：命令行第二个参数传；不传就生成一个随机密码并打印一次（只此一次，
 * 数据库里只存 bcrypt 哈希）。这个账号主要给程序用，但保留一个能登录的口令，
 * 方便人工以「茶社资讯」身份查看它发布的帖子。
 *
 * Run (容器内，tsx + prisma + bcryptjs 都在镜像里):
 *   docker exec puer-hub-app ./node_modules/.bin/tsx scripts/create-news-user.mjs
 *   docker exec puer-hub-app ./node_modules/.bin/tsx scripts/create-news-user.mjs --password=xxx
 */

import { randomBytes } from "node:crypto";
import { PrismaClient } from "../src/generated/prisma/client.js";
import bcrypt from "bcryptjs";

const USERNAME = "puer-news";
const NICKNAME = "茶社资讯";

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const existing = await prisma.user.findUnique({
    where: { username: USERNAME },
    select: { id: true, username: true, role: true, level: true, uid: true },
  });
  if (existing) {
    log(`账号已存在，幂等跳过: ${JSON.stringify(existing)}`);
    return;
  }

  const pwArg = process.argv.find((a) => a.startsWith("--password="));
  const password = pwArg ? pwArg.slice("--password=".length) : randomBytes(9).toString("base64url");

  // uid 与注册路由同口径：max(uid)+1，范围 1001..9999。
  const uid = await prisma.$transaction(async (tx) => {
    const maxResult = await tx.user.aggregate({ _max: { uid: true } });
    const next = Math.max((maxResult._max.uid ?? 1000) + 1, 1001);
    if (next > 9999) throw new Error("UID range exhausted");

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await tx.user.create({
      data: {
        uid: next,
        username: USERNAME,
        nickname: NICKNAME,
        email: `puer-news@puer.local`,
        emailVerified: new Date(),
        passwordHash,
        level: 4,
        exp: 0,
        karma: 0,
        role: "user",
        banStatus: "active",
        muteStatus: "active",
        creditScore: 100,
      },
      select: { id: true, uid: true, username: true },
    });
    return user;
  });

  log(`已创建资讯账号: ${JSON.stringify(uid)}`);
  log(`登录口令（仅本次显示，请记录）: ${password}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
