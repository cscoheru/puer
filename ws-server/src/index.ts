import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import cors from "cors";
import { config } from "./config";
import { pool } from "./db";
import { handleConnection } from "./handlers/connection";
import { joinSession, leaveSession } from "./handlers/session";
import { sendMessage } from "./handlers/chat";
import { brewUpdate } from "./handlers/brew";
import { setupPresence } from "./handlers/presence";
import { startScheduler } from "./scheduler";
import cron from "node-cron";
import { spawn } from "child_process";

const app = express();
app.use(cors({ origin: config.CORS_ORIGIN }));
app.get("/health", (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Invitation push: REST API notifies invited users in real-time
app.post("/internal/invitation-created", express.json(), async (req, res) => {
  const { inviteeIds, session } = req.body;
  if (!Array.isArray(inviteeIds) || !session?.id) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  for (const userId of inviteeIds) {
    io.to(`user:${userId}`).emit("new_invitation", { session });
  }
  res.json({ ok: true });
});

// Invitation response: notify host when invitee accepts/declines
app.post("/internal/invitation-response", express.json(), async (req, res) => {
  const { hostId, invitation } = req.body;
  if (!hostId || !invitation) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  io.to(`user:${hostId}`).emit("invitation_response", { invitation });
  res.json({ ok: true });
});

// Session started/ended notification from REST API
app.post("/internal/session-event", express.json(), async (req, res) => {
  const { sessionId, event } = req.body;
  if (!sessionId || !event) {
    res.status(400).json({ error: "missing fields" });
    return;
  }
  const room = `session:${sessionId}`;
  if (event === "started") {
    io.to(room).emit("system_message", { type: "system", content: "茶会已正式开始 🍵" });
  } else if (event === "ended") {
    io.to(room).emit("system_message", { type: "system", content: "茶会已结束，感谢围观" });
  } else if (event === "cancelled") {
    io.to(room).emit("system_message", { type: "system", content: "茶会已取消" });
  } else if (event === "expired") {
    io.to(room).emit("system_message", { type: "system", content: "发起人未准时入席，茶会已过期" });
  }
  res.json({ ok: true });
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST"],
  },
  pingInterval: 10000,
  pingTimeout: 5000,
});

io.on("connection", (socket) => {
  handleConnection(io, socket);

  socket.on("join_session", (data) => joinSession(io, socket, data));
  socket.on("leave_session", (data) => leaveSession(io, socket, data));
  socket.on("send_message", (data) => sendMessage(io, socket, data));
  socket.on("brew_update", (data) => brewUpdate(io, socket, data));

  // New handlers
  setupPresence(io, socket);
});

httpServer.listen(config.WS_PORT, () => {
  console.log(`WS server listening on port ${config.WS_PORT}`);
  startScheduler(
    (sessionId) => {
      io.to(`session:${sessionId}`).emit("system_message", {
        type: "system",
        content: "茶会已正式开始 🍵",
      });
    },
    (sessionId) => {
      io.to(`session:${sessionId}`).emit("system_message", {
        type: "system",
        content: "发起人未准时入席，茶会已过期",
      });
    }
  );

  // Daily community engagement engine: auto-vote then auto-essence at 3:00.
  // spawn() isolates the scripts (they call process.exit when finished).
  cron.schedule("0 3 * * *", () => {
    console.log("[cron] auto-vote starting");
    const vote = spawn("node", ["/app/scripts/auto-vote.mjs"], { stdio: "inherit" });
    vote.on("close", () => {
      console.log("[cron] auto-essence starting");
      spawn("node", ["/app/scripts/auto-essence.mjs"], { stdio: "inherit" });
    });
  });
});

// Graceful shutdown
process.on("SIGTERM", async () => {
  console.log("SIGTERM received, closing...");
  io.close();
  await pool.end();
  httpServer.close();
  process.exit(0);
});
