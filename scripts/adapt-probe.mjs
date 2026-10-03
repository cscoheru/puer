#!/usr/bin/env node
/**
 * adapt-probe.mjs — READ-ONLY diagnostic for the Phase D rewrite.
 *
 * Runs `deepSeekAdapt` N times on one tasting note and logs, per attempt: the
 * wall-clock cost, the verdict, and the RAW model body's `finish_reason` /
 * `completion_tokens` / `message.content` tail.
 *
 * The prompt is NOT duplicated here — it is built by the real `buildPrompt`
 * inside `deepSeekAdapt`, and the raw response is observed by injecting a
 * logging `fetcher`. So this can never drift from what production sends, which
 * is the whole point of having it: when a rewrite starts landing verbatim, run
 * this and read whether the cause is latency (timeout), size (finish=length),
 * or sampling (malformed JSON). Those need different fixes.
 *
 * Costs one model call per round. Writes nothing to the DB.
 *   node --import tsx scripts/adapt-probe.mjs <noteId> [rounds]
 */
import { PrismaClient } from "../src/generated/prisma/client.js";
import { deepSeekAdapt, toAdaptSource } from "../src/lib/tea-drafts/adapt.ts";
import { normalizeTastingNote } from "../src/lib/tea-drafts/normalize.ts";
import { styleFor } from "../src/lib/tea-drafts/styles.ts";
import { codepointLength } from "../src/lib/tea-drafts/source-html.ts";

const noteId = process.argv[2];
const rounds = Number(process.argv[3] ?? 3);
if (!noteId) {
  console.error("usage: node --import tsx scripts/adapt-probe.mjs <noteId> [rounds]");
  process.exit(1);
}

const prisma = new PrismaClient({
  datasources: { db: { url: process.env.DATABASE_URL } },
});
const note = await prisma.tastingNote.findUnique({
  where: { id: noteId },
  select: {
    id: true, title: true, content: true, summary: true, teaId: true, authorId: true,
    source: true, brewMethod: true, waterTemp: true, teaWeight: true, steepCount: true,
    images: true, videoUrl: true, createdAt: true,
  },
});
const tea = note.teaId
  ? await prisma.tea.findUnique({ where: { id: note.teaId }, select: { name: true } })
  : null;
const source = toAdaptSource(normalizeTastingNote({ ...note, teaName: tea?.name ?? null }));
const style = styleFor(noteId).key;
console.log(`note=${noteId} style=${style} plainText=${codepointLength(source.plainText)}cp`);

for (let i = 1; i <= rounds; i++) {
  const seen = {};
  const loggingFetcher = async (url, init) => {
    const resp = await fetch(url, init);
    const txt = await resp.clone().text();
    try {
      const j = JSON.parse(txt);
      const ch = j?.choices?.[0];
      seen.finish = ch?.finish_reason;
      // usage sits at the TOP level of the body, not on the choice (probe-raw
      // confirmed the shape: {choices:[…], usage:{…}, base_resp:{…}}).
      seen.usage = j?.usage ?? ch?.usage;
      seen.msgKeys = Object.keys(ch?.message ?? {});
      const c = ch?.message?.content;
      seen.contentLen = typeof c === "string" ? c.length : 0;
      seen.contentTail = typeof c === "string" ? c.slice(-160) : "";
      seen.bodyLen = txt.length;
    } catch {
      seen.parseError = true;
      seen.bodyHead = txt.slice(0, 200);
    }
    return resp;
  };

  const t0 = Date.now();
  const r = await deepSeekAdapt({ source, style, fetcher: loggingFetcher });
  const ms = Date.now() - t0;
  console.log(
    `round ${i}: elapsed=${ms}ms ok=${r.ok}` +
      (r.ok ? ` style=${r.style}` : ` reason=${JSON.stringify(r.reason)}`),
  );
  console.log(
    `   finish=${seen.finish} completion_tokens=${seen.usage?.completion_tokens}` +
      ` reasoning=${seen.usage?.completion_tokens_details?.reasoning_tokens}` +
      ` contentLen=${seen.contentLen} bodyLen=${seen.bodyLen}` +
      ` msgKeys=${JSON.stringify(seen.msgKeys)}`,
  );
  if (!r.ok && seen.contentTail) {
    console.log(`   content tail: ${JSON.stringify(seen.contentTail)}`);
  }
}
await prisma.$disconnect();
