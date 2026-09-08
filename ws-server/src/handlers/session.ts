import { Socket, Server } from "socket.io";
import { pool } from "../db";

// In-memory participant tracking per room
const roomParticipants = new Map<string, Set<string>>();

export function getRoomOnlineCount(roomId: string): number {
  return roomParticipants.get(roomId)?.size ?? 0;
}

export async function joinSession(io: Server, socket: Socket, data: { sessionId: string }) {
  const { sessionId } = data || {};
  if (!sessionId || typeof sessionId !== "string") {
    socket.emit("error", { message: "sessionId required" });
    return;
  }

  try {
    const result = await pool.query(
      `SELECT id, status, title, host_id, duration, "scheduledAt" FROM tea_sessions WHERE id = $1`,
      [sessionId]
    );
    if (result.rows.length === 0) {
      socket.emit("error", { message: "Session not found" });
      return;
    }

    const session = result.rows[0];
    const isHost = socket.data.user?.id === session.host_id;
    const room = `session:${sessionId}`;

    // Track participant in DB
    if (socket.data.user) {
      await pool.query(
        `INSERT INTO session_participants ("sessionId", "userId", "enteredAt")
         VALUES ($1, $2, NOW())
         ON CONFLICT ("sessionId", "userId")
         DO UPDATE SET "leftAt" = NULL`,
        [sessionId, socket.data.user.id]
      );
    }

    // Track in-memory online count
    if (!roomParticipants.has(room)) {
      roomParticipants.set(room, new Set());
    }
    const participants = roomParticipants.get(room)!;
    participants.add(socket.id);

    await socket.join(room);
    socket.data.sessionId = sessionId;
    socket.data.isHost = isHost;

    if (socket.data.user) {
      socket.to(room).emit("user_joined", {
        user: socket.data.user,
      });
    }

    // Update peak participants
    const onlineCount = participants.size;
    try {
      await pool.query(
        `UPDATE tea_sessions
         SET "peakParticipants" = GREATEST("peakParticipants", $1)
         WHERE id = $2 AND status = 'live'`,
        [onlineCount, sessionId]
      );
    } catch {}

    // Broadcast count
    io.to(room).emit("participant_count", {
      online: onlineCount,
      total: participants.size,
    });

    socket.emit("session_joined", {
      ok: true,
      session: {
        id: session.id,
        title: session.title,
        status: session.status,
        hostId: session.host_id,
        duration: session.duration,
        scheduledAt: session.scheduledAt,
      },
      isHost,
    });
  } catch (err) {
    console.error("[join_session]", err);
    socket.emit("error", { message: "Internal error" });
  }
}

export async function leaveSession(io: Server, socket: Socket, data: { sessionId: string }) {
  const sessionId = data?.sessionId || socket.data.sessionId;
  if (!sessionId) return;

  const room = `session:${sessionId}`;
  await socket.leave(room);

  // Update DB participant record
  if (socket.data.user) {
    await pool.query(
      `UPDATE session_participants SET "leftAt" = NOW()
       WHERE "sessionId" = $1 AND "userId" = $2 AND "leftAt" IS NULL`,
      [sessionId, socket.data.user.id]
    );

    socket.to(room).emit("user_left", {
      user: socket.data.user,
    });
  }

  // Update in-memory count
  const participants = roomParticipants.get(room);
  if (participants) {
    participants.delete(socket.id);
    const onlineCount = participants.size;
    io.to(room).emit("participant_count", {
      online: onlineCount,
      total: onlineCount,
    });
    if (onlineCount === 0) {
      roomParticipants.delete(room);
    }
  }

  socket.data.sessionId = null;
}
