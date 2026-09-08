import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import { generateSlideshowVideo } from "@/lib/slideshow-video";
import { z } from "zod";

// Slideshow generation may take ~30s; default route timeout is 10s.
export const maxDuration = 60;

// Tasting notes are admin-only (per product decision). POST creates a new note.
const tastingSchema = z.object({
  title: z.string().min(1).max(200),
  content: z.string().min(1),
  summary: z.string().max(500).optional(),
  teaId: z.string().min(1),
  appearance: z.number().int().min(0).max(10).optional(),
  color: z.number().int().min(0).max(10).optional(),
  aroma: z.number().int().min(0).max(10).optional(),
  taste: z.number().int().min(0).max(10).optional(),
  aftertaste: z.number().int().min(0).max(10).optional(),
  brewMethod: z.string().max(20).optional(),
  waterTemp: z.number().int().min(0).max(100).optional(),
  teaWeight: z.string().max(20).optional(),
  steepCount: z.number().int().min(0).max(50).optional(),
  images: z.array(z.string()).default([]),
});

export async function POST(req: NextRequest) {
  const { session, error } = await requireAdmin();
  if (error) return error;

  const body = await req.json();
  const data = tastingSchema.parse(body);

  const tea = await prisma.tea.findUnique({ where: { id: data.teaId } });
  if (!tea) {
    return NextResponse.json({ error: "茶品不存在" }, { status: 400 });
  }

  // Create note first so it persists even if video generation fails
  const note = await prisma.tastingNote.create({
    data: {
      title: data.title,
      content: data.content,
      summary: data.summary,
      teaId: data.teaId,
      appearance: data.appearance,
      color: data.color,
      aroma: data.aroma,
      taste: data.taste,
      aftertaste: data.aftertaste,
      brewMethod: data.brewMethod,
      waterTemp: data.waterTemp,
      teaWeight: data.teaWeight,
      steepCount: data.steepCount,
      images: data.images,
      authorId: session.user.id,
      source: "manual",
    },
  });

  // Generate slideshow video if enough images (≥4); failure is non-blocking
  if (data.images.length >= 4) {
    const result = await generateSlideshowVideo(data.images);
    if (result) {
      await prisma.tastingNote.update({
        where: { id: note.id },
        data: { videoUrl: result.videoUrl },
      });
    }
  }

  // Re-fetch to include videoUrl
  const finalNote = await prisma.tastingNote.findUnique({ where: { id: note.id } });
  return NextResponse.json(finalNote, { status: 201 });
}
