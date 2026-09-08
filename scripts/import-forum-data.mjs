/**
 * Import transformed 368tea content into forum boards.
 * Runs on the server with Prisma access.
 *
 * Usage:
 *   node scripts/import-forum-data.mjs [puer|zisha|all]
 *
 * Reads from: scripts/scraped_content/ready_{slug}.json
 */

import { PrismaClient } from "../src/generated/prisma/client.js";
import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const prisma = new PrismaClient();

const AUTHOR_USERNAME = "古道茶人";

async function main() {
  const forum = process.argv[2] || "all";
  const slugs = forum === "all" ? ["puer", "zisha"] : [forum];

  // Resolve author
  const author = await prisma.user.findUnique({ where: { username: AUTHOR_USERNAME } });
  if (!author) {
    console.error(`✗ Author "${AUTHOR_USERNAME}" not found`);
    process.exit(1);
  }
  console.log(`✓ Author: ${author.username} (${author.id.slice(0, 8)}...)`);

  for (const slug of slugs) {
    const filePath = join(__dirname, `scraped_content/ready_${slug}.json`);
    if (!existsSync(filePath)) {
      console.error(`  ✗ ${filePath} not found`);
      continue;
    }

    const data = JSON.parse(readFileSync(filePath, "utf-8"));
    const { boardSlug, boardName, articles } = data;

    // Resolve board
    const board = await prisma.board.findUnique({ where: { slug: boardSlug } });
    if (!board) {
      console.error(`  ✗ Board "${boardSlug}" not found`);
      continue;
    }
    console.log(`\n📂 ${boardName} (/forum/${boardSlug}) — ${articles.length} articles`);

    let imported = 0;
    let errors = 0;

    for (let i = 0; i < articles.length; i++) {
      const art = articles[i];
      const shortTitle = art.title.slice(0, 55);
      process.stdout.write(`  [${i + 1}/${articles.length}] ${shortTitle}... `);

      try {
        // Parse publishedAt date or use a reasonable spread
        const publishedAt = art.publishedAt
          ? new Date(art.publishedAt)
          : new Date(`2025-06-${String(15 + (i % 15)).padStart(2, "0")}`);

        await prisma.article.create({
          data: {
            type: "discussion",
            title: art.title,
            content: art.content,
            summary: art.summary || null,
            boardId: board.id,
            authorId: author.id,
            status: "published",
            tags: art.tags || ["茶文化"],
            viewCount: Math.floor(Math.random() * 3000) + 200,
            replyCount: 0,
            isPinned: false,
            isEssence: false,
            createdAt: publishedAt,
            updatedAt: publishedAt,
          },
        });

        console.log("OK");
        imported++;
      } catch (err) {
        console.log(`FAILED: ${err.message.slice(0, 100)}`);
        errors++;
      }
    }

    // Update board counters
    console.log(`  ↻ Updating board stats...`);
    const stats = await prisma.article.aggregate({
      where: { boardId: board.id, status: "published" },
      _count: { id: true },
    });
    await prisma.board.update({
      where: { id: board.id },
      data: { threadCount: stats._count.id },
    });

    console.log(`  ✓ ${imported} imported, ${errors} errors, ${stats._count.id} total in board`);
  }

  await prisma.$disconnect();
  console.log(`\n✓ Done`);
}

main().catch((err) => {
  console.error(err);
  prisma.$disconnect();
  process.exit(1);
});
