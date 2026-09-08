import { Socket, Server } from "socket.io";
import { pool } from "../db";

export async function brewUpdate(io: Server, socket: Socket, data: {
  sessionId: string;
  imageUrl: string;
  description?: string;
}) {
  if (!socket.data.isHost) {
    socket.emit("error", { message: "只有室主可以记录冲泡" });
    return;
  }

  const { sessionId, imageUrl, description } = data || {};
  if (!sessionId || !imageUrl) {
    socket.emit("error", { message: "参数不完整" });
    return;
  }

  try {
    // Increment steep count
    const updateResult = await pool.query(
      `UPDATE tea_sessions SET steep_count = steep_count + 1
       WHERE id = $1 RETURNING steep_count`,
      [sessionId]
    );
    if (updateResult.rows.length === 0) {
      socket.emit("error", { message: "茶席不存在" });
      return;
    }

    const steepNumber = updateResult.rows[0].steep_count;

    // Insert gallery entry
    const galleryResult = await pool.query(
      `INSERT INTO tea_session_gallery (id, steep_number, image_url, description, session_id, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, NOW())
       RETURNING id`,
      [steepNumber, imageUrl, description || null, sessionId]
    );

    // Insert brew_log message
    const msgResult = await pool.query(
      `INSERT INTO tea_session_messages (id, type, brew_log, content, session_id, user_id, created_at)
       VALUES (gen_random_uuid()::text, 'brew_log', $1, $2, $3, $4, NOW())
       RETURNING id, created_at`,
      [
        JSON.stringify({ steepNumber, imageUrl, description: description || "" }),
        `第 ${steepNumber} 泡`,
        sessionId,
        socket.data.user.id,
      ]
    );

    // Broadcast
    io.to(`session:${sessionId}`).emit("brew_updated", {
      steepNumber,
      imageUrl,
      description: description || "",
      messageId: msgResult.rows[0].id,
      createdAt: msgResult.rows[0].created_at,
      galleryId: galleryResult.rows[0].id,
    });
  } catch (err) {
    console.error("[brew_update]", err);
    socket.emit("error", { message: "记录失败" });
  }
}
