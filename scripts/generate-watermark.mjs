#!/usr/bin/env node
// Generate a FULL-FRAME watermark texture: many leaf-logo + "puer.im" units
// scattered at random positions/rotations across a tileable canvas. Run once
// locally, commit public/watermark-overlay.png. Alpha pre-baked (white 0.32 +
// soft shadow) so sharp/ffmpeg need no opacity tweaks. Covers the whole image
// (anti-theft) instead of a single center stamp.
import sharp from "sharp";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outPath = path.join(__dirname, "..", "public", "watermark-overlay.png");

const SIZE = 1200;      // texture canvas (covers typical images; tiled if larger)
const GRID = 3;          // 3x3 = 9 units
const CELL = SIZE / GRID;

// Leaf paths (white) from favicon, centered at origin then translated.
const leaf = `
          <path d="M16 2 C16 2 8 8 6 16 C4 24 12 30 16 30 C20 30 28 24 26 16 C24 8 16 2 16 2Z" fill="#ffffff"/>
          <path d="M16 28 L16 30" stroke="#ffffff" stroke-width="1.5" stroke-linecap="round"/>
          <path d="M16 4 L16 26" stroke="#ffffff" stroke-width="0.8" opacity="0.6"/>
          <path d="M16 8 L11 14 M16 8 L21 14 M16 14 L10 20 M16 14 L22 20" stroke="#ffffff" stroke-width="0.5" opacity="0.5"/>`;

// 9 units at jittered grid positions + random rotation/scale
const units = [];
for (let r = 0; r < GRID; r++) {
  for (let c = 0; c < GRID; c++) {
    const cx = c * CELL + CELL / 2 + (Math.random() - 0.5) * CELL * 0.5;
    const cy = r * CELL + CELL / 2 + (Math.random() - 0.5) * CELL * 0.5;
    const rot = (Math.random() - 0.5) * 50;        // -25..25 deg
    const sc = 1.8 + Math.random() * 0.6;           // 1.8..2.4 (logo/text ~2x larger)
    units.push(`
      <g transform="translate(${cx.toFixed(1)} ${cy.toFixed(1)}) rotate(${rot.toFixed(1)}) scale(${sc.toFixed(2)})">
        <g transform="translate(-16 -16)">${leaf}</g>
        <text x="0" y="42" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="22" font-weight="bold" fill="#ffffff">puer.im</text>
      </g>`);
  }
}

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}">
  <defs>
    <filter id="sh" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur in="SourceAlpha" stdDeviation="1.2"/>
      <feOffset dx="0" dy="1.5"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g opacity="0.32" filter="url(#sh)">
    ${units.join("")}
  </g>
</svg>`;

await sharp(Buffer.from(svg)).png().toFile(outPath);
console.log(`Watermark texture: ${outPath} (${SIZE}x${SIZE}, ${GRID * GRID} units, random pos/rot)`);
