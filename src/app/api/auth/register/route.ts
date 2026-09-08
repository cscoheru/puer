import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_REGISTER } from "@/lib/rate-limit";
import { verifyTurnstile } from "@/lib/verify-turnstile";

// ── Password strength ────────────────────────────────────────────────
// Medium: 8+ chars, at least 1 letter, 1 number
const passwordSchema = z
  .string()
  .min(8, "密码至少8个字符")
  .regex(/[a-zA-Z]/, "密码必须包含至少一个字母")
  .regex(/[0-9]/, "密码必须包含至少一个数字");

const registerSchema = z.object({
  username: z
    .string()
    .min(2, "用户名至少2个字符")
    .max(50, "用户名最多50个字符")
    .regex(/^[a-zA-Z0-9_一-鿿]+$/, "用户名只能包含字母、数字、下划线和中文"),
  nickname: z
    .string()
    .min(1, "昵称不能为空")
    .max(50, "昵称最多50个字符")
    .optional()
    .default(""),
  password: passwordSchema,
  hp: z.string().optional(), // honeypot — should be empty
  turnstileToken: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    // Rate limit: 3 registrations per hour per IP
    const ip = getClientIP(req);
    const { allowed } = checkRateLimit(rateLimitKey(ip, "register"), LIMIT_REGISTER);
    if (!allowed) {
      return NextResponse.json({ error: "注册过于频繁，请稍后再试" }, { status: 429 });
    }
    const data = registerSchema.parse(body);

    // Honeypot check — if hidden field is filled, reject silently
    if (data.hp) {
      return NextResponse.json({ error: "注册失败" }, { status: 400 });
    }

    // Turnstile verification — skip if TURNSTILE_SECRET_KEY not set(向后兼容本地开发)
    if (data.turnstileToken && !(await verifyTurnstile(data.turnstileToken))) {
      return NextResponse.json({ error: "验证码验证失败，请刷新后重试" }, { status: 400 });
    }

    // Check username uniqueness
    const existing = await prisma.user.findUnique({
      where: { username: data.username },
    });
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
          nickname: data.nickname || data.username,
          email: `uid${nextUid}@puer.local`,
          passwordHash,
          registrationIp: ip,
          level: 0,
          exp: 0,
        },
      });
    });

    return NextResponse.json({
      id: user.id,
      uid: user.uid,
      username: user.username,
      nickname: user.nickname,
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: err.issues[0].message }, { status: 400 });
    }
    return NextResponse.json({ error: "注册失败" }, { status: 500 });
  }
}
