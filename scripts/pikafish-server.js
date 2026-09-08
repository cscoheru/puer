/**
 * Pikafish UCI HTTP server
 *
 * POST /api/bestmove  { fen, depth?, movetime? }  → { bestmove, ponder?, score?, pv? }
 * POST /api/analyze   { fen, multipv?, depth? }   → { lines: [{score, pv: [moves]}] }
 * POST /api/newgame                                      → { ok: true }
 * GET  /api/health                                       → { ok: true, version }
 *
 * Game history (JSONL-backed, append-only):
 * POST /api/games     { playerId, result, ... }   → { ok: true, id }
 * GET  /api/games?playerId=xxx&limit=50           → { games: [...] }
 *
 * Engine: /opt/pikafish/Linux/pikafish-bmi2
 */
const { spawn } = require("child_process");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const ENGINE_PATH = "/opt/pikafish/Linux/pikafish-bmi2";
const PORT = process.env.PIKAFISH_PORT || 4321;
const HOST = "127.0.0.1"; // loopback only — nginx will proxy

// ── puer-hub session verification ──────────────────────────────────
// NextAuth v5 stores session in JWT cookie, so verification is a stateless
// HTTP call to puer-hub's /api/auth/session. We cache by cookie prefix for
// 30s to avoid hammering puer-hub on every ws message.
const PUERHUB_SESSION_URL = "http://127.0.0.1:3002/api/auth/session";
const SESSION_CACHE_TTL = 30_000;
const sessionCache = new Map();  // cookie-prefix → { user, expiresAt }

async function verifySession(cookieHeader) {
  if (!cookieHeader) return null;
  const key = cookieHeader.slice(0, 300);
  const cached = sessionCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.user;
  try {
    const res = await fetch(PUERHUB_SESSION_URL, { headers: { cookie: cookieHeader } });
    if (!res.ok) return null;
    const data = await res.json();
    const user = data && data.user ? data.user : null;
    sessionCache.set(key, { user, expiresAt: Date.now() + SESSION_CACHE_TTL });
    return user;
  } catch (e) {
    console.warn("[session] verify failed:", e.message);
    return null;
  }
}

// ── Game history storage (JSONL) ───────────────────────────────────
// Each line is a complete game record. Append-only; safe under small
// concurrent writes (< PIPE_BUF = 4KB on Linux, POSIX guarantees atomicity).
const GAMES_FILE = "/opt/pikafish/data/games.jsonl";
try { fs.mkdirSync(path.dirname(GAMES_FILE), { recursive: true }); } catch (e) {}

function appendGame(record) {
  const line = JSON.stringify(record) + "\n";
  fs.appendFileSync(GAMES_FILE, line);
}

function readGames(playerId, limit) {
  let content = "";
  try { content = fs.readFileSync(GAMES_FILE, "utf8"); } catch (e) { /* no file yet */ }
  if (!content.trim()) return [];
  const all = content.split("\n")
    .filter(Boolean)
    .map(l => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  const mine = playerId ? all.filter(g => g.playerId === playerId) : all;
  // Most-recent-first, capped
  return mine.slice(-limit).reverse();
}

const engine = spawn(ENGINE_PATH, [], { cwd: "/opt/pikafish/Linux" });
engine.stderr.on("data", (d) => process.stderr.write(`[engine err] ${d}`));

let buf = "";
let waitForId = 0;
const waiters = new Map(); // id → { resolve, accumulate, lines }
const readyWaiters = []; // FIFO queue of resolve callbacks waiting for `readyok`

engine.stdout.on("data", (chunk) => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    if (process.env.PIKAFISH_DEBUG) console.log(`[engine>] ${line}`);    // `readyok` is UCI's synchronization barrier — engine has finished any
    // pending initialization (NNUE load, setoption, ucinewgame, etc.).
    if (line === "readyok") {
      while (readyWaiters.length) readyWaiters.shift()();
    }
    handleEngineLine(line);
  }
});

