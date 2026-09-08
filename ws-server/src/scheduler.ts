import { pool } from "./db";

const CREDIT_DEDUCT_NO_SHOW = 20;

/**
 * Auto-transition scheduler:
 * - confirmed + scheduledAt <= now(): check host presence → live or expired
 * Runs every 30 seconds.
 */
export function startScheduler(notifyLive: (sessionId: string) => void, notifyExpired: (sessionId: string) => void) {
  const check = async () => {
    try {
      // Find confirmed sessions whose scheduled time has passed
      const result = await pool.query(
        `SELECT id, host_id FROM tea_sessions
         WHERE status = 'confirmed' AND "scheduledAt" <= NOW()
         LIMIT 50`
      );

      for (const row of result.rows) {
        // Check if host has joined the room
        const hostJoin = await pool.query(
          `SELECT id FROM session_participants
           WHERE "sessionId" = $1 AND "userId" = $2
           LIMIT 1`,
          [row.id, row.host_id]
        );

        if (hostJoin.rows.length > 0) {
          // Host joined → start the session
          await pool.query(
            `UPDATE tea_sessions SET status = 'live', "startedAt" = NOW()
             WHERE id = $1 AND status = 'confirmed'`,
            [row.id]
          );
          notifyLive(row.id);

          // Apply no-show penalty for accepted invitees who never joined
          await applyNoShowPenalty(row.id);
        } else {
          // Host didn't join → expire
          await pool.query(
            `UPDATE tea_sessions SET status = 'expired', "endedAt" = NOW()
             WHERE id = $1 AND status = 'confirmed'`,
            [row.id]
          );
          notifyExpired(row.id);
        }
      }
    } catch (err) {
      console.error("[scheduler]", err);
    }
  };

  setInterval(check, 30000);
  console.log("[scheduler] started (30s interval)");
}

async function applyNoShowPenalty(sessionId: string) {
  const accepted = await pool.query(
    `SELECT invitee_id FROM session_invitations
     WHERE "sessionId" = $1 AND status = 'accepted'`,
    [sessionId]
  );

  for (const row of accepted.rows) {
    const joined = await pool.query(
      `SELECT id FROM session_participants
       WHERE "sessionId" = $1 AND "userId" = $2
       LIMIT 1`,
      [sessionId, row.invitee_id]
    );

    if (joined.rows.length === 0) {
      await pool.query(
        `UPDATE users SET "noShowCount" = "noShowCount" + 1,
          "creditScore" = GREATEST(0, "creditScore" - $1)
         WHERE id = $2`,
        [CREDIT_DEDUCT_NO_SHOW, row.invitee_id]
      );
      await pool.query(
        `UPDATE session_invitations SET status = 'no_show'
         WHERE "sessionId" = $1 AND "inviteeId" = $2`,
        [sessionId, row.invitee_id]
      );
    }
  }
}
