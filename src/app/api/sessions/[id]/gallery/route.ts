import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const gallery = await prisma.teaSessionGallery.findMany({
    where: { sessionId: id },
    orderBy: { steepNumber: "asc" },
  });

  return Response.json(gallery);
}