function handleEngineLine(line) {
  if (line.startsWith("bestmove")) {
    const m = line.match(/bestmove (\S+)(?:\s+ponder\s+(\S+))?/);
    const w = waiters.get(waitForId);
    if (w && m) {
      w.resolve({
        bestmove: m[1],
        ponder: m[2] || null,
        lines: w.lines || [],
      });
      waiters.delete(waitForId);
    }
    return;
  }
  if (line.startsWith("info") && line.includes(" pv ")) {
    const w = waiters.get(waitForId);
    if (!w || !w.accumulate) return;
    const multipv = parseInt((line.match(/ multipv (\d+)/) || [])[1] || "1", 10);
    const scoreCp = (line.match(/ score cp (-?\d+)/) || [])[1];
    const scoreMate = (line.match(/ score mate (-?\d+)/) || [])[1];
    const pv = (line.match(/ pv (.+)$/)||[])[1];
    if (!pv) return;
    w.lines = w.lines || [];
    w.lines[multipv - 1] = {
      multipv,
      score: scoreCp !== undefined ? { type: "cp", value: parseInt(scoreCp, 10) } : null,
      mate: scoreMate !== undefined ? parseInt(scoreMate, 10) : null,
      pv: pv.trim().split(/\s+/),
    };
    return;
  }
}

function sendEngine(cmd) {
  engine.stdin.write(cmd + "\n");
}

// Returns a Promise that resolves on the next `readyok` from the engine.
// Critical for correctness: `setoption` and `ucinewgame` must complete before
// we send `position` and `go`, otherwise the engine may silently drop commands
// or apply them out of order (especially during cold-start when NNUE is still
// loading — observed as a multi-second hang on the first bestmove request).
function waitForReady() {
  return new Promise((resolve) => {
    readyWaiters.push(resolve);
    sendEngine("isready");
  });
}

// Queue: only one search at a time
let pending = Promise.resolve();
function enqueue(fn) {
  const next = pending.then(fn, fn);
  pending = next.catch(() => {});
  return next;
}

