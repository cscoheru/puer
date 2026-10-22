import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      uid?: number;
      level: number;
      role: string;
      nickname?: string | null;
      /** 系统控制的账号（自动发布号等）。权限层用它挡住后台权限。 */
      isSynthetic?: boolean;
    } & DefaultSession["user"];
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id: string;
    uid?: number;
    level: number;
    role: string;
    nickname?: string | null;
    /** 系统控制的账号（自动发布号等）。权限层用它挡住后台权限。 */
    isSynthetic?: boolean;
  }
}
