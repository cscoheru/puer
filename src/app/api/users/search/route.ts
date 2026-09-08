import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ error: "请先登录" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim();
  if (!q || q.length < 1) {
    return Response.json({ users: [] });
  }

  const users = await prisma.user.findMany({
    where: {
      username: { contains: q, mode: "insensitive" },
      id: { not: session.user.id },
    },
    select: {
      id: true,
      username: true,
      avatar: true,
      level: true,
      onlineStatus: true,
    },
    take: 20,
  });

  return Response.json({ users });
}