function search({ fen, depth, movetime, multipv, moves }) {
  return enqueue(async () => {
    // Cancel any in-flight search first so setoption/position don't get
    // wedged behind a long think.
    sendEngine("stop");
    // MultiPV must be set BEFORE position/go — Pikafish caches search params
    // at `go` time. Setting it after `position` is fine per UCI, but ordering
    // it first is defensive.
    if (multipv && multipv > 1) sendEngine(`setoption name MultiPV value ${multipv}`);
    else sendEngine("setoption name MultiPV value 1");
    // Move history lets Pikafish detect repetition (Chinese chess bans
    // perpetual check/chase — having the moves helps it score repeating
    // lines as bad instead of equal).
    if (Array.isArray(moves) && moves.length) {
      sendEngine(`position startpos moves ${moves.join(" ")}`);
    } else if (fen) {
      sendEngine(`position fen ${fen}`);
    } else {
      sendEngine("position startpos");
    }
    // Sync barrier: wait until engine confirms the setoption/position above
    // have been applied. Without this, on a cold engine (NNUE still loading
    // or hash still being cleared from ucinewgame) we can send `go` before
    // the engine is ready, which silently wedges the request.
    await waitForReady();

    return new Promise((resolve, reject) => {
      const id = ++waitForId;
      const ctx = { resolve, reject, lines: [], accumulate: multipv > 1 || false };
      waiters.set(id, ctx);

      let cmd = "go";
      if (depth) cmd += ` depth ${depth}`;
      else if (movetime) cmd += ` movetime ${movetime}`;
      else cmd += ` movetime 1000`; // default 1s
      sendEngine(cmd);

      // Hard timeout safety — if the engine never returns bestmove (e.g.,
      // it crashed or stdin got stuck), force-resolve so we don't wedge
      // the enqueue chain and starve every subsequent request.
      const timeoutMs = (movetime || (depth ? 10000 : 1000)) + 3000;
      const timer = setTimeout(() => {
        if (waiters.has(id)) {
          sendEngine("stop");
          waiters.delete(id);
          reject(new Error(`engine timeout after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      // Stash timer so resolution path can clear it.
      const origResolve = ctx.resolve;
      const origReject = ctx.reject;
      ctx.resolve = (v) => { clearTimeout(timer); origResolve(v); };
      ctx.reject = (e) => { clearTimeout(timer); origReject(e); };
    });
  });
}

function sendUciInit() {
  return new Promise((resolve) => {
    let version = "unknown";
    const onData = (line) => {
      if (line.startsWith("id name")) version = line.slice(8);
      if (line === "uciok") {
        engine.stdout.removeListener("data-temp", onData);
        resolve(version);
      }
    };
    // Listen by intercepting
    const orig = handleEngineLine;
    // simpler: just send and resolve after small delay
    sendEngine("uci");
    setTimeout(() => resolve(version), 500);
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // CORS allow all (fronted via nginx same-origin in prod)
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  try {
    if (req.method === "GET" && req.url === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, engine: "pikafish" }));
      return;
    }

    if (req.method === "GET" && req.url === "/api/me") {
      const user = await verifySession(req.headers.cookie);
      res.writeHead(200);
      res.end(JSON.stringify({ user }));
      return;
    }

    if (req.method === "POST") {
      const body = await readBody(req);
      const data = body ? JSON.parse(body) : {};

      if (req.url === "/api/bestmove") {
        const result = await search({
          fen: data.fen,
          moves: data.moves,
          depth: data.depth,
          movetime: data.movetime,
          multipv: data.multipv || 1,
        });
        res.writeHead(200);
        res.end(JSON.stringify(result));
        return;
      }

      if (req.url === "/api/analyze") {
        const result = await search({
          fen: data.fen,
          moves: data.moves,
          depth: data.depth || 18,
          multipv: data.multipv || 3,
        });
        res.writeHead(200);
        res.end(JSON.stringify({ lines: (result.lines || []).filter(Boolean) }));
        return;
      }

      if (req.url === "/api/newgame") {
        sendEngine("ucinewgame");
        res.writeHead(200);
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      // Save a completed game (called from finishGame on the client)
      if (req.url === "/api/games") {
        const record = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          time: Date.now(),
          playerId: data.playerId || "anonymous",
          result: data.result,            // "胜" | "负" | "和"
          side: data.side,                // "red" | "black"
          oppRank: data.oppRank,
          moves: data.moves,
          reason: data.reason,
          rankBefore: data.rankBefore,
          rankAfter: data.rankAfter,
          rankDelta: data.rankDelta,
          duration: data.duration,
          moveList: data.moveList || [],  // UCI moves for replay
        };
        try {
          appendGame(record);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, id: record.id }));
        } catch (err) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: err.message }));
        }
        return;
      }
    }

    // GET endpoints
    if (req.method === "GET" && req.url.startsWith("/api/games")) {
      const url = new URL(req.url, "http://localhost");
      const playerId = url.searchParams.get("playerId");
      const limit = parseInt(url.searchParams.get("limit") || "50", 10);
      const games = readGames(playerId, Math.min(limit, 200));
      res.writeHead(200);
      res.end(JSON.stringify({ games }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "not found" }));
  } catch (err) {
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) reject(new Error("payload too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

server.listen(PORT, HOST, () => {
  console.log(`Pikafish UCI server on http://${HOST}:${PORT}`);
});

// ── P2P multiplayer (WebSocket) ────────────────────────────────────
// In-memory state. Single process — fine for low traffic. If we ever need
// horizontal scaling, replace these Maps with Redis.
const sockets = new Map();  // userId → ws
const lobby = new Map();    // userId → { side, rank, nickname, since }
const rooms = new Map();    // roomId → { players: [{userId, side, nickname, rank}], moves: [uci], status, startTime }

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", async (ws, req) => {
  const user = await verifySession(req.headers.cookie);
  if (!user) {
    ws.close(4001, "unauthorized");
    return;
  }
  // Single connection per user — replace any old socket
  if (sockets.has(user.id)) {
    try { sockets.get(user.id).close(4002, "replaced"); } catch {}
  }
  sockets.set(user.id, ws);
  ws.userId = user.id;
  ws.user = user;
  console.log(`[ws] connected: ${user.id} (${user.nickname || user.name})`);

  // Send current lobby state immediately
  send(ws, { type: "lobby.update", challenges: lobbyList() });

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    handleMessage(user, ws, msg).catch(e => console.warn("[ws] handler error:", e.message));
  });

  ws.on("close", () => handleDisconnect(user));
  ws.on("error", () => handleDisconnect(user));
});

function send(ws, obj) {
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(obj)); } catch {}
  }
}

function lobbyList() {
  return [...lobby.entries()].map(([id, c]) => ({
    userId: id,
    nickname: c.nickname,
    rank: c.rank,
    side: c.side,
    since: c.since,
  }));
}

function broadcastLobby() {
  const payload = JSON.stringify({ type: "lobby.update", challenges: lobbyList() });
  for (const ws of sockets.values()) {
    if (ws.readyState === 1) {
      try { ws.send(payload); } catch {}
    }
  }
}

async function handleMessage(user, ws, msg) {
  switch (msg.type) {
    case "lobby.join":    return handleLobbyJoin(user, msg);
    case "lobby.leave":   return handleLobbyLeave(user);
    case "lobby.accept":  return handleLobbyAccept(user, msg);
    case "game.move":     return handleGameMove(user, msg);
    case "game.resign":   return handleGameEnd(user, msg, "resign");
    case "game.flee":     return handleGameEnd(user, msg, "flee");
    case "game.draw.offer":  return handleDrawOffer(user, msg);
    case "game.draw.respond":return handleDrawRespond(user, msg);
    case "game.chat":     return handleGameChat(user, msg);
    case "ping":          return send(ws, { type: "pong" });
  }
}

function handleLobbyJoin(user, msg) {
  lobby.set(user.id, {
    side: msg.side || "any",        // "red" | "black" | "any"
    rank: msg.rank || "?",
    nickname: user.nickname || user.name || "玩家",
    since: Date.now(),
  });
  broadcastLobby();
}

function handleLobbyLeave(user) {
  lobby.delete(user.id);
  broadcastLobby();
}

function handleLobbyAccept(user, msg) {
  // user (B) accepts msg.targetUserId (A)'s challenge.
  const aId = msg.targetUserId;
  if (!lobby.has(aId)) {
    send(sockets.get(user.id), { type: "error", message: "该挑战已不存在" });
    return;
  }
  const aChallenge = lobby.get(aId);
  // Determine sides: A picked a side; if A is "any", default A=red, B=black.
  let aSide = aChallenge.side;
  if (aSide === "any") aSide = "red";
  const bSide = aSide === "red" ? "black" : "red";
  // If user explicitly wanted a side that conflicts, refuse
  if (msg.mySide && msg.mySide !== "any" && msg.mySide !== bSide) {
    send(sockets.get(user.id), { type: "error", message: "执棋方冲突" });
    return;
  }

  const roomId = `r-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const aUser = { id: aId, nickname: aChallenge.nickname, rank: aChallenge.rank };
  const bUser = { id: user.id, nickname: user.nickname || user.name || "玩家", rank: msg.rank || "?" };
  rooms.set(roomId, {
    players: [
      { userId: aId, side: aSide, nickname: aChallenge.nickname, rank: aChallenge.rank },
      { userId: user.id, side: bSide, nickname: bUser.nickname, rank: bUser.rank },
    ],
    moves: [],
    status: "playing",
    startTime: Date.now(),
  });
  // Remove both from lobby
  lobby.delete(aId);
  lobby.delete(user.id);
  broadcastLobby();
  // Notify both players
  const aWs = sockets.get(aId);
  const bWs = sockets.get(user.id);
  send(aWs, {
    type: "game.start",
    roomId,
    mySide: aSide,
    opponent: bUser,
    you: { id: aId, nickname: aChallenge.nickname, rank: aChallenge.rank },
  });
  send(bWs, {
    type: "game.start",
    roomId,
    mySide: bSide,
    opponent: aUser,
    you: bUser,
  });
}

function handleGameMove(user, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.status !== "playing") return;
  // Verify it's this user's turn (red moves on even indices, black on odd)
  const moverIdx = room.moves.length % 2;
  const moverSide = moverIdx === 0 ? "red" : "black";
  const player = room.players.find(p => p.userId === user.id);
  if (!player || player.side !== moverSide) {
    send(sockets.get(user.id), { type: "error", message: "还没轮到你" });
    return;
  }
  room.moves.push(msg.uci);
  // Broadcast to the OTHER player only — the sender already applied the move
  // locally for snappy UX. Echoing back would cause a double-application.
  const payload = { type: "game.move", roomId: msg.roomId, uci: msg.uci, moverSide };
  for (const p of room.players) {
    if (p.userId === user.id) continue;
    send(sockets.get(p.userId), payload);
  }
}

function handleGameEnd(user, msg, reason) {
  const room = rooms.get(msg.roomId);
  if (!room || room.status !== "playing") return;
  // mover resigns/flees → other side wins
  const loserSide = room.players.find(p => p.userId === user.id)?.side;
  const winnerSide = loserSide === "red" ? "black" : "red";
  room.status = "ended";
  const payload = { type: "game.end", roomId: msg.roomId, winner: winnerSide, reason };
  for (const p of room.players) {
    send(sockets.get(p.userId), payload);
  }
  // Record game history (one record per player, mirrored)
  const winner = room.players.find(p => p.side === winnerSide);
  const loser = room.players.find(p => p.side === loserSide);
  for (const p of room.players) {
    const isWinner = p.userId === winner?.userId;
    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
      time: Date.now(),
      playerId: p.userId,
      result: isWinner ? "胜" : "负",
      side: p.side,
      oppRank: (isWinner ? loser : winner)?.rank || "?",
      moves: room.moves.length,
      reason: reason === "resign" ? "对手认输" : "对手逃跑",
      duration: Math.round((Date.now() - room.startTime) / 1000),
      moveList: room.moves,
    };
    try { appendGame(record); } catch {}
  }
  rooms.delete(msg.roomId);
}

function handleDrawOffer(user, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.status !== "playing") return;
  const opp = room.players.find(p => p.userId !== user.id);
  if (!opp) return;
  send(sockets.get(opp.userId), { type: "game.draw.offer", roomId: msg.roomId, from: user.id });
}

function handleDrawRespond(user, msg) {
  const room = rooms.get(msg.roomId);
  if (!room || room.status !== "playing") return;
  if (msg.accept) {
    room.status = "ended";
    const payload = { type: "game.end", roomId: msg.roomId, winner: "draw", reason: "draw-accepted" };
    for (const p of room.players) send(sockets.get(p.userId), payload);
    // History record for both
    for (const p of room.players) {
      appendGame({
        id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`,
        time: Date.now(),
        playerId: p.userId,
        result: "和",
        side: p.side,
        oppRank: room.players.find(x => x.userId !== p.userId)?.rank || "?",
        moves: room.moves.length,
        reason: "和棋",
        duration: Math.round((Date.now() - room.startTime) / 1000),
        moveList: room.moves,
      });
    }
    rooms.delete(msg.roomId);
  } else {
    const opp = room.players.find(p => p.userId !== user.id);
    send(sockets.get(opp?.userId), { type: "game.draw.declined", roomId: msg.roomId });
  }
}

