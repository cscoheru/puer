import { jwtVerify } from "jose";
import { config } from "./config";
import { pool } from "./db";

const secret = new TextEncoder().encode(config.AUTH_SECRET);

export interface AuthUser {
  id: string;
  username: string;
  level: number;
  avatar: string | null;
}

export async function verifyToken(token: string): Promise<AuthUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret);
    const userId = payload.sub;
    if (!userId || typeof userId !== "string") return null;

    const result = await pool.query(
      "SELECT id, username, level, avatar FROM users WHERE id = $1",
      [userId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0] as AuthUser;
  } catch {
    return null;
  }
}
