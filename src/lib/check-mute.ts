import { prisma } from "@/lib/prisma";

export async function checkUserCanPost(userId: string): Promise<{ canPost: boolean; reason?: string }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { banStatus: true, muteStatus: true, mutedUntil: true },
  });

  if (!user) return { canPost: false, reason: "用户不存在" };
  if (user.banStatus === "banned") return { canPost: false, reason: "账号已被封禁" };

  if (user.muteStatus === "muted" && user.mutedUntil) {
    if (new Date() < user.mutedUntil) {
      const daysLeft = Math.ceil((user.mutedUntil.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      return { canPost: false, reason: `账号处于禁言期，剩余 ${daysLeft} 天` };
    }
    // Mute expired, auto-unmute
    await prisma.user.update({
      where: { id: userId },
      data: { muteStatus: "active", mutedUntil: null, muteReason: null },
    });
  }

  return { canPost: true };
}
