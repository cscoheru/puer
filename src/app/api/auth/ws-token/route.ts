import { NextRequest } from "next/server";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return Response.json({ token: null }, { status: 200 });
  }

  // Read JWT from cookies (next-auth v5 stores it)
  const cookies = req.cookies;
  const token = cookies.get("__Secure-next-auth.session-token")?.value
    || cookies.get("next-auth.session-token")?.value;

  if (!token) {
    return Response.json({ token: null }, { status: 200 });
  }

  return Response.json({ token });
}
