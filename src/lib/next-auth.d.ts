import { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      uid?: number;
      level: number;
      role: string;
      nickname?: string | null;
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
  }
}
