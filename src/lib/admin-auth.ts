import { auth } from "@/lib/auth";
import { NextResponse } from "next/server";

export async function requireAdmin() {
  const session = await auth();
  if (!session?.user || session.user.role !== "admin") {
    return {
      session: null,
      error: NextResponse.json({ error: "仅管理员可操作" }, { status: 403 }),
    };
  }
  return { session, error: null };
}
