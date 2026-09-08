import { Socket, Server } from "socket.io";
import { pool } from "../db";

const DAILY_LIMIT = 10;

async function checkDailyLimit(userId: string): Promise<boolean> {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const result = await pool.query(
    `SELECT COALESCE(SUM(exp_gained), 0) AS total
     FROM user_actions
     WHERE user_id = $1 AND action_type = 'tea_session_message' AND created_at >= $2`,
    [userId, todayStart.toISOString()]
  );
  return parseInt(result.rows[0].total, 10) < DAILY_LIMIT;
}

async function grantExp(userId: string, referenceId: string) {
  await pool.query(
    `INSERT INTO user_actions (id, action_type, exp_gained, user_id, reference_id, created_at)
     VALUES (gen_random_uuid()::text, 'tea_session_message', 2, $1, $2, NOW())`,
    [userId, referenceId]
  );
  await pool.query("UPDATE users SET exp = exp + 2 WHERE id = $1", [userId]);
}

export async function sendMessage(io: Server, socket: Socket, data: {
  sessionId: string;
  content?: string;
  imageUrl?: string;
  type: "text" | "image";
}) {
  if (socket.data.isGuest) {
    socket.emit("error", { message: "请先登录" });
    return;
  }

  const user = socket.data.user;
  if (!user || user.level < 1) {
    socket.emit("error", { message: "需要 Lv.1 茶友以上才能发言" });
    return;
  }

  const { sessionId, content, imageUrl, type } = data || {};
  if (!sessionId || !type) {
    socket.emit("error", { message: "参数不完整" });
    return;
  }
  if (type === "text" && !content?.trim()) {
    socket.emit("error", { message: "内容不能为空" });
    return;
  }

  try {
    // Check session is live
    const sessResult = await pool.query(
      "SELECT status, host_id FROM tea_sessions WHERE id = $1",
      [sessionId]
    );
    if (sessResult.rows.length === 0) {
      socket.emit("error", { message: "茶席不存在" });
      return;
    }
    if (sessResult.rows[0].status !== "live") {
      socket.emit("error", { message: "茶席未开始或已结束" });
      return;
    }

    // Check daily limit
    const withinLimit = await checkDailyLimit(user.id);
    if (!withinLimit) {
      socket.emit("error", { message: "今日发言次数已达上限" });
      return;
    }

    // Insert message
    const msgResult = await pool.query(
      `INSERT INTO tea_session_messages (id, type, content, image_url, session_id, user_id, created_at)
       VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, NOW())
       RETURNING id, created_at`,
      [type, content || null, imageUrl || null, sessionId, user.id]
    );

    const savedMsg = msgResult.rows[0];
    const message = {
      id: savedMsg.id,
      type,
      content: content || null,
      imageUrl: imageUrl || null,
      createdAt: savedMsg.created_at,
      user: {
        id: user.id,
        username: user.username,
        avatar: user.avatar,
        level: user.level,
      },
    };

    // Broadcast to room
    io.to(`session:${sessionId}`).emit("new_message", message);

    // Grant exp
    await grantExp(user.id, savedMsg.id);
  } catch (err) {
    console.error("[send_message]", err);
    socket.emit("error", { message: "发送失败" });
  }
}
