import { Socket, Server } from "socket.io";
import { pool } from "../db";

/** Track user online presence */
export function setupPresence(io: Server, socket: Socket) {
  if (!socket.data.user) return; // guests don't get presence

  socket.on("update_presence", async (data: { status: string }) => {
    const { status } = data || {};
    if (!["online", "offline", "busy"].includes(status)) return;

    try {
      await pool.query(
        "UPDATE users SET \"onlineStatus\" = $1 WHERE id = $2",
        [status, socket.data.user.id]
      );
    } catch (err) {
      console.error("[update_presence]", err);
    }
  });

  socket.on("get_online_friends", async () => {
    try {
      const result = await pool.query(
        `SELECT uf.following_id AS id, u.username, u.avatar, u.level, u."onlineStatus"
         FROM user_follows uf
         JOIN users u ON u.id = uf.following_id
         WHERE uf.follower_id = $1 AND u."onlineStatus" = 'online'`,
        [socket.data.user.id]
      );
      socket.emit("online_friends", { friends: result.rows });
    } catch (err) {
      console.error("[get_online_friends]", err);
    }
  });
}
