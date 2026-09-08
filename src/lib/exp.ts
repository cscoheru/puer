import { prisma } from "@/lib/prisma";
import { getLevelConfigs } from "@/lib/level-config";

// 经验值配置
export const EXP_REWARDS = {
  login: 2,
  post_tasting: 10,
  post_article: 30,
  comment: 3,
  receive_like: 2,
  exchange_success: 15,
  trade_success: 10,
  tea_session_host: 15,
  tea_session_long: 10, // >30min 额外
  tea_session_message: 2,
  tea_session_gift_received: 5,
  tea_session_generate_tasting: 10,
} as const;

// 经验值日上限
const EXP_DAILY_LIMITS: Record<string, number> = {
  login: 2,
  receive_like: 20,
  tea_session_message: 10,
  tea_session_gift_received: 30,
};

export async function grantExp(
  userId: string,
  actionType: keyof typeof EXP_REWARDS,
  referenceId?: string
) {
  const baseExp = EXP_REWARDS[actionType] ?? 0;
  const dailyKey = actionType;
  const dailyLimit = EXP_DAILY_LIMITS[dailyKey];

  if (dailyLimit) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTotal = await prisma.userAction.aggregate({
      where: {
        userId,
        actionType,
        createdAt: { gte: todayStart },
      },
      _sum: { expGained: true },
    });

    const used = todayTotal._sum.expGained ?? 0;
    if (used >= dailyLimit) return null;
  }

  const action = await prisma.userAction.create({
    data: {
      userId,
      actionType,
      expGained: baseExp,
      referenceId,
    },
  });

  await prisma.user.update({
    where: { id: userId },
    data: { exp: { increment: baseExp } },
  });

  // 异步检查升级
  checkLevelUp(userId).catch(() => {});

  return action;
}

export async function checkLevelUp(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      level: true,
      exp: true,
      createdAt: true,
      articles: {
        where: { type: { in: ["tasting", "article"] }, status: "published" },
        select: { id: true },
      },
    },
  });

  if (!user) return;

  const daysSinceSignup = Math.floor(
    (Date.now() - user.createdAt.getTime()) / (1000 * 60 * 60 * 24)
  );

  const postCount = user.articles.length;

  const commentsLiked = await prisma.comment.count({
    where: {
      authorId: userId,
      likesCount: { gt: 0 },
    },
  });

  const configs = await getLevelConfigs();
  const nextReq = configs.find((c) => c.level === user.level + 1);
  if (!nextReq) return;

  if (
    user.exp >= nextReq.expRequired &&
    daysSinceSignup >= nextReq.daysRequired &&
    postCount >= nextReq.postsRequired &&
    commentsLiked >= nextReq.commentsLikedRequired
  ) {
    await prisma.user.update({
      where: { id: userId },
      data: { level: user.level + 1 },
    });
  }
}
