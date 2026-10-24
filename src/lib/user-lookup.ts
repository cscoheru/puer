/**
 * 按账号找人 —— UID（4 位）/ 用户名 / 邮箱。
 *
 * 登录框、登录页的「忘记密码」、后台的重置都走这一套解析。**必须只有一份**：
 * 两边的口径分叉的话，用户能登录却申请不了重置（或者反过来，能申请重置
 * 却登不进去），这类问题极难排查。
 */
import { prisma } from "@/lib/prisma";

/**
 * 按账号找用户。找不到返回 null。
 *
 * 账号的三种写法与登录框完全一致：
 *   - 4 位数字 → UID（站里的 UID 是 1001–9999）
 *   - 其余 → 先当用户名，再当邮箱
 */
export async function findUserByAccount(account: string) {
  const input = account.trim();
  if (/^\d{4}$/.test(input)) {
    return prisma.user.findUnique({ where: { uid: parseInt(input, 10) } });
  }
  const byName = await prisma.user.findUnique({ where: { username: input } });
  if (byName) return byName;
  return prisma.user.findUnique({ where: { email: input } });
}
