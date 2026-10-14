import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { z } from "zod";
import { planVideoSync, validateDraftImages } from "@/lib/tea-drafts/draft-media";
import { generateSlideshowVideo } from "@/lib/slideshow-video";

// Slideshow regeneration may take ~30s; default route timeout is 10s.
export const maxDuration = 60;

// Partial update: every field is optional. Images are validated through the
// same gate the drafts PUT uses, and a changed image set drives the same
// keep/regenerate/clear video policy (reordering counts as a change because
// the slideshow plays images in order). A manual clearVideo wins over the
// automatic plan on that single save.
const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  content: z.string().min(1).optional(),
  images: z.array(z.string()).optional(),
  clearVideo: z.boolean().optional(),
});

function asImageArray(raw: unknown): string[] {
  return Array.isArray(raw)
    ? (raw as unknown[]).filter((i): i is string => typeof i === "string")
    : [];
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { error } = await requireAdmin();
  if (error) return error;

  const { id } = await ctx.params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是有效 JSON" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "参数不合法" }, { status: 400 });
  }
  const { title, content, images, clearVideo } = parsed.data;

  const existing = await prisma.tastingNote.findUnique({
    where: { id },
    select: { images: true, videoUrl: true },
  });
  if (!existing) return NextResponse.json({ error: "茶记不存在" }, { status: 404 });

  // Image allowlist validation (max 100, /uploads or https only, no traversal).
  let nextImages: string[] | null = null;
  if (images !== undefined) {
    const v = validateDraftImages(images);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    nextImages = v.images;
  }

  const currentImages = asImageArray(existing.images);
  let videoPlan: "keep" | "regenerate" | "clear" = "keep";
  if (clearVideo === true) {
    videoPlan = "clear";
  } else if (nextImages !== null) {
    videoPlan = planVideoSync(currentImages, nextImages);
  }

  const data: Record<string, unknown> = {};
  if (title !== undefined) data.title = title;
  if (content !== undefined) data.content = content;
  if (nextImages !== null) data.images = nextImages;
  if (videoPlan === "clear") data.videoUrl = null;

  await prisma.tastingNote.update({ where: { id }, data });

  // Regeneration runs after the text/image write; generateSlideshowVideo
  // never throws and returns null on failure — the note keeps its previous
  // (now-cleared-or-old) video and we tell the caller.
  let videoRegenFailed = false;
  if (videoPlan === "regenerate" && nextImages && nextImages.length >= 4) {
    const v = await generateSlideshowVideo(nextImages);
    if (v) {
      await prisma.tastingNote.update({ where: { id }, data: { videoUrl: v.videoUrl } });
    } else {
      videoRegenFailed = true;
    }
  }

  const fresh = await prisma.tastingNote.findUnique({ where: { id } });
  return NextResponse.json({
    ...fresh,
    ...(videoRegenFailed ? { videoRegenFailed: true } : {}),
  });
}
