import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { checkRateLimit, rateLimitKey, LIMIT_LOGIN } from "@/lib/rate-limit";
import { findUserByAccount } from "@/lib/user-lookup";
import { sessionInvalidated } from "@/lib/password-reset";

// Simple in-memory cache for auth user data (30s TTL)
const authCache = new Map<string, { data: AuthCacheData; expiresAt: number }>();
const AUTH_CACHE_TTL = 30_000; // 30 seconds

interface AuthCacheData {
  level: number;
  role: string;
  avatar: string | null;
  banStatus: string;
  uid: number | null;
  nickname: string | null;
  /** 系统控制的账号（自动发布号等）。权限层用它挡住后台权限。 */
  isSynthetic: boolean;
  /** 密码最后修改时刻 —— 用来作废改密前的旧会话。 */
  passwordChangedAt: Date | null;
}

function getCachedUser(id: string): AuthCacheData | null {
  const entry = authCache.get(id);
  if (entry && entry.expiresAt > Date.now()) return entry.data as AuthCacheData;
  authCache.delete(id);
  return null;
}

/**
 * 让某个用户的缓存立刻失效。
 *
 * 改密码后必须调它：auth 缓存有 30 秒 TTL，不清掉的话，**旧会话在改密后
 * 还能继续用**（封禁检查也有同样的 30 秒延迟，那是既定取舍；密码不一样 ——
 * 密码泄露后被改密，30 秒够人把数据搬走）。
 */
export function invalidateAuthCache(userId: string): void {
  authCache.delete(userId);
}

function setCachedUser(id: string, data: AuthCacheData): void {
  authCache.set(id, { data, expiresAt: Date.now() + AUTH_CACHE_TTL });
  // Evict stale entries when cache grows beyond 500
  if (authCache.size > 500) {
    const now = Date.now();
    for (const [key, val] of authCache) {
      if (val.expiresAt <= now) authCache.delete(key);
    }
  }
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Credentials({
      name: "credentials",
      credentials: {
        email: { label: "邮箱", type: "email" },
        password: { label: "密码", type: "password" },
      },
      async authorize(credentials, request) {
        if (!credentials?.email || !credentials?.password) return null;

        // Rate limit: 5 login attempts per 15 min per IP
        const ip = request?.headers?.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
        const { allowed } = checkRateLimit(rateLimitKey(ip, "login"), LIMIT_LOGIN);
        if (!allowed) return null;

        // 账号解析（UID / 用户名 / 邮箱）只有一份 —— 登录与「忘记密码」
        // 共用 user-lookup.ts，口径分叉会出现「能登录却申请不了重置」。
        const user = await findUserByAccount(credentials.email as string);

        if (!user || !user.passwordHash) return null;

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash
        );
        if (!valid) return null;

        // 记一次成功登录 —— 密码找回的核验题之一（「你上次登录是什么时候」
        // 是只有本人知道、而站点也有记录的事实）。写失败不该挡住登录。
        await prisma.user
          .update({ where: { id: user.id }, data: { lastLoginAt: new Date() } })
          .catch(() => {});

        return {
          id: user.id,
          email: user.email,
          name: user.username,
          image: user.avatar,
        };
      },
    }),
  ],
  pages: {
    signIn: "/login",
    newUser: "/register",
  },
  session: { strategy: "jwt" },
  callbacks: {
    async jwt({ token, user }) {
      // Set id on first sign-in
      if (user) {
        token.id = user.id;
        token.picture = user.image;
      }
      // Refresh level/role from DB with 30s cache so ban changes take effect quickly
      if (token.id) {
        const cached = getCachedUser(token.id as string);
        if (cached) {
          if (cached.banStatus === "banned") return null;
          // 改密后旧会话失效（JWT 是无状态的，只能靠签发时刻来判）
          if (sessionInvalidated(cached.passwordChangedAt, token.iat)) return null;
          token.level = cached.level;
          token.role = cached.role;
          token.picture = cached.avatar;
          token.uid = cached.uid;
          token.nickname = cached.nickname;
          token.isSynthetic = cached.isSynthetic;
        } else {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { level: true, role: true, avatar: true, banStatus: true, uid: true, nickname: true, isSynthetic: true, passwordChangedAt: true },
          });
          if (dbUser) {
            if (dbUser.banStatus === "banned") return null;
            if (sessionInvalidated(dbUser.passwordChangedAt, token.iat)) return null;
            token.level = dbUser.level;
            token.role = dbUser.role;
            token.picture = dbUser.avatar;
            token.uid = dbUser.uid;
            token.nickname = dbUser.nickname;
            token.isSynthetic = dbUser.isSynthetic;
            setCachedUser(token.id as string, {
              level: dbUser.level,
              role: dbUser.role,
              avatar: dbUser.avatar,
              banStatus: dbUser.banStatus,
              uid: dbUser.uid,
              nickname: dbUser.nickname,
              isSynthetic: dbUser.isSynthetic,
              passwordChangedAt: dbUser.passwordChangedAt,
            });
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.id = token.id as string;
        session.user.uid = token.uid as number | undefined;
        session.user.level = token.level as number;
        session.user.role = token.role as string;
        session.user.image = token.picture as string | null;
        session.user.nickname = token.nickname as string | null;
        session.user.isSynthetic = (token.isSynthetic as boolean | undefined) ?? false;
      }
      return session;
    },
  },
});
