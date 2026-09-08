/**
 * Import collected content into puer-hub forum.
 * Runs on the server (or locally with DATABASE_URL) with Prisma access.
 *
 * Usage:
 *   node scripts/import-to-puerhub.mjs tieba
 *   node scripts/import-to-puerhub.mjs tieba_essence_20260602
 *   node scripts/import-to-puerhub.mjs --dry-run tieba
 *   node scripts/import-to-puerhub.mjs --create-board tieba
 *
 * Reads from: scripts/scraped_content/ready_{source}.json
 *             scripts/scraped_content/ready_{full_name}.json
 */

import { PrismaClient } from "@prisma/client";
import { readFileSync, existsSync, readdirSync, cpSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const SYSTEM_USERNAME = "内容搬运工";
const SYSTEM_EMAIL = "collector@system.local";

// Board definitions per source
const BOARD_DEFINITIONS = {
  tieba: {
    name: "贴吧精华",
    slug: "tieba-essence",
    description: "精选百度贴吧优质茶帖，一比一原汁原味",
    icon: "📋",
  },
  web_search: {
    name: "茶界资讯",
    slug: "tea-news",
    description: "全网茶文化资讯、知识、品鉴",
    icon: "🔍",
  },
  auction: {
    name: "拍卖实录",
    slug: "auction-records",
    description: "老茶拍卖信息、估价、成交记录",
    icon: "🏛️",
  },
  tea_site: {
    name: "茶文化长廊",
    slug: "tea-culture",
    description: "茶文化网站精选内容",
    icon: "🍵",
  },
};

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const createBoardOnly = args.includes("--create-board");
  const source = args.filter((a) => !a.startsWith("--"))[0] || "tieba";

  console.log("╔══════════════════════════════════════════════╗");
  console.log("║  puer-hub Content Importer                   ║");
  console.log("╚══════════════════════════════════════════════╝");
  if (dryRun) console.log("  🔍 DRY RUN — no data will be written\n");

  // Resolve ready file
  const readyFile = resolveReadyFile(source);
  if (!readyFile) {
    console.error(`✗ No ready file found for source: ${source}`);
    console.error(`  Looked in: ${join(__dirname, "scraped_content")}`);
    process.exit(1);
  }

  console.log(`📂 Reading: ${readyFile}`);
  const data = JSON.parse(readFileSync(readyFile, "utf-8"));
  const { boardSlug, boardName, articles } = data;
  console.log(`   Board: ${boardName} (${boardSlug})`);
  console.log(`   Articles: ${articles.length}\n`);

  // Step 1: Ensure board exists
  let board = await prisma.board.findUnique({ where: { slug: boardSlug } });
  if (!board) {
    // Find definition matching slug or source
    const def = Object.values(BOARD_DEFINITIONS).find((b) => b.slug === boardSlug)
      || BOARD_DEFINITIONS[source]
      || { name: boardName, slug: boardSlug, description: "导入内容", icon: "📌" };

    // Determine sortOrder (after existing boards)
    const maxSort = await prisma.board.aggregate({ _max: { sortOrder: true } });
    const sortOrder = (maxSort._max.sortOrder || 0) + 1;

    if (dryRun) {
      console.log(`  📋 Would create board: ${def.name} (${def.slug}), sortOrder: ${sortOrder}`);
    } else {
      board = await prisma.board.create({
        data: {
          name: def.name,
          slug: def.slug,
          description: def.description,
          icon: def.icon,
          sortOrder,
          threadCount: 0,
          postCount: 0,
        },
      });
      console.log(`  ✅ Created board: ${def.name} (${def.slug})`);
    }
  } else {
    console.log(`  ✓ Board exists: ${board.name} (${board.slug})`);
  }

  if (createBoardOnly) {
    console.log("\n  --create-board specified, exiting.");
    await prisma.$disconnect();
    return;
  }

  if (!board && !dryRun) {
    console.error("✗ Board not found and could not be created");
    process.exit(1);
  }

  // Step 2: Ensure system user exists
  let author = await prisma.user.findUnique({ where: { username: SYSTEM_USERNAME } });
  if (!author) {
    if (dryRun) {
      console.log(`  👤 Would create system user: ${SYSTEM_USERNAME}`);
    } else {
      // Generate a random password hash (user won't login with password)
      const crypto = await import("crypto");
      const randomPassword = crypto.randomBytes(32).toString("hex");

      author = await prisma.user.create({
        data: {
          username: SYSTEM_USERNAME,
          email: SYSTEM_EMAIL,
          passwordHash: randomPassword,
          role: "admin",
          bio: "系统账号，用于导入各平台精选茶文化内容",
          level: 3,
          exp: 800,
          karma: 50,
        },
      });
      console.log(`  ✅ Created system user: ${SYSTEM_USERNAME}`);
    }
  } else {
    console.log(`  ✓ User exists: ${author.username}`);
  }

  if (dryRun) {
    console.log(`\n  📊 Would import ${articles.length} articles (dry run):`);
    articles.forEach((a, i) => {
      console.log(`    [${i + 1}] ${a.title.slice(0, 60)} (${a.comments?.length || 0} comments)`);
    });
    await prisma.$disconnect();
    return;
  }

  // Step 3: Copy images
  const sourceImagesDir = join(__dirname, "collected_images");
  const targetImagesDir = join(__dirname, "..", "public", "uploads", "collected");
  if (existsSync(sourceImagesDir)) {
    mkdirSync(targetImagesDir, { recursive: true });
    try {
      cpSync(sourceImagesDir, targetImagesDir, { recursive: true, force: false });
      console.log(`  📁 Images copied to ${targetImagesDir}`);
    } catch (err) {
      console.log(`  ⚠️  Image copy warning: ${err.message}`);
    }
  }

  // Step 4: Import articles
  console.log(`\n📝 Importing ${articles.length} articles...\n`);
  let imported = 0;
  let skipped = 0;
  let errors = 0;

  for (let i = 0; i < articles.length; i++) {
    const art = articles[i];
    const shortTitle = art.title.slice(0, 55);
    process.stdout.write(`  [${i + 1}/${articles.length}] ${shortTitle}... `);

    try {
      // Check for duplicate by title + source
      const existing = await prisma.article.findFirst({
        where: {
          boardId: board.id,
          title: art.title,
        },
      });
      if (existing) {
        console.log("SKIP (duplicate)");
        skipped++;
        continue;
      }

      // Parse date
      const publishedAt = art.publishedAt
        ? new Date(art.publishedAt)
        : new Date(Date.now() - (articles.length - i) * 86400000);

      // Compute view count from source data or generate reasonable value
      const viewCount = art.viewCount
        ? Math.max(Math.floor(art.viewCount * 0.1), 50)  // Scale down, min 50
        : Math.floor(Math.random() * 2000) + 100;

      // Create article
      const article = await prisma.article.create({
        data: {
          type: "discussion",
          title: art.title,
          content: art.content,
          summary: art.summary || null,
          boardId: board.id,
          authorId: author.id,
          status: "published",
          tags: art.tags || ["茶文化"],
          images: art.images || [],
          viewCount,
          replyCount: art.comments?.length || 0,
          upvotes: Math.floor(Math.random() * 15) + 3,
          isPinned: false,
          isEssence: art.isEssence !== false,
          flair: "tieba",
          createdAt: publishedAt,
          updatedAt: publishedAt,
          lastRepliedAt: publishedAt,
        },
      });

      // Import comments
      if (art.comments && art.comments.length > 0) {
        for (const comment of art.comments) {
          await prisma.comment.create({
            data: {
              content: comment.content,
              articleId: article.id,
              authorId: author.id,
              parentId: comment.parentId || null,
              createdAt: comment.createdAt ? new Date(comment.createdAt) : publishedAt,
              updatedAt: comment.createdAt ? new Date(comment.createdAt) : publishedAt,
            },
          });
        }
      }

      console.log(`OK (+${art.comments?.length || 0} comments)`);
      imported++;
    } catch (err) {
      console.log(`FAILED: ${err.message.slice(0, 120)}`);
      errors++;
    }
  }

  // Step 5: Update board stats
  const stats = await prisma.article.aggregate({
    where: { boardId: board.id, status: "published" },
    _count: { id: true },
  });

  const commentStats = await prisma.comment.aggregate({
    where: { article: { boardId: board.id } },
    _count: { id: true },
  });

  await prisma.board.update({
    where: { id: board.id },
    data: {
      threadCount: stats._count.id,
      postCount: commentStats._count.id,
      lastPostedAt: new Date(),
    },
  });

  console.log(`\n📊 Results:`);
  console.log(`   ✅ Imported: ${imported}`);
  console.log(`   ⏭️  Skipped: ${skipped} (duplicates)`);
  console.log(`   ❌ Errors: ${errors}`);
  console.log(`   📂 Board total: ${stats._count.id} threads, ${commentStats._count.id} comments`);

  await prisma.$disconnect();
  console.log(`\n✓ Done`);
}

function resolveReadyFile(source) {
  const dir = join(__dirname, "scraped_content");

  // Try exact match first: ready_{source}.json
  const exact = join(dir, `ready_${source}.json`);
  if (existsSync(exact)) return exact;

  // Try finding latest timestamped file: ready_{source}_*.json
  if (existsSync(dir)) {
    const files = readdirSync(dir)
      .filter((f) => f.startsWith(`ready_${source}`) && f.endsWith(".json"))
      .sort()
      .reverse();
    if (files.length > 0) return join(dir, files[0]);
  }

  return null;
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
