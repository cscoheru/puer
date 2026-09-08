import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireAdmin } from "@/lib/admin-auth";
import bcrypt from "bcryptjs";
import { z } from "zod";

const createSchema = z.object({
  username: z.string().min(2, "用户名至少2个字符").max(50),
  password: z.string().min(6, "密码至少6个字符"),
  role: z.enum(["user", "admin"]).default("user"),
});

export async function POST(req: NextRequest) {
  const { error: authError } = await requireAdmin();
  if (authError) return authError;

  const body = await req.json();
  const data = createSchema.parse(body);

  const existing = await prisma.user.findUnique({ where: { username: data.username } });
  if (existing) {
    return NextResponse.json({ error: "用户名已被占用" }, { status: 400 });
  }

  const passwordHash = await bcrypt.hash(data.password, 12);

  const user = await prisma.$transaction(async (tx) => {
    const maxResult = await tx.user.aggregate({ _max: { uid: true } });
    const nextUid = Math.max((maxResult._max.uid ?? 1000) + 1, 1001);
    if (nextUid > 9999) throw new Error("UID range exhausted");

    return tx.user.create({
      data: {
        uid: nextUid,
        username: data.username,
        email: `uid${nextUid}@puer.local`,
        passwordHash,
        role: data.role,
        level: 0,
        exp: 0,
      },
    });
  });

  return NextResponse.json({
    id: user.id,
    uid: user.uid,
    username: user.username,
    role: user.role,
  });
}
