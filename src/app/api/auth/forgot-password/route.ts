import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { findUserByAccount } from "@/lib/user-lookup";
import { invalidateAuthCache } from "@/lib/auth";
import {
  answersMatchIdentity,
  forgotPasswordSchema,
  isAdminBackedRequest,
  RESET_STATUS,
  resetStatusSchema,
} from "@/lib/password-reset";
import {
  checkRateLimit,
  getClientIP,
  rateLimitKey,
  LIMIT_FORGOT_PASSWORD,
  LIMIT_RESET_STATUS,
} from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * 「忘记密码」—— 一个接口，两件事。
 *
 * ## 为什么要合并成一个接口
 *
 * 站内**没有邮件通道**，任何「码 / 链接」都得靠用户自己去通知列表里翻
 * （站长实测：刷新登录页根本看不到站内通知）。所以流程改成**申请时就把
 * 新密码定好**：
 *
 *   1. 用户填账号 + 回答核验问题 + **当场定一个新密码**（只存哈希）
 *   2. 管理员在后台核对答案，通过 → 这个新密码**立即生效**
 *   3. 用户拿自己刚设的密码登录 —— 不用等谁把密码送到手上
 *
 * 兜底：用户忘了自己当时设的密码 → 再走一次这个接口，**重答两个身份
 * 问题**（注册时间、最后登录时间）与申请时一致 → 就可以改设新密码。
 *
 * ## 为什么不告诉调用方「这个账号不存在」
 *
 * 找回密码是最经典的**账号枚举**入口：接口明说「该账号不存在」，攻击者
 * 就能拿一堆邮箱去试哪些注册过。所以**成功与失败返回完全一样的话**，
 * 哪怕账号不存在也照发。
 *
 * 唯一会「多说一句」的情况是**已经批准过**的申请 —— 那说明这个人本来
 * 就知道账号是谁。
 *
 * 限速：申请一小时 3 次/IP（防刷申请、刷站内通知）；查状态一小时 10 次。
 */

/** 申请单的状态摘要（给前端看的）。 */
type State = "none" | "pending" | "approved" | "rejected";

/** 取这个用户最近的一条申请，以及各状态下的最新一条。 */
async function loadRequests(userId: string) {
  const rows = await prisma.passwordResetRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 10,
    select: {
      id: true,
      status: true,
      answers: true,
      passwordHash: true,
      createdAt: true,
    },
  });
  return {
    approved: rows.find((r) => r.status === RESET_STATUS.approved) ?? null,
    pending: rows.find((r) => r.status === RESET_STATUS.pending) ?? null,
    latest: rows[0] ?? null,
  };
}

/**
 * GET /api/auth/forgot-password?account=xxx —— 查这个账号的重置申请状态。
 *
 * 账号不存在、或者这个账号从没申请过 → 一律回 `state: "none"`。
 * 只有「有申请」的账号会露出别的状态 —— 泄露面限于「谁申请过重置」。
 */
