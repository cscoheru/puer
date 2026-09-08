import { prisma } from "@/lib/prisma";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  const sessionUser = await auth();
  if (!sessionUser?.user) {
    return Response.json({ error: "未登录" }, { status: 401 });
  }

  const user = await prisma.user.findUnique({
    where: { id: sessionUser.user.id },
    select: { creditScore: true, noShowCount: true },
  });

  return Response.json({
    creditScore: user?.creditScore ?? 100,
    noShowCount: user?.noShowCount ?? 0,
  });
}
