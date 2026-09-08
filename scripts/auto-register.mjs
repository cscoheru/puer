#!/usr/bin/env node

/**
 * auto-register.mjs — Slow organic user growth (3-5 new users/day).
 *
 * The 133 existing users all came from one-time seeding. This creates a small
 * batch of realistic tea-enthusiast accounts daily so the community grows
 * gradually. New accounts start at level 0 and only enter the vote/post pools
 * after 7 days (the `createdAt < NOW()-7d` filter), so they don't immediately
 * look like bots.
 *
 * Run daily via crontab (inside app container):
 *   node /app/scripts/auto-register.mjs
 */

import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
const MIN_NEW = 3;
const MAX_NEW = 5;

const SURNAMES = ["张","王","李","陈","刘","杨","赵","黄","周","吴","徐","孙","胡","朱","高","林","何","郭","马","罗","梁","宋","郑","谢","韩","唐","冯","于","董","萧","袁","邓","傅","曾","彭","苏","蒋","卢","丁","姚","程","吕","沈","曹","魏","薛","叶","阎","余","潘"];
const NAME_CHARS = ["茶","韵","香","茗","清","雅","静","明","远","山","水","云","石","松","竹","梅","兰","菊","华","杰","伟","芳","娜","敏","丽","强","磊","洋","艳","勇","军","涛","辉","飞","刚","霞","娟","婷","峰","海","林","森","阳","宁","安","平","立","建","国","玉"];
const SUFFIXES = ["茶客","茶人","藏茶","品茗","老茶","爱茶","寻茶","问茶","习茶","煮茶"];

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function sql(query) {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();
  try {
    return await client.query(query);
  } finally {
    await client.end();
  }
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function escapeSql(str) {
  return String(str).replace(/'/g, "''");
}

function genUsername(taken) {
  for (let i = 0; i < 80; i++) {
    const base = pickRandom(SURNAMES) + pickRandom(NAME_CHARS) + (Math.random() < 0.5 ? pickRandom(NAME_CHARS) : "");
    const name = (Math.random() < 0.4 ? base + pickRandom(SUFFIXES) : base).slice(0, 30);
    if (!taken.has(name)) return name;
  }
  return "茶友" + Math.floor(Math.random() * 99999);
}

async function main() {
  log("=== Auto-register started ===");
  const count = MIN_NEW + Math.floor(Math.random() * (MAX_NEW - MIN_NEW + 1));
  log(`Creating ${count} new users`);

  const { rows } = await sql(`SELECT username, email, uid FROM users`);
  const usernames = new Set(rows.map((r) => r.username));
  const emails = new Set(rows.map((r) => r.email));
  const maxUid = rows.reduce((m, r) => {
    const u = parseInt(r.uid, 10);
    return Number.isFinite(u) && u > m ? u : m;
  }, 1000);

  let created = 0;
  for (let i = 0; i < count; i++) {
    const username = genUsername(usernames);
    const uid = maxUid + 1 + i;
    const email = `uid${uid}@puer.local`;
    if (emails.has(email)) continue;

    const id = randomUUID();
    try {
      await sql(`
        INSERT INTO users (id, uid, username, email, level, "banStatus", "createdAt", "updatedAt")
        VALUES ('${id}', ${uid}, '${escapeSql(username)}', '${email}', 0, 'active', NOW(), NOW())
      `);
      usernames.add(username);
      emails.add(email);
      created++;
      log(`  +${username} (uid ${uid})`);
    } catch (err) {
      log(`  skipped ${username}: ${err.message.split("\n")[0]}`);
    }
  }
  log(`=== Auto-register complete: ${created}/${count} ===`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
