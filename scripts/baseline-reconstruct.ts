#!/usr/bin/env tsx
/**
 * task#7 retroactive baseline — reconstruct the ORIGINAL verbatim draft for each
 * existing tasting-draft by replaying the pipeline's own pure functions
 * (normalizeTastingNote + assembleDraft) on the source TastingNote, then emit
 * baseline-vs-current pairs for diffing. Read-only: never writes to the DB.
 *
 * Run: node --import tsx scripts/baseline-reconstruct.ts
 */
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeTastingNote } from "../src/lib/tea-drafts/normalize.ts";
import { assembleDraft } from "../src/lib/tea-drafts/assemble.ts";

const rows = JSON.parse(readFileSync("/tmp/baseline-drafts.json", "utf-8"));

const out = rows.map((r: any) => {
  const note = normalizeTastingNote({
    id: r.note_id,
    title: r.note_title,
    content: r.note_content,
    summary: r.note_summary,
    teaId: r.teaId,
    authorId: r.authorId,
    source: r.source,
    brewMethod: r.brewMethod,
    waterTemp: r.waterTemp,
    teaWeight: r.teaWeight,
    steepCount: r.steepCount,
    images: r.images,
    videoUrl: r.videoUrl,
    createdAt: r.note_created,
  });
  const d = assembleDraft({ note, config: { boardId: "baseline" } });
  return {
    draft_id: r.draft_id,
    note_title: r.note_title,
    status: r.draft_status,
    draft_created: r.draft_created,
    draft_updated: r.draft_updated,
    baseline_title: d.title,
    baseline_content: d.content,
    baseline_summary: d.summary,
    current_title: r.draft_title,
    current_content: r.draft_content,
    current_summary: r.draft_summary,
  };
});

writeFileSync("/tmp/baseline-reconstructed.json", JSON.stringify(out, null, 2));
const exact = out.filter((o: any) => o.baseline_content === o.current_content).length;
console.log(`reconstructed ${out.length} drafts; ${exact} byte-identical to current (never edited)`);
