import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { prisma } from "@/lib/prisma";
import bcrypt from "bcryptjs";
import { checkRateLimit, rateLimitKey, getClientIP, LIMIT_LOGIN } from "@/lib/rate-limit";

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
}

function getCachedUser(id: string): AuthCacheData | null {
  const entry = authCache.get(id);
  if (entry && entry.expiresAt > Date.now()) return entry.data as AuthCacheData;
  authCache.delete(id);
  return null;
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

        const input = (credentials.email as string).trim();
        // 4-digit number → UID; otherwise try username first, then email
        const isUid = /^\d{4}$/.test(input);

        let user = null;
        if (isUid) {
          user = await prisma.user.findUnique({ where: { uid: parseInt(input, 10) } });
        } else {
          user = await prisma.user.findUnique({ where: { username: input } });
          if (!user) {
            user = await prisma.user.findUnique({ where: { email: input } });
          }
        }

        if (!user || !user.passwordHash) return null;

        const valid = await bcrypt.compare(
          credentials.password as string,
          user.passwordHash
        );
        if (!valid) return null;

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
          token.level = cached.level;
          token.role = cached.role;
          token.picture = cached.avatar;
          token.uid = cached.uid;
          token.nickname = cached.nickname;
        } else {
          const dbUser = await prisma.user.findUnique({
            where: { id: token.id as string },
            select: { level: true, role: true, avatar: true, banStatus: true, uid: true, nickname: true },
          });
          if (dbUser) {
            if (dbUser.banStatus === "banned") return null;
            token.level = dbUser.level;
            token.role = dbUser.role;
            token.picture = dbUser.avatar;
            token.uid = dbUser.uid;
            token.nickname = dbUser.nickname;
            setCachedUser(token.id as string, {
              level: dbUser.level,
              role: dbUser.role,
              avatar: dbUser.avatar,
              banStatus: dbUser.banStatus,
              uid: dbUser.uid,
              nickname: dbUser.nickname,
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
      }
      return session;
    },
  },
});