export async function GET(req: NextRequest) {
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(
    rateLimitKey(ip, "reset-status"),
    LIMIT_RESET_STATUS,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "查询过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  const account = req.nextUrl.searchParams.get("account") ?? "";
  const parsed = resetStatusSchema.safeParse({ account });
  if (!parsed.success) {
    return NextResponse.json({ state: "none" as State });
  }

  const user = await findUserByAccount(parsed.data.account);
  if (!user) {
    return NextResponse.json({ state: "none" as State });
  }

  const { approved, pending, latest } = await loadRequests(user.id);
  let state: State = "none";
  if (approved) state = "approved";
  else if (pending) state = "pending";
  else if (latest?.status === RESET_STATUS.rejected) state = "rejected";

  return NextResponse.json({ state });
}

/**
 * POST /api/auth/forgot-password —— 提交申请，或（已批准时）直接设新密码。
 */
export async function POST(req: NextRequest) {
  const ip = getClientIP(req);
  const { allowed } = checkRateLimit(
    rateLimitKey(ip, "forgot-password"),
    LIMIT_FORGOT_PASSWORD,
  );
  if (!allowed) {
    return NextResponse.json(
      { error: "请求过于频繁，请稍后再试" },
      { status: 429, headers: { "Retry-After": "3600" } },
    );
  }

  const body = await req.json().catch(() => ({}));
  const parsed = forgotPasswordSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? "参数不对" },
      { status: 400 },
    );
  }

  const { account, password } = parsed.data;
  const registration = parsed.data.registration?.trim() ?? "";
  const lastLogin = parsed.data.lastLogin?.trim() ?? "";
  const answers = {
    registration,
    lastLogin,
    region: parsed.data.region?.trim() || null,
    articles: parsed.data.articles?.trim() || null,
    comments: parsed.data.comments?.trim() || null,
    upvotes: parsed.data.upvotes?.trim() || null,
    email: parsed.data.email?.trim() || null,
  };

  const user = await findUserByAccount(account);
  if (!user) {
    // 统一话术：账号存在与否，返回一模一样。
    return NextResponse.json({
      ok: true,
      state: "none" as State,
      message:
        "已收到你的密码重置申请，站长会尽快处理。如果不是本人操作，请忽略这条。",
    });
  }

  const { approved, pending } = await loadRequests(user.id);

  // ── 已批准：把新密码设上去 ───────────────────────────────────────────
  let answersMismatch = false;
  if (approved) {
    const storedAnswers = (approved.answers ?? {}) as Record<string, string | null>;
    // 管理员作保的申请没有答案可比 —— 身份由管理员担保，账号即凭证。
    // 用户自己提交的申请必须**重答两个身份问题**且与申请时一致。
    const adminBacked = isAdminBackedRequest(storedAnswers);
    const identityOk =
      adminBacked ||
      answersMatchIdentity(storedAnswers, { registration, lastLogin });

    if (identityOk) {
      const passwordHash = await bcrypt.hash(password, 12);
      const now = new Date();
      await prisma.$transaction([
        prisma.user.update({
          where: { id: user.id },
          data: { passwordHash, passwordChangedAt: now },
        }),
        prisma.passwordResetRequest.update({
          where: { id: approved.id },
          data: { status: RESET_STATUS.used, handledAt: now },
        }),
        prisma.notification.create({
          data: {
            userId: user.id,
            type: "system",
            content: "你的密码已重置。如果不是本人操作，请立即联系站长。",
            link: null,
          },
        }),
      ]);
      // 立刻作废旧会话（否则 30 秒的 auth 缓存窗口内，旧 token 仍然有效）
      invalidateAuthCache(user.id);

      return NextResponse.json({
        ok: true,
        state: "used" as State,
        reset: true,
        message: "密码已重置，现在可以用新密码登录了。",
      });
    }

    // 答案和申请时填的不一致 —— 不放行，但也不把路堵死：
    // 落到下面的「重新申请」，让站长按这次的答案再核一遍。
    answersMismatch = true;
  }

  // ── 还没批准（或答案对不上）：把申请交上去 ───────────────────────────
  // 提交申请必须回答两个身份问题 —— 它们是站长核对时唯一的依据。
  if (!registration || !lastLogin) {
    return NextResponse.json(
      { error: "请填写注册时间和最后登录时间" },
      { status: 400 },
    );
  }

  const passwordHash = await bcrypt.hash(password, 12);

  // 同一用户同时只留一条待处理申请 —— 重复申请没有意义，还会刷通知。
  // 再次提交就**更新那一条**（答案和新密码都换成最新的），而不是新增。
  if (pending) {
    await prisma.passwordResetRequest.update({
      where: { id: pending.id },
      data: {
        answers,
        passwordHash,
        requestIp: ip,
        note: parsed.data.note?.trim() || null,
      },
    });
  } else {
    await prisma.$transaction([
      prisma.passwordResetRequest.create({
        data: {
          userId: user.id,
          note: parsed.data.note?.trim() || null,
          answers,
          passwordHash,
          requestIp: ip,
        },
      }),
      prisma.notification.create({
        data: {
          userId: user.id,
          type: "system",
          content:
            "我们收到了你的密码重置申请。站长核对后会启用你申请时设置的新密码，" +
            "届时直接用新密码登录即可。如果不是本人操作，请忽略这条。",
          link: null,
        },
      }),
    ]);
  }

  return NextResponse.json({
    ok: true,
    state: "pending" as State,
    message: answersMismatch
      ? "这次填的答案和上次申请时不一致，已按这次的填写重新提交，站长会再核一遍。" +
        "如果你还记得上次申请时设的新密码，直接用它登录即可。"
      : "申请已提交，站长核对通过后，你申请时设置的新密码就会生效，届时直接用它登录即可。",
  });
}
