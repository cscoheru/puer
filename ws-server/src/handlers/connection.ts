import { Socket, Server } from "socket.io";
import { verifyToken, AuthUser } from "../auth";
import { pool } from "../db";
import { leaveSession } from "./session";

export async function handleConnection(io: Server, socket: Socket) {
  const token = socket.handshake.auth?.token;
  let user: AuthUser | null = null;

  if (token && typeof token === "string") {
    user = await verifyToken(token);
  }

  if (user) {
    socket.data.user = user;
    socket.data.isGuest = false;
    // Join personal room for targeted notifications
    socket.join(`user:${user.id}`);
    // Update online status
    await pool.query(
      "UPDATE users SET \"onlineStatus\" = 'online' WHERE id = $1",
      [user.id]
    ).catch(() => {});
    console.log(`[connect] ${user.username} (Lv.${user.level})`);
  } else {
    socket.data.isGuest = true;
    console.log(`[connect] guest`);
  }

  socket.on("disconnect", async () => {
    if (socket.data.user) {
      console.log(`[disconnect] ${socket.data.user.username}`);
      // Mark offline (with grace period check - only if no other sockets for same user)
      const userId = socket.data.user.id;
      const room = `user:${userId}`;
      const socketsInRoom = io.sockets.adapter.rooms.get(room)?.size ?? 0;
      if (socketsInRoom <= 1) {
        // Graceful: mark offline after 5 min timeout
        setTimeout(async () => {
          const stillConnected = io.sockets.adapter.rooms.get(room)?.size ?? 0;
          if (stillConnected <= 1) {
            await pool.query(
              "UPDATE users SET \"onlineStatus\" = 'offline' WHERE id = $1",
              [userId]
            ).catch(() => {});
          }
        }, 5 * 60 * 1000);
      }
    } else {
      console.log(`[disconnect] guest`);
    }

    // Leave any session the user was in
    if (socket.data.sessionId) {
      await leaveSession(io, socket, { sessionId: socket.data.sessionId });
    }
  });
}