function handleGameChat(user, msg) {
  const room = rooms.get(msg.roomId);
  if (!room) return;
  const payload = {
    type: "game.chat",
    roomId: msg.roomId,
    from: user.id,
    nickname: user.nickname || user.name || "玩家",
    text: String(msg.text || "").slice(0, 200),
  };
  for (const p of room.players) send(sockets.get(p.userId), payload);
}

function handleDisconnect(user) {
  if (sockets.get(user.id)?.userId === user.id) {
    sockets.delete(user.id);
  }
  // Leave lobby if present
  if (lobby.delete(user.id)) broadcastLobby();
  // Auto-flee from any active rooms
  for (const [roomId, room] of rooms) {
    if (room.status !== "playing") continue;
    const player = room.players.find(p => p.userId === user.id);
    if (!player) continue;
    handleGameEnd(user, { roomId }, "flee");
    break;
  }
  console.log(`[ws] disconnected: ${user.id}`);
}

// Warm up: send `uci`, then block on `readyok` so the engine has fully
// loaded NNUE before we accept any search request. Without this gate, the
// first user request races the engine's cold-start and can wedge silently.
sendEngine("uci");
waitForReady().then(() => {
  console.log("[engine] ready (uciok + readyok received)");
}).catch((e) => {
  console.error("[engine] init failed:", e);
});

process.on("SIGTERM", () => {
  sendEngine("quit");
  setTimeout(() => process.exit(0), 200);
});
