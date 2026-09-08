#!/usr/bin/env node

/**
 * seed-inventory.mjs — Create tea inventory items from tasting notes for a specific user
 *
 * Reads tasting note data, picks best images, creates inventory via DB insert.
 * Validity: 30 days from now.
 */

import { randomUUID } from "node:crypto";

const DB_URL = process.env.DATABASE_URL;
const USER_ID = "01632ebd-5205-4388-9523-1405d3b6d212"; // 云水禅心
const VALIDITY_DAYS = 30;

const SPEC_OPTIONS = ["357g", "200g", "400g", "500g", "100g", "250g", "150g", "7g", "1000g"];
const STORAGE_MAP = { raw: "dry_normal", ripe: "home_natural" };

function pickSpec(title) {
  // Try to detect spec from title
  if (title.includes("沱") || title.includes("Tuo")) return "100g";
  if (title.includes("砖") || title.includes("Brick")) return "250g";
  if (title.includes("小饼") || title.includes("迷你")) return "100g";
  if (title.includes("散") || title.includes("散茶")) return "357g";
  // Default for most puer cakes
  return "357g";
}

function estimateWeight(spec) {
  const map = { "357g": 350, "200g": 195, "400g": 390, "500g": 480, "100g": 98, "250g": 240, "150g": 145, "7g": 7, "1000g": 950 };
  return map[spec] || 340;
}

async function main() {
  const { Client } = await import("pg");
  const client = new Client({ connectionString: DB_URL });
  await client.connect();

  const now = new Date();
  const expiresAt = new Date(now.getTime() + VALIDITY_DAYS * 24 * 60 * 60 * 1000);

  // Fetch tasting notes with 6+ images, detailed content, ordered by score
  const result = await client.query(`
    WITH ranked AS (
      SELECT tn.id, tn.title, tn.images, tn.content,
             tn.appearance, tn.color, tn.aroma, tn.taste, tn.aftertaste,
             tn."brewMethod", tn."waterTemp",
             t.name as tea_name, t.brand, t.year, t.type,
             jsonb_array_length(tn.images::jsonb) as img_count,
             ROW_NUMBER() OVER (
               PARTITION BY t.type
               ORDER BY (COALESCE(tn.appearance,0) + COALESCE(tn.color,0) + COALESCE(tn.aroma,0) + COALESCE(tn.taste,0) + COALESCE(tn.aftertaste,0)) DESC, random()
             ) as rn
      FROM tasting_notes tn
      JOIN teas t ON tn."teaId" = t.id
      WHERE tn.images IS NOT NULL
        AND jsonb_array_length(tn.images::jsonb) >= 6
        AND length(tn.content) > 300
    )
    SELECT * FROM ranked WHERE rn <= 20
    ORDER BY type, rn
  `);

  let count = 0;
  for (const row of result.rows) {
    const images = row.images;
    if (!Array.isArray(images) || images.length < 4) continue;

    // Pick first 4 images (typically front/back of cake, soup color, leaf)
    const selectedImages = images.slice(0, 4);
    const spec = pickSpec(row.title);
    const remainingWeight = estimateWeight(spec) + Math.floor(Math.random() * 20) - 10;
    const storage = STORAGE_MAP[row.type] || "dry_normal";

    // Build description from tasting note content
    const plainContent = row.content.replace(/<[^>]*>/g, "").trim().slice(0, 200);
    const scores = [];
    if (row.appearance) scores.push(`外形${row.appearance}`);
    if (row.color) scores.push(`汤色${row.color}`);
    if (row.aroma) scores.push(`香气${row.aroma}`);
    if (row.taste) scores.push(`滋味${row.taste}`);
    if (row.aftertaste) scores.push(`余韵${row.aftertaste}`);
    const description = `${plainContent}${scores.length > 0 ? `\n评分：${scores.join("/")}` : ""}`;

    const id = randomUUID();
    const brand = row.brand || row.title.replace(/^\d{4}-/, "").split(/[（(]/)[0].trim();

    await client.query(`
      INSERT INTO tea_inventory_items (
        id, "userId", brand, type, year, spec, "remainingWeight",
        storage, description, images, "requestCount",
        "validityDays", "expiresAt", hidden, status, source,
        "createdAt", "updatedAt"
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, false, 'active', 'self', NOW(), NOW())
    `, [id, USER_ID, brand, row.type, row.year, spec, remainingWeight, storage, description, selectedImages, VALIDITY_DAYS, expiresAt]);

    count++;
    const typeLabel = row.type === "raw" ? "生茶" : "熟茶";
    console.log(`[${count}] ${row.year} ${brand} (${typeLabel}) ${spec} ${remainingWeight}g - ${selectedImages.length}张图 - 有效期${VALIDITY_DAYS}天`);
  }

  console.log(`\nDone: ${count} inventory items created for 云水禅心`);
  await client.end();
}

main().catch(console.error);
