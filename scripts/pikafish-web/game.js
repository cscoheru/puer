// ── Constants ──────────────────────────────────────────────────────
// Build marker — bump this when deploying fixes (visible in browser devtools console)
const GAME_JS_VERSION = "2026-06-14-v17";
console.log(`[pikafish-web] game.js loaded, version=${GAME_JS_VERSION}`);

// Xiangqi board: 9 cols × 10 rows
// Coordinates: file 0-8 (a-i), rank 0-9 (rank 0 = red back rank, rank 9 = black back rank)
// Pikafish UCI convention (same as Stockfish/chess):
//   UPPERCASE = Red (first to move, side "w"), starts at bottom (board[6..9])
//   lowercase = Black (side "b"), starts at top (board[0..3])

const PIECE_NAMES = {
  R: "车", N: "马", B: "相", A: "仕", K: "帅", C: "炮", P: "兵",  // uppercase = red (simplified)
  r: "車", n: "馬", b: "象", a: "士", k: "將", c: "砲", p: "卒",  // lowercase = black (traditional)
};

const START_FEN = "rnbakabnr/9/1c5c1/p1p1p1p1p/9/9/P1P1P1P1P/1C5C1/9/RNBAKABNR w - - 0 1";

// ── State ──────────────────────────────────────────────────────────
let board = [];      // 10x9 array of piece chars or null
let side = "w";      // whose turn: 'w' (red) or 'b' (black)
let selected = null; // [row, col] of selected piece
let legalMoves = []; // valid destinations for selected piece
let moveHistory = [];
let lastMove = null;  // { from: [r,c], to: [r,c] } — highlighted on board
let suggestions = []; // [{from, to, rank, eval, repetition}] — top-N engine picks for current side
let positionHistory = new Set();  // hashes of past positions for repetition detection
let playerSide = "red"; // "red" or "black"
let aiThinking = false;
let mode = "play-ai";  // "play-ai" | "play-p2p" | "analyze"
let flipped = false;
let currentSuggestions = null;  // last-shown PV lines (for deep analysis click-through)
let deepAnalysisState = null;   // snapshot + move sequence when in deep mode
let currentUser = null;         // puer-hub user object, or null if logged out
let p2pSocket = null;           // WebSocket connection for P2P mode
let p2pRoom = null;             // { roomId, mySide, opponent, ... } once game starts
let myLobbyEntry = null;        // tracks whether this user is currently in the lobby
const SUGGESTION_COLORS = ["#fbbf24", "#cbd5e1", "#d97706"]; // gold/silver/bronze

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d");

// ── Audio (Web Audio API — synthesized, no external assets) ────────
let audioCtx = null;
let audioEnabled = true;

function ensureAudio() {
  if (audioCtx) return audioCtx;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    audioCtx = new AC();
  } catch (e) {
    console.warn("[audio] init failed", e);
    return null;
  }
  return audioCtx;
}

// Soft "tink" for piece selection
function playSelectSound() {
  if (!audioEnabled) return;
  const c = ensureAudio();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  const t = c.currentTime;
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(880, t);
  osc.frequency.exponentialRampToValueAtTime(660, t + 0.06);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.1);
}

// Wooden "clack" for piece placement (triangle thud + noise burst)
function playMoveSound(capture) {
  if (!audioEnabled) return;
  const c = ensureAudio();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  const t = c.currentTime;

  // Low triangle thud
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "triangle";
  const baseFreq = capture ? 140 : 200;
  osc.frequency.setValueAtTime(baseFreq, t);
  osc.frequency.exponentialRampToValueAtTime(baseFreq * 0.5, t + 0.12);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(capture ? 0.4 : 0.3, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.2);

  // Filtered noise for the wood "tick"
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * 0.04), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    const env = Math.pow(1 - i / data.length, 3);
    data[i] = (Math.random() * 2 - 1) * env;
  }
  const noise = c.createBufferSource();
  noise.buffer = buf;
  const noiseGain = c.createGain();
  noiseGain.gain.value = capture ? 0.25 : 0.18;
  const filter = c.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = capture ? 1800 : 1200;
  noise.connect(filter);
  filter.connect(noiseGain);
  noiseGain.connect(c.destination);
  noise.start(t);
}

// Voice playback (Web Speech API) — used for "吃" and "将军" callouts.
// Falls back silently if the browser has no Chinese TTS voice.
let _zhVoice = null;
function pickZhVoice() {
  if (!("speechSynthesis" in window)) return null;
  if (_zhVoice) return _zhVoice;
  const voices = window.speechSynthesis.getVoices();
  _zhVoice = voices.find(v => v.lang === "zh-CN") ||
            voices.find(v => v.lang && v.lang.startsWith("zh")) || null;
  return _zhVoice;
}
if ("speechSynthesis" in window) {
  // Voices load asynchronously in some browsers
  window.speechSynthesis.onvoiceschanged = () => { _zhVoice = null; pickZhVoice(); };
}

function speak(text) {
  if (!audioEnabled) return;
  if (!("speechSynthesis" in window)) return;
  try {
    const utter = new SpeechSynthesisUtterance(text);
    const v = pickZhVoice();
    if (v) utter.voice = v;
    utter.lang = "zh-CN";
    utter.rate = 1.4;       // fast — callouts should be punchy
    utter.pitch = 1.1;
    utter.volume = 0.85;
    window.speechSynthesis.cancel();  // don't queue up stale callouts
    window.speechSynthesis.speak(utter);
  } catch (e) {
    console.warn("[audio] TTS failed:", e);
  }
}

// Sharper "whack" for captures — a high-frequency bell hit on top of the
// regular wooden clack, so the user hears the difference between a quiet
// move and a capture even without the TTS voice.
function playCaptureSound() {
  if (!audioEnabled) return;
  const c = ensureAudio();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  const t = c.currentTime;
  // Bright metallic hit
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = "square";
  osc.frequency.setValueAtTime(1320, t);
  osc.frequency.exponentialRampToValueAtTime(660, t + 0.08);
  gain.gain.setValueAtTime(0.0001, t);
  gain.gain.exponentialRampToValueAtTime(0.22, t + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
  osc.connect(gain);
  gain.connect(c.destination);
  osc.start(t);
  osc.stop(t + 0.17);
}

// "Check!" warning — two ascending bell tones (E5 → A5) so it cuts through
// even if the user isn't looking at the board.
function playCheckSound() {
  if (!audioEnabled) return;
  const c = ensureAudio();
  if (!c) return;
  if (c.state === "suspended") c.resume();
  const t0 = c.currentTime;
  [0, 0.14].forEach((delay, i) => {
    const t = t0 + delay;
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = "triangle";
    const freq = i === 0 ? 660 : 880;  // E5 → A5
    osc.frequency.setValueAtTime(freq, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.3, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.2);
  });
}

// ── FEN ────────────────────────────────────────────────────────────
function parseFen(fen) {
  const [pos, turn] = fen.split(" ");
  const rows = pos.split("/");
  board = rows.map((row) => {
    const arr = [];
    for (const ch of row) {
      if (/\d/.test(ch)) for (let i = 0; i < parseInt(ch); i++) arr.push(null);
      else arr.push(ch);
    }
    return arr;
  });
  side = turn === "b" ? "b" : "w";
}

function toFen() {
  const rows = board.map((row) => {
    let s = "", empty = 0;
    for (const c of row) {
      if (c === null) empty++;
      else {
        if (empty) { s += empty; empty = 0; }
        s += c;
      }
    }
    if (empty) s += empty;
    return s;
  });
  return `${rows.join("/")} ${side} - - 0 ${Math.floor(moveHistory.length / 2) + 1}`;
}

function isRed(p) { return p && p === p.toUpperCase() && p !== p.toLowerCase(); }
function isBlack(p) { return p && p === p.toLowerCase() && p !== p.toUpperCase(); }

// ── Repetition detection ───────────────────────────────────────────
// Hash board state + side-to-move so we can detect when a candidate
// move would recreate a position that's already occurred. Xiangqi
// bans perpetual check/chase — these moves must be flagged.
function positionHash(b, s) {
  let h = "";
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) h += b[r][c] || ".";
    h += "|";
  }
  return h + s;
}

function currentPositionHash() {
  return positionHash(board, side);
}

// Returns true if playing (from → to) recreates a past position.
function moveCreatesRepetition(from, to) {
  const piece = board[from[0]][from[1]];
  const target = board[to[0]][to[1]];
  board[to[0]][to[1]] = piece;
  board[from[0]][from[1]] = null;
  const newSide = side === "w" ? "b" : "w";
  const h = positionHash(board, newSide);
  // Restore
  board[from[0]][from[1]] = piece;
  board[to[0]][to[1]] = target;
  return positionHistory.has(h);
}

// ── Move generation (simplified — enough for casual play; Pikafish does the real work) ──
function inBoard(r, c) { return r >= 0 && r < 10 && c >= 0 && c < 9; }
function inPalace(r, c, isRedSide) {
  if (c < 3 || c > 5) return false;
  return isRedSide ? (r >= 7 && r <= 9) : (r >= 0 && r <= 2);
}

function genMoves(fromR, fromC) {
  const p = board[fromR][fromC];
  if (!p) return [];
  const red = isRed(p);
  const type = p.toLowerCase();
  const moves = [];

  const tryMove = (r, c) => {
    if (!inBoard(r, c)) return false;
    const t = board[r][c];
    if (!t) { moves.push([r, c]); return true; }
    if ((red && isRed(t)) || (!red && isBlack(t))) return false; // own piece blocks
    moves.push([r, c]); // capture
    return false; // stop sliding
  };

  if (type === "r") { // 车车
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc]) => {
      for (let i = 1; i < 10; i++) {
        const r = fromR + dr*i, c = fromC + dc*i;
        if (!tryMove(r, c)) break;
      }
    });
  } else if (type === "c") { // 炮
    [[1,0],[-1,0],[0,1],[0,-1]].forEach(([dr,dc]) => {
      let jumped = false;
      for (let i = 1; i < 10; i++) {
        const r = fromR + dr*i, c = fromC + dc*i;
        if (!inBoard(r, c)) break;
        const t = board[r][c];
        if (!jumped) {
          if (!t) moves.push([r, c]);
          else jumped = true;
        } else {
          if (t) {
            if ((red && isBlack(t)) || (!red && isRed(t))) moves.push([r, c]);
            break;
          }
        }
      }
    });
  } else if (type === "n") { // 马
    const knightMoves = [
      [-2,-1,-1,0],[-2,1,-1,0],[2,-1,1,0],[2,1,1,0],
      [-1,-2,0,-1],[1,-2,0,-1],[-1,2,0,1],[1,2,0,1]
    ];
    knightMoves.forEach(([dr,dc,br,bc]) => {
      const blockR = fromR + br, blockC = fromC + bc;
      if (inBoard(blockR, blockC) && board[blockR][blockC]) return; // hobbled
      const r = fromR + dr, c = fromC + dc;
      if (!inBoard(r, c)) return;
      const t = board[r][c];
      if (!t || (red ? isBlack(t) : isRed(t))) moves.push([r, c]);
    });
  } else if (type === "b") { // 相/象
    [[-2,-2],[-2,2],[2,-2],[2,2]].forEach(([dr,dc]) => {
      const r = fromR + dr, c = fromC + dc;
      if (!inBoard(r, c)) return;
      if (red && r < 5) return; // 红相不过河
      if (!red && r > 4) return; // 黑象不过河
      if (board[fromR + dr/2][fromC + dc/2]) return; // 塞象眼
      const t = board[r][c];
      if (!t || (red ? isBlack(t) : isRed(t))) moves.push([r, c]);
    });
  } else if (type === "a") { // 仕/士
    [[-1,-1],[-1,1],[1,-1],[1,1]].forEach(([dr,dc]) => {
      const r = fromR + dr, c = fromC + dc;
      if (!inPalace(r, c, red)) return;
      const t = board[r][c];
      if (!t || (red ? isBlack(t) : isRed(t))) moves.push([r, c]);
    });
  } else if (type === "k") { // 帅/将
    [[-1,0],[1,0],[0,-1],[0,1]].forEach(([dr,dc]) => {
      const r = fromR + dr, c = fromC + dc;
      if (!inPalace(r, c, red)) return;
      const t = board[r][c];
      if (!t || (red ? isBlack(t) : isRed(t))) moves.push([r, c]);
    });
    // Flying general check would happen at move validation
  } else if (type === "p") { // 兵/卒
    const forward = red ? -1 : 1;
    const crossed = red ? fromR <= 4 : fromR >= 5;
    [[forward, 0], ...(crossed ? [[0,-1],[0,1]] : [])].forEach(([dr,dc]) => {
      const r = fromR + dr, c = fromC + dc;
      if (!inBoard(r, c)) return;
      const t = board[r][c];
      if (!t || (red ? isBlack(t) : isRed(t))) moves.push([r, c]);
    });
  }

  return moves;
}

function allMoves(forRed) {
  const list = [];
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = board[r][c];
    if (!p) continue;
    if (forRed ? isRed(p) : isBlack(p)) {
      genMoves(r, c).forEach(([tr, tc]) => list.push({from: [r,c], to: [tr,tc]}));
    }
  }
  return list;
}

// ── Render ─────────────────────────────────────────────────────────
const PADDING = 30;
const CELL = 60;
const COLS = 9, ROWS = 10;

function coordToFile(r, c) {
  // file = column letter a-i (0-8)
  return String.fromCharCode(97 + c);
}
function moveToUci(from, to) {
  // Xiangqi UCI: file_from + rank_from + file_to + rank_to (rank 0 = bottom = red side)
  // Pikafish uses: a-i for file, 0-9 for rank (0 = red back rank at row 9 in our array)
  // Our board[0] is top (black side), board[9] is bottom (red side)
  const f1 = String.fromCharCode(97 + from[1]);
  const r1 = 9 - from[0];
  const f2 = String.fromCharCode(97 + to[1]);
  const r2 = 9 - to[0];
  return `${f1}${r1}${f2}${r2}`;
}

function uciToMove(uci) {
  const fromC = uci.charCodeAt(0) - 97;
  const fromR = 9 - parseInt(uci[1]);
  const toC = uci.charCodeAt(2) - 97;
  const toR = 9 - parseInt(uci[3]);
  return { from: [fromR, fromC], to: [toR, toC] };
}

function draw() {
  const W = canvas.width, H = canvas.height;
  ctx.fillStyle = "#f0d9a8";
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = "#5d3a1a";
  ctx.lineWidth = 1.5;

  const xOf = (c) => PADDING + c * CELL;
  const yOf = (r) => PADDING + r * CELL;

  // Horizontal lines
  for (let r = 0; r < 10; r++) {
    ctx.beginPath();
    ctx.moveTo(xOf(0), yOf(r));
    ctx.lineTo(xOf(8), yOf(r));
    ctx.stroke();
  }
  // Vertical lines (broken at river)
  for (let c = 0; c < 9; c++) {
    ctx.beginPath();
    if (c === 0 || c === 8) {
      ctx.moveTo(xOf(c), yOf(0));
      ctx.lineTo(xOf(c), yOf(9));
    } else {
      ctx.moveTo(xOf(c), yOf(0));
      ctx.lineTo(xOf(c), yOf(4));
      ctx.moveTo(xOf(c), yOf(5));
      ctx.lineTo(xOf(c), yOf(9));
    }
    ctx.stroke();
  }
  // Palace diagonals
  ctx.beginPath();
  ctx.moveTo(xOf(3), yOf(0)); ctx.lineTo(xOf(5), yOf(2));
  ctx.moveTo(xOf(5), yOf(0)); ctx.lineTo(xOf(3), yOf(2));
  ctx.moveTo(xOf(3), yOf(7)); ctx.lineTo(xOf(5), yOf(9));
  ctx.moveTo(xOf(5), yOf(7)); ctx.lineTo(xOf(3), yOf(9));
  ctx.stroke();

  // River text
  ctx.fillStyle = "#5d3a1a";
  ctx.font = "20px serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("楚 河", xOf(1.5), yOf(4.5));
  ctx.fillText("漢 界", xOf(6.5), yOf(4.5));

  // Highlight selected and legal moves
  if (selected) {
    ctx.strokeStyle = "#22c55e";
    ctx.lineWidth = 3;
    const [sr, sc] = selected;
    ctx.strokeRect(xOf(sc) - 28, yOf(sr) - 28, 56, 56);
    ctx.fillStyle = "rgba(34,197,94,0.25)";
    legalMoves.forEach(([r, c]) => {
      ctx.beginPath();
      ctx.arc(xOf(c), yOf(r), 12, 0, Math.PI * 2);
      ctx.fill();
    });
  }

  // Highlight last move from/to squares (yellow halo)
  if (lastMove) {
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth = 3;
    ctx.setLineDash([6, 4]);
    [lastMove.from, lastMove.to].forEach(([r, c]) => {
      const dr = flipped ? 9 - r : r;
      const dc = flipped ? 8 - c : c;
      ctx.strokeRect(xOf(dc) - 28, yOf(dr) - 28, 56, 56);
    });
    ctx.setLineDash([]);
  }

  // Suggestion arrows — drawn BELOW pieces so they don't cover the pieces
  if (suggestions && suggestions.length > 0) {
    ctx.save();
    ctx.globalAlpha = 0.85;
    suggestions.forEach((s, i) => {
      const color = SUGGESTION_COLORS[i] || "#666";
      const label = moveArrowLabel(s.from, s.to);
      drawArrow(s.from, s.to, color, label);
    });
    ctx.restore();
  }

  // Pieces
  for (let r = 0; r < 10; r++) {
    for (let c = 0; c < 9; c++) {
      const p = board[r][c];
      if (!p) continue;
      const dispR = flipped ? 9 - r : r;
      const dispC = flipped ? 8 - c : c;
      drawPiece(xOf(dispC), yOf(dispR), p);
    }
  }

  // Suggestion rank badges — drawn ABOVE pieces so the number is always visible
  if (suggestions && suggestions.length > 0) {
    suggestions.forEach((s, i) => {
      const color = SUGGESTION_COLORS[i] || "#666";
      drawRankBadge(s.to[0], s.to[1], i + 1, color);
    });
  }

  // ── Game-over overlay on the board itself ──────────────────────
  // Tint the whole board red (loss) / gold (win) / grey (draw), highlight
  // the losing king, and stamp the reason text. Without this the only
  // feedback is a status line — easy to miss on a glance.
  if (gameOverInfo) {
    const isLoss = !gameOverInfo.isDraw && !gameOverInfo.playerWon;
    const isWin  = !gameOverInfo.isDraw &&  gameOverInfo.playerWon;
    const tint = gameOverInfo.isDraw ? "rgba(120,120,120,0.18)"
              : isWin                  ? "rgba(251,191,36,0.16)"
              :                          "rgba(220,38,38,0.22)";
    ctx.fillStyle = tint;
    ctx.fillRect(0, 0, W, H);

    // Highlight losing king (the side that just got mated/stalemated).
    // Loser = the side that was to move and couldn't escape.
    const loserSide = gameOverInfo.reason === "resign" || gameOverInfo.reason === "flee"
      ? (playerSide === "red" ? "red" : "black")  // player lost (in play-ai)
      : null;
    if (loserSide || gameOverInfo.reason === "checkmate" || gameOverInfo.reason === "stalemate") {
      // For checkmate/stalemate, the losing side is the one to move now (`side`).
      const loserKingChar = side === "w" ? "K" : "k";
      for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
        if (board[r][c] === loserKingChar) {
          const dr = flipped ? 9 - r : r;
          const dc = flipped ? 8 - c : c;
          ctx.strokeStyle = gameOverInfo.isDraw ? "#9ca3af" : (isWin ? "#fbbf24" : "#dc2626");
          ctx.lineWidth = 5;
          ctx.setLineDash([]);
          ctx.strokeRect(xOf(dc) - 30, yOf(dr) - 30, 60, 60);
          // Pulsing inner glow
          ctx.strokeStyle = gameOverInfo.isDraw ? "rgba(156,163,175,0.5)" : (isWin ? "rgba(251,191,36,0.5)" : "rgba(220,38,38,0.6)");
          ctx.lineWidth = 10;
          ctx.strokeRect(xOf(dc) - 33, yOf(dr) - 33, 66, 66);
        }
      }
    }

    // Big stamp text in the center of the board
    const stampText = gameOverInfo.isDraw ? "和"
                    : isWin             ? "胜"
                    :                     "负";
    const stampColor = gameOverInfo.isDraw ? "#9ca3af"
                    : isWin             ? "#fbbf24"
                    :                     "#ef4444";
    ctx.save();
    ctx.globalAlpha = 0.85;
    ctx.fillStyle = stampColor;
    ctx.font = "bold 160px 'STKaiti','KaiTi',serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(stampText, W / 2, H / 2);
    // Subtitle below stamp
    ctx.globalAlpha = 0.95;
    ctx.fillStyle = "#fff";
    ctx.font = "bold 22px sans-serif";
    const subtitle = gameOverInfo.reason === "checkmate" ? "绝杀"
                   : gameOverInfo.reason === "stalemate" ? "困毙"
                   : gameOverInfo.reason === "resign"    ? "认输"
                   : gameOverInfo.reason === "flee"      ? "逃跑"
                   : gameOverInfo.reason === "draw-accepted" ? "和棋"
                   : "";
    if (subtitle) ctx.fillText(subtitle, W / 2, H / 2 + 100);
    ctx.restore();
  }
}

function drawPiece(x, y, p) {
  const isRedPiece = isRed(p);
  ctx.beginPath();
  ctx.arc(x, y, 26, 0, Math.PI * 2);
  ctx.fillStyle = "#f5e6c8";
  ctx.fill();
  ctx.strokeStyle = isRedPiece ? "#c0392b" : "#1a1a1a";
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y, 21, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = isRedPiece ? "#c0392b" : "#1a1a1a";
  ctx.font = "bold 26px 'KaiTi', 'STKaiti', serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(PIECE_NAMES[p], x, y);
}

// ── Suggestion arrows (drawn under pieces; badges drawn over) ──────
function cellCenter(r, c) {
  const dr = flipped ? 9 - r : r;
  const dc = flipped ? 8 - c : c;
  return [PADDING + dc * CELL, PADDING + dr * CELL];
}

function drawArrow(from, to, color, label) {
  const [x1, y1] = cellCenter(from[0], from[1]);
  const [x2, y2] = cellCenter(to[0], to[1]);
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dx / len, ny = dy / len;
  const startTrim = 28, endTrim = 30;
  const sx = x1 + nx * startTrim, sy = y1 + ny * startTrim;
  const ex = x2 - nx * endTrim, ey = y2 - ny * endTrim;

  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  // Body
  ctx.beginPath();
  ctx.moveTo(sx, sy);
  ctx.lineTo(ex, ey);
  ctx.stroke();
  // Arrowhead
  const headLen = 14;
  const angle = Math.atan2(dy, dx);
  ctx.beginPath();
  ctx.moveTo(ex + nx * 4, ey + ny * 4);
  ctx.lineTo(ex - headLen * Math.cos(angle - Math.PI / 6),
             ey - headLen * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(ex - headLen * Math.cos(angle + Math.PI / 6),
             ey - headLen * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();

  // Distance/target label in the middle of the arrow shaft.
  // For straight pieces (车炮兵帅) advancing/retreating, this is the distance
  // (e.g. 车三进四 → "4"). For diagonal pieces (马相士) and all 平 moves, it's
  // the destination column number (which is what the Chinese notation shows).
  if (label) {
    const lx = (sx + ex) / 2;
    const ly = (sy + ey) / 2;
    // Background pill — dark so the colored text pops
    ctx.fillStyle = "#1a1a1a";
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(lx, ly, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Label text
    ctx.fillStyle = color;
    ctx.font = "bold 14px -apple-system, 'PingFang SC', sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, lx, ly);
  }
}

// Extract the trailing number from a move's Chinese notation — used to label
// the suggestion arrows on the board.
function moveArrowLabel(from, to) {
  if (!from || !to) return "";
  const piece = board[from[0]][from[1]];
  if (!piece) return "";
  const red = isRed(piece);
  const type = piece.toLowerCase();
  if (from[0] === to[0]) {
    // 平 (horizontal): destination column
    const colNum = red ? (9 - to[1]) : (to[1] + 1);
    return red ? CN_NUMS[colNum - 1] : String(colNum);
  }
  if (type === "n" || type === "b" || type === "a") {
    // 马相士: destination column
    const colNum = red ? (9 - to[1]) : (to[1] + 1);
    return red ? CN_NUMS[colNum - 1] : String(colNum);
  }
  // 直行 (车炮兵帅): distance traveled
  const dist = Math.abs(to[0] - from[0]);
  return red ? CN_NUMS[dist - 1] : String(dist);
}

function drawRankBadge(r, c, rank, color) {
  const [x, y] = cellCenter(r, c);
  const bx = x + 22, by = y - 22;
  ctx.fillStyle = color;
  ctx.strokeStyle = "#1a1a1a";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(bx, by, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = "#1a1a1a";
  ctx.font = "bold 15px -apple-system, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(rank), bx, by);
}

// ── Interaction ────────────────────────────────────────────────────
canvas.addEventListener("click", (e) => {
  if (gameOverInfo) return;  // Board is locked once the game is over
  if (aiThinking || !isMyTurn()) return;

  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const x = (e.clientX - rect.left) * scale;
  const y = (e.clientY - rect.top) * scale;

  let c = Math.round((x - PADDING) / CELL);
  let r = Math.round((y - PADDING) / CELL);
  if (flipped) { r = 9 - r; c = 8 - c; }
  if (!inBoard(r, c)) return;

  const piece = board[r][c];
  const isMyPiece = (side === "w") ? isRed(piece) : isBlack(piece);

  if (selected) {
    // Try to move
    const valid = legalMoves.some(([tr, tc]) => tr === r && tc === c);
    if (valid) {
      doMove(selected, [r, c]);
      selected = null;
      legalMoves = [];
      draw();
      return;
    }
    // reselect
    if (isMyPiece) {
      selected = [r, c];
      legalMoves = genMoves(r, c);
      playSelectSound();
    } else {
      selected = null;
      legalMoves = [];
    }
  } else if (isMyPiece) {
    selected = [r, c];
    legalMoves = genMoves(r, c);
    playSelectSound();
  }
  draw();
});

function sideChar(s) { return s === "red" ? "w" : "b"; }

// Returns true if the current user is allowed to click & move on this turn.
function isMyTurn() {
  if (mode === "analyze") return true;
  if (mode === "play-ai") return side === sideChar(playerSide);
  if (mode === "play-p2p") {
    if (!p2pRoom) return false;
    return side === sideChar(p2pRoom.mySide);
  }
  return false;
}

// In play-ai the player picks a side; in p2p it's set when the game starts.
function myPlaySide() {
  if (mode === "play-p2p") return p2pRoom ? p2pRoom.mySide : null;
  return playerSide;
}

function doMove(from, to, opts) {
  // opts (optional): { skipP2PSend: true } — used when applying a move that
  // arrived from the server (so we don't echo it back).
  const skipP2PSend = opts && opts.skipP2PSend;
  // If the user is in deep analysis mode, a real move invalidates the snapshot
  // — exit deep mode so the new move applies to the actual board state.
  if (deepAnalysisState) exitDeepAnalysis();
  const piece = board[from[0]][from[1]];
  const captured = board[to[0]][to[1]] !== null;
  board[to[0]][to[1]] = piece;
  board[from[0]][from[1]] = null;
  const uci = moveToUci(from, to);
  moveHistory.push({ uci, from, to, piece });
  selected = null;
  legalMoves = [];
  suggestions = [];  // clear arrows once a move is made
  lastMove = { from: [...from], to: [...to] };
  side = side === "w" ? "b" : "w";
  positionHistory.add(currentPositionHash());
  renderMoveList();
  updateStatus();
  playMoveSound(captured);

  // Distinct callouts for captures and checks. We check `isCheck(side)`
  // AFTER the side switch, so it reports whether the new mover is under
  // attack — i.e. this move just delivered check.
  const st = gameOverState();
  const deliversCheck = !st.over && isCheck(side);
  if (captured) {
    setTimeout(() => playCaptureSound(), 60);
    setTimeout(() => speak("吃"), 110);
  }
  if (deliversCheck) {
    setTimeout(() => playCheckSound(), captured ? 240 : 80);
    setTimeout(() => speak("将军"), captured ? 300 : 140);
  }
  // Force canvas redraw now AND on the next animation frame — the second
  // call is insurance against environments where the synchronous paint
  // gets dropped (e.g. when called from inside a Promise continuation).
  draw();
  requestAnimationFrame(() => draw());

  // Refresh the eval bar after every ply so users see live advantage swings.
  setTimeout(() => refreshEvalBar(), 200);

  // ── Post-move flow differs by mode ─────────────────────────────
  if (mode === "play-p2p") {
    // Send our move to the opponent via WebSocket. The remote side will be
    // applied when we receive the echoed game.move broadcast (single source
    // of truth: server). Do NOT auto-trigger AI or suggestions here.
    if (!skipP2PSend && p2pRoom && !gameOverInfo) {
      p2pSend({ type: "game.move", roomId: p2pRoom.roomId, uci });
    }
    const st = gameOverState();
    if (st.over) finishGame(st.winner, st.reason);
    return;
  }

  if (mode === "play-ai") {
    const st = gameOverState();
    if (st.over) {
      finishGame(st.winner, st.reason);
      return;
    }
    if (side !== sideChar(playerSide)) {
      console.log(`[doMove] scheduling AI move, side=${side}`);
      setTimeout(() => aiMove(), 300);
    } else {
      console.log(`[doMove] player's turn, fetching suggestions`);
      setTimeout(() => fetchSuggestions(), 250);
    }
  }
}

async function aiMove() {
  if (aiThinking) return;
  aiThinking = true;
  const d = aiDepth();
  setStatus(`AI 思考中... (深度 ${d})`, "thinking");
  console.log(`[aiMove] start, depth=${d}`);
  try {
    const moves = moveHistory.map(m => m.uci);
    // Request MultiPV so we can simulate human-like blunders at low depths.
    // At depth ≥ 12 the AI plays "seriously" (multipv 1, pure bestmove).
    // At depth < 12 we ask for 3 candidate lines and pick probabilistically:
    // lower depth → higher chance of picking the 2nd/3rd best (a real mistake).
    const multipv = d < 12 ? 3 : 1;
    const res = await fetch("/pikafish/api/bestmove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: d, multipv }),
    });
    const data = await res.json();
    console.log(`[aiMove] received bestmove=${data.bestmove}, lines=${(data.lines||[]).length}`);

    // Pick the move: at low depth, simulate a human mistake by sometimes
    // choosing the 2nd/3rd best move from MultiPV. Probabilities tuned so
    // depth 6 ≈ "club player" (often blunders), depth 10 ≈ "strong amateur".
    let chosenUci = data.bestmove;
    if (multipv > 1 && Array.isArray(data.lines) && data.lines.length > 1) {
      const lines = data.lines.filter(Boolean);
      if (lines.length >= 2) {
        // Blunder probability: 35% at d=6 → 5% at d=11
        const blunderP = Math.max(0, 0.40 - (d - 6) * 0.07);
        const r = Math.random();
        if (r < blunderP && lines[1] && lines[1].pv && lines[1].pv[0]) {
          // Pick the 2nd-best move — a measurable mistake
          chosenUci = lines[1].pv[0];
          console.log(`[aiMove] simulating blunder: ${data.bestmove} → ${chosenUci} (p=${blunderP.toFixed(2)})`);
        } else if (r < blunderP * 0.5 && lines[2] && lines[2].pv && lines[2].pv[0]) {
          // Occasionally pick 3rd-best (a real howler)
          chosenUci = lines[2].pv[0];
          console.log(`[aiMove] simulating big blunder → ${chosenUci}`);
        }
      }
    }

    const mv = chosenUci && chosenUci !== "null" && chosenUci !== "(none)"
      ? uciToMove(chosenUci) : null;
    if (mv && inBoard(mv.from[0], mv.from[1]) && inBoard(mv.to[0], mv.to[1])
        && board[mv.from[0]][mv.from[1]]) {
      // Warn (but still play) if the move recreates a past position — Xiangqi
      // bans perpetual check/chase, but Pikafish with history should rarely
      // pick such a move. Surfacing the warning lets the user notice.
      if (moveCreatesRepetition(mv.from, mv.to)) {
        console.warn(`[aiMove] AI move ${data.bestmove} would repeat — playing anyway`);
      }
      console.log(`[aiMove] applying move from=${mv.from} to=${mv.to}`);
      doMove(mv.from, mv.to, true);
      console.log(`[aiMove] doMove returned, board updated`);
    } else {
      // Engine returned (none)/null → it's checkmate or stalemate against the AI.
      // Compute which side just got mated.
      console.warn(`[aiMove] no legal move returned (${data.bestmove})`);
      const st = gameOverState();
      if (st.over) {
        finishGame(st.winner, st.reason);
      } else {
        setStatus("AI 未能给出有效走法");
      }
    }
  } catch (err) {
    setStatus(`AI 出错: ${err.message}`);
    console.error("[aiMove]", err);
  } finally {
    aiThinking = false;
    console.log(`[aiMove] done, aiThinking=false`);
  }
}

async function hintMove() {
  if (aiThinking) return;
  aiThinking = true;
  setStatus("提示中...", "thinking");
  try {
    const moves = moveHistory.map(m => m.uci);
    // Hint uses deeper search than the opponent so following it actually pays off.
    const hintDepth = Math.min(Math.max(aiDepth() + 6, 14), 22);
    const res = await fetch("/pikafish/api/bestmove", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: hintDepth }),
    });
    const data = await res.json();
    if (data.bestmove) {
      const mv = uciToMove(data.bestmove);
      // Show hint as highlighted move
      selected = mv.from;
      legalMoves = [mv.to];
      draw();
      setStatus(`建议走法: ${uciToChinese(data.bestmove)} (${data.bestmove.toUpperCase()})`, "");
    }
  } catch (err) {
    setStatus(`出错: ${err.message}`);
  } finally {
    aiThinking = false;
  }
}

function moveToChinese(uci) {
  // Simple: just show source-target squares in friendly notation
  return uci.toUpperCase();
}

// ── Chinese xiangqi notation ───────────────────────────────────────
// Red: columns counted right-to-left as 一二三四五六七八九
// Black: columns counted left-to-right as 1-9 (Arabic)
// Actions: 平 (horizontal) / 进 (forward) / 退 (backward)
// Straight pieces (车炮兵帅) → number = distance
// Diagonal pieces (马相士) → number = destination column
const CN_NUMS = ["一", "二", "三", "四", "五", "六", "七", "八", "九"];

function toChineseNotation(from, to) {
  const piece = board[from[0]][from[1]];
  return notationFromPiece(piece, from, to);
}

function notationFromPiece(piece, from, to) {
  if (!piece) return "?";
  const name = PIECE_NAMES[piece];
  const red = isRed(piece);
  const type = piece.toLowerCase();

  const fromColNum = red ? (9 - from[1]) : (from[1] + 1);
  const toColNum = red ? (9 - to[1]) : (to[1] + 1);
  const fromColStr = red ? CN_NUMS[fromColNum - 1] : String(fromColNum);
  const toColStr = red ? CN_NUMS[toColNum - 1] : String(toColNum);

  let action, target;
  if (from[0] === to[0]) {
    action = "平";
    target = toColStr;
  } else {
    const forward = red ? (to[0] < from[0]) : (to[0] > from[0]);
    action = forward ? "进" : "退";
    if (type === "n" || type === "b" || type === "a") {
      target = toColStr;
    } else {
      const dist = Math.abs(to[0] - from[0]);
      target = red ? CN_NUMS[dist - 1] : String(dist);
    }
  }
  return `${name}${fromColStr}${action}${target}`;
}

function uciToChinese(uci) {
  if (!uci || uci.length < 4) return uci || "?";
  const mv = uciToMove(uci);
  return toChineseNotation(mv.from, mv.to);
}

// ── Move purpose analysis ──────────────────────────────────────────
// Simulates the move, then describes what it accomplishes:
//   吃X   — captures an enemy piece
//   将军  — gives check
//   捉X   — attacks an enemy piece (next-move capture threat)
//   护X   — defends a friendly piece that was previously attacked
//   出X   — develops a back-rank piece to an active square
//   进X/退X/平X — generic description for the rest
function describeMovePurpose(from, to) {
  if (!inBoard(from[0], from[1]) || !inBoard(to[0], to[1])) return "";
  const piece = board[from[0]][from[1]];
  if (!piece) return "";
  const red = isRed(piece);
  const enemyOf = (p) => p ? (red ? isBlack(p) : isRed(p)) : false;
  const friendOf = (p) => p ? (red ? isRed(p) : isBlack(p)) : false;
  const target = board[to[0]][to[1]];

  // Apply move temporarily
  board[from[0]][from[1]] = null;
  board[to[0]][to[1]] = piece;

  let purpose = "";
  // 1. Capture
  if (target && enemyOf(target)) {
    purpose = `吃${PIECE_NAMES[target]}`;
  }
  // 2. Check — can the moved piece (or any friend) capture the enemy king?
  if (!purpose) {
    const enemyKing = red ? "k" : "K";
    let kingPos = null;
    outer: for (let r = 0; r < 10; r++) {
      for (let c = 0; c < 9; c++) {
        if (board[r][c] === enemyKing) { kingPos = [r, c]; break outer; }
      }
    }
    if (kingPos) {
      // Can the moved piece hit the king?
      const moves = genMoves(to[0], to[1]);
      if (moves.some(([r, c]) => r === kingPos[0] && c === kingPos[1])) {
        purpose = "将军";
      }
    }
  }
  // 3. Threaten — moved piece attacks an enemy piece (not the king)
  if (!purpose) {
    const moves = genMoves(to[0], to[1]);
    const threats = [];
    for (const [r, c] of moves) {
      const t = board[r][c];
      if (t && enemyOf(t) && (t.toLowerCase() !== "k")) threats.push(t);
    }
    if (threats.length) purpose = `捉${PIECE_NAMES[threats[0]]}`;
  }
  // 4. Develop — back-rank piece moving into the battlefield
  if (!purpose) {
    const type = piece.toLowerCase();
    const backRank = red ? 9 : 0;
    const crossedMidline = red ? (to[0] <= 4) : (to[0] >= 5);
    if (from[0] === backRank && crossedMidline && ["r", "n", "c"].includes(type)) {
      purpose = `出${PIECE_NAMES[piece]}`;
    }
  }
  // 5. Generic action word
  if (!purpose) {
    const type = piece.toLowerCase();
    if (from[0] === to[0]) purpose = `${PIECE_NAMES[piece]}平`;
    else {
      const forward = red ? (to[0] < from[0]) : (to[0] > from[0]);
      if (type === "p") purpose = forward ? "挺兵" : "退兵";
      else if (type === "r") purpose = forward ? `${PIECE_NAMES[piece]}进` : `${PIECE_NAMES[piece]}退`;
      else if (type === "c") purpose = forward ? `${PIECE_NAMES[piece]}进` : `${PIECE_NAMES[piece]}退`;
      else purpose = forward ? `${PIECE_NAMES[piece]}进` : `${PIECE_NAMES[piece]}退`;
    }
  }

  // Restore board
  board[from[0]][from[1]] = piece;
  board[to[0]][to[1]] = target;
  return purpose;
}

async function analyzePosition() {
  if (aiThinking) return;
  aiThinking = true;
  document.getElementById("analysisBox").style.display = "block";
  document.getElementById("pvList").innerHTML = "<div class='pv-line'>分析中...</div>";
  try {
    const moves = moveHistory.map(m => m.uci);
    const res = await fetch("/pikafish/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: Math.min(aiDepth(), 20), multipv: 3 }),
    });
    const data = await res.json();
    const lines = data.lines || [];
    const picked = lines.map((line) => {
      const uci = line.pv && line.pv[0];
      if (!uci || uci.length < 4) return null;
      const mv = uciToMove(uci);
      return { from: mv.from, to: mv.to, repetition: moveCreatesRepetition(mv.from, mv.to) };
    });
    renderSuggestions(lines, picked);
    updateEvalFromLines(lines);
  } catch (err) {
    document.getElementById("pvList").innerHTML = `<div class='pv-line'>出错: ${err.message}</div>`;
  } finally {
    aiThinking = false;
  }
}

// Lightweight suggestion fetcher used on player's turn (does not flip aiThinking).
async function fetchSuggestions() {
  if (isGameOver()) return;
  document.getElementById("analysisBox").style.display = "block";
  document.getElementById("pvList").innerHTML = "<div class='pv-line'>推演中...</div>";
  try {
    const moves = moveHistory.map(m => m.uci);
    // Hint depth is intentionally HIGHER than the opponent's depth so that
    // a player who follows hints has genuine information advantage.
    // Otherwise (equal depths) the side moving first wins by tempo.
    const hintDepth = Math.min(Math.max(aiDepth() + 6, 14), 22);
    const res = await fetch("/pikafish/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: hintDepth, multipv: 5 }),
    });
    const data = await res.json();
    const lines = data.lines || [];
    // Tag each candidate with repetition flag and skip pure repeats when
    // filling the on-board arrows (keep top 3 non-repeating if possible).
    const annotated = lines.map((line) => {
      const uci = line.pv && line.pv[0];
      if (!uci || uci.length < 4) return null;
      const mv = uciToMove(uci);
      const repetition = moveCreatesRepetition(mv.from, mv.to);
      return { from: mv.from, to: mv.to, repetition, line };
    }).filter(Boolean);

    // Prefer non-repeating suggestions for the on-board arrows.
    const nonRep = annotated.filter(s => !s.repetition);
    const picked = (nonRep.length >= 3 ? nonRep : annotated).slice(0, 3);
    suggestions = picked;
    renderSuggestions(picked.map(p => p.line), picked);
    draw();
  } catch (err) {
    document.getElementById("pvList").innerHTML = `<div class='pv-line'>推演出错: ${err.message}</div>`;
  }
}

function renderSuggestions(lines, picked) {
  // picked: optional array of {from, to, repetition} parallel to lines (used to flag repeats + compute purpose)
  if (!lines || !lines.length) {
    document.getElementById("pvList").innerHTML = "<div class='pv-line'>无推演结果</div>";
    return;
  }
  // Save for deep analysis mode
  currentSuggestions = lines;
  const html = lines.map((line, i) => {
    const uci = line.pv && line.pv[0];
    const chinese = uciToChinese(uci);
    const uciUpper = (uci || "").toUpperCase();
    const evalStr = line.mate !== null && line.mate !== undefined
      ? (line.mate > 0 ? `胜 #${line.mate}` : `负 #${-line.mate}`)
      : (line.score ? `${line.score.value >= 0 ? "+" : ""}${(line.score.value/100).toFixed(2)}` : "?");
    const rankLabel = i === 0 ? "★ 最优" : `备选 ${i + 1}`;
    const isRepeat = picked && picked[i] && picked[i].repetition;
    const purpose = picked && picked[i] ? describeMovePurpose(picked[i].from, picked[i].to) : "";
    const purposeHtml = purpose ? `<span class="purpose">${purpose}</span>` : "";
    const repFlag = isRepeat ? `<span class="rep-flag">重复!</span>` : "";
    const cls = isRepeat ? "pv-line repeat" : "pv-line";
    const pvLen = line.pv ? line.pv.length : 0;
    const deepHint = pvLen > 1 ? `<span class="deep-hint">▸ 展开推演 ${pvLen} 步</span>` : "";
    return `<div class="${cls}" onclick="enterDeepAnalysis(${i})" style="cursor:pointer"><span class="rank">${rankLabel}</span><span class="eval">${evalStr}</span><span class="move-cn">${chinese}</span>${purposeHtml} <span class="move-uci">${uciUpper}</span> ${deepHint} ${repFlag}</div>`;
  }).join("");
  document.getElementById("pvList").innerHTML = html;
}

// ── Deep analysis mode ────────────────────────────────────────────
// User clicks a suggestion → enter deep mode: show full PV sequence,
// apply moves to the board so user can see how the line unfolds.
// They can step through individual moves, request deeper analysis, or exit.
function enterDeepAnalysis(lineIdx) {
  if (!currentSuggestions || !currentSuggestions[lineIdx]) return;
  const line = currentSuggestions[lineIdx];
  if (!line.pv || line.pv.length < 2) {
    setStatus("该走法暂无深度推演数据");
    return;
  }

  // Snapshot current state so we can restore on exit
  const snapshot = {
    board: board.map(row => row.slice()),
    side: side,
    moveHistoryLen: moveHistory.length,
    lastMove: lastMove ? { from: [...lastMove.from], to: [...lastMove.to] } : null,
    positionHistory: new Set(positionHistory),
    startMoveHistoryUci: moveHistory.map(m => m.uci),
  };

  // Build the move sequence: side alternates starting from current `side`
  const moves = line.pv.map((uci, i) => {
    const mv = uciToMove(uci);
    if (!mv) return null;
    const moveSide = i % 2 === 0 ? side : (side === "w" ? "b" : "w");
    return {
      uci,
      from: mv.from,
      to: mv.to,
      side: moveSide,
      chinese: uciToChinese(uci),
    };
  }).filter(Boolean);

  deepAnalysisState = {
    snapshot,
    moves,
    currentStep: moves.length,  // show end-of-line by default
    baseLine: line,
    startSide: side,
  };

  // Switch UI: hide list, show deep analysis panel
  document.getElementById("analysisBox").style.display = "none";
  document.getElementById("analysisDeep").style.display = "block";

  renderDeepMoves();
  showDeepStep(moves.length);
}

function showDeepStep(step) {
  if (!deepAnalysisState) return;
  const s = deepAnalysisState;
  // Restore from snapshot
  board = s.snapshot.board.map(row => row.slice());
  side = s.snapshot.side;

  // Apply first `step` moves
  const max = Math.min(step, s.moves.length);
  let lastFrom = null, lastTo = null;
  for (let i = 0; i < max; i++) {
    const m = s.moves[i];
    board[m.to[0]][m.to[1]] = board[m.from[0]][m.from[1]];
    board[m.from[0]][m.from[1]] = null;
    lastFrom = m.from; lastTo = m.to;
  }
  lastMove = (lastFrom && lastTo) ? { from: lastFrom, to: lastTo } : s.snapshot.lastMove;

  s.currentStep = max;
  const stepEl = document.getElementById("deepStep");
  if (stepEl) stepEl.textContent = max;
  draw();

  // Highlight the active row
  document.querySelectorAll(".deep-move").forEach((el, i) => {
    el.classList.toggle("active", (i + 1) === max);
  });
}

function renderDeepMoves() {
  if (!deepAnalysisState) return;
  const s = deepAnalysisState;
  const el = document.getElementById("deepMoves");
  const info = document.getElementById("deepInfo");

  const evalStr = s.baseLine.mate !== null && s.baseLine.mate !== undefined
    ? (s.baseLine.mate > 0 ? `胜 #${s.baseLine.mate}` : `负 #${-s.baseLine.mate}`)
    : (s.baseLine.score ? `${s.baseLine.score.value >= 0 ? "+" : ""}${(s.baseLine.score.value/100).toFixed(2)}` : "?");
  info.innerHTML = `起始评估: <span class="eval">${evalStr}</span> · 已推演 <span class="eval">${s.moves.length}</span> 步`;

  const html = s.moves.map((m, i) => {
    const isActive = (i + 1) === s.currentStep;
    const sideClass = m.side === "w" ? "red-tag" : "black-tag";
    const sideLabel = m.side === "w" ? "红" : "黑";
    return `<div class="deep-move ${isActive ? 'active' : ''}" onclick="showDeepStep(${i+1})">
      <span class="num">${i+1}.</span>
      <span class="side-tag ${sideClass}">${sideLabel}</span>
      <span class="mv-cn">${m.chinese}</span>
      <span class="mv-uci">${m.uci.toUpperCase()}</span>
    </div>`;
  }).join("");
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
}

function exitDeepAnalysis() {
  if (!deepAnalysisState) return;
  // Restore everything
  board = deepAnalysisState.snapshot.board.map(row => row.slice());
  side = deepAnalysisState.snapshot.side;
  lastMove = deepAnalysisState.snapshot.lastMove;
  positionHistory = deepAnalysisState.snapshot.positionHistory;

  document.getElementById("analysisDeep").style.display = "none";
  document.getElementById("analysisBox").style.display = "block";
  deepAnalysisState = null;
  draw();
}

async function continueAnalysis() {
  if (!deepAnalysisState) return;
  const s = deepAnalysisState;
  setStatus("继续推演中...", "thinking");
  try {
    // Send original history + all PV moves played so far
    const allMoves = [...s.snapshot.startMoveHistoryUci, ...s.moves.map(m => m.uci)];
    const res = await fetch("/pikafish/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves: allMoves, depth: 22, multipv: 2 }),
    });
    const data = await res.json();
    const lines = data.lines || [];
    if (!lines[0] || !lines[0].pv || lines[0].pv.length < 1) {
      setStatus("无法继续推演（可能已分胜负）");
      return;
    }
    // Append the new PV moves to the existing sequence. Continue side alternation.
    const startSide = s.startSide;
    const baseLen = s.moves.length;
    const newMoves = lines[0].pv.map((uci, i) => {
      const mv = uciToMove(uci);
      if (!mv) return null;
      const moveSide = ((baseLen + i) % 2 === 0) ? startSide : (startSide === "w" ? "b" : "w");
      return { uci, from: mv.from, to: mv.to, side: moveSide, chinese: uciToChinese(uci) };
    }).filter(Boolean);
    s.moves.push(...newMoves);
    renderDeepMoves();
    showDeepStep(s.moves.length);
    setStatus(`推演已扩展到 ${s.moves.length} 步`);
  } catch (err) {
    setStatus(`推演出错: ${err.message}`);
  }
}

function toggleMoveHistory() {
  const bar = document.getElementById("moveHistoryBar");
  const list = document.getElementById("moveList");
  if (!bar || !list) return;
  const expanded = bar.classList.toggle("expanded");
  list.style.display = expanded ? "block" : "none";
}

// ── Evaluation bar ─────────────────────────────────────────────────
// Pikafish reports scores from the perspective of the side to move.
// Convert to a Red-POV number (positive = red ahead) for display.
function redPovScore(line, sideToMove) {
  if (!line) return 0;
  if (line.mate !== null && line.mate !== undefined) {
    const winnerAhead = line.mate > 0;
    const redAhead = (sideToMove === "w") === winnerAhead;
    return redAhead ? 100000 : -100000;
  }
  if (!line.score) return 0;
  const v = line.score.value;
  return sideToMove === "w" ? v : -v;
}

function renderEvalBar(redPov) {
  const scoreEl = document.getElementById("evalScore");
  const fillEl = document.getElementById("evalFill");
  if (!scoreEl || !fillEl) return;
  if (Math.abs(redPov) > 10000) {
    const winner = redPov > 0 ? "红方" : "黑方";
    scoreEl.innerHTML = `<span class="eval-mate">${winner} 胜势</span>`;
  } else if (Math.abs(redPov) < 8) {
    scoreEl.innerHTML = `<span class="eval-even">均势</span>`;
  } else if (redPov > 0) {
    scoreEl.innerHTML = `<span class="eval-red">红方 +${(redPov/100).toFixed(2)}</span>`;
  } else {
    scoreEl.innerHTML = `<span class="eval-black">黑方 +${(-redPov/100).toFixed(2)}</span>`;
  }
  // Bar fill: 50% at 0, ±50% scaled so ±8 pawns (±800cp) is a full sweep
  const pct = Math.max(2, Math.min(98, 50 + redPov / 16));
  fillEl.style.width = pct + "%";
}

function updateEvalFromLines(lines) {
  if (!lines || !lines.length) {
    renderEvalBar(0);
    return;
  }
  renderEvalBar(redPovScore(lines[0], side));
}

async function refreshEvalBar() {
  if (isGameOver()) return;
  try {
    const moves = moveHistory.map(m => m.uci);
    // Server-side `accumulate` only kicks in when multipv > 1, so request at
    // least 2 lines (we still only read lines[0] for the eval value).
    const res = await fetch("/pikafish/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: 14, multipv: 2 }),
    });
    const data = await res.json();
    updateEvalFromLines(data.lines || []);
  } catch (err) {
    console.warn("[eval]", err);
  }
}

function undo() {
  if (aiThinking || moveHistory.length === 0) return;
  if (mode === "play-p2p") return;  // No take-backs in live multiplayer
  // Undo AI move + player move (if in play-ai mode)
  const steps = (mode === "play-ai" && moveHistory.length >= 2) ? 2 : 1;
  for (let i = 0; i < steps; i++) {
    const last = moveHistory.pop();
    if (!last) break;
    board[last.from[0]][last.from[1]] = last.piece;
    board[last.to[0]][last.to[1]] = null;
    side = side === "w" ? "b" : "w";
    positionHistory.delete(currentPositionHash());
  }
  selected = null;
  legalMoves = [];
  suggestions = [];
  // Restore last move highlight to the now-last move (if any)
  const last = moveHistory[moveHistory.length - 1];
  lastMove = last ? { from: [...last.from], to: [...last.to] } : null;
  renderMoveList();
  updateStatus();
  draw();
  setTimeout(() => refreshEvalBar(), 200);
  if (mode === "play-ai" && !isGameOver() && side === sideChar(playerSide)) {
    setTimeout(() => fetchSuggestions(), 200);
  }
}

function resetGame() {
  parseFen(START_FEN);
  moveHistory = [];
  selected = null;
  legalMoves = [];
  lastMove = null;
  suggestions = [];
  positionHistory = new Set([currentPositionHash()]);
  gameOverInfo = null;
  pendingDrawOffer = false;
  // Clear any leftover shake animation
  const wrap = canvas.parentElement;
  if (wrap) wrap.classList.remove("game-over-shake");
  currentSuggestions = null;
  deepAnalysisState = null;
  gameStartTime = Date.now();
  hideResultOverlay();
  document.getElementById("analysisDeep").style.display = "none";
  renderMoveList();
  updateStatus();
  draw();
  renderEvalBar(0); // initial position is balanced — show 均势 immediately
  updateRankDisplay();
  document.getElementById("analysisBox").style.display = "none";
  if (mode === "play-ai") {
    if (playerSide === "black") {
      setTimeout(() => aiMove(), 300);
    } else if (side === sideChar(playerSide)) {
      setTimeout(() => fetchSuggestions(), 400);
    }
  }
}

function setSide(s) {
  playerSide = s;
  document.getElementById("sideRed").classList.toggle("primary", s === "red");
  document.getElementById("sideBlack").classList.toggle("primary", s === "black");
  resetGame();
}

function setMode(m) {
  if (m === "play-p2p" && !currentUser) {
    setStatus("请先登录后再使用棋友对局", "thinking");
    setTimeout(() => window.open("/login", "_blank"), 800);
    return;
  }
  // Cleanup previous mode
  if (mode === "play-p2p" && m !== "play-p2p") {
    // Leaving P2P — disconnect socket, leave lobby, abandon any active game
    if (myLobbyEntry) lobbyLeave();
    if (p2pRoom) {
      p2pSend({ type: "game.flee", roomId: p2pRoom.roomId });
      p2pRoom = null;
    }
    if (p2pSocket) {
      try { p2pSocket.close(); } catch {}
      p2pSocket = null;
    }
    document.getElementById("lobbyBox").style.display = "none";
  }

  mode = m;
  document.querySelectorAll(".mode-tabs button").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === m);
  });

  // Show/hide mode-specific UI
  document.getElementById("playControls").style.display = m === "play-ai" ? "block" : "none";
  document.getElementById("lobbyBox").style.display = m === "play-p2p" ? "block" : "none";

  // Action buttons (提和/认输/逃跑) only relevant in actual games
  const actionRow = document.querySelector(".action-row");
  if (actionRow) actionRow.style.display = m === "analyze" ? "none" : "flex";

  const title = document.getElementById("analysisTitle");
  if (title) title.textContent = m === "analyze" ? "AI 分析 · 多分支" : "AI 推演 · 最优走法";

  if (m === "analyze") {
    analyzePosition();
  } else if (m === "play-p2p") {
    // Reset board and wait for opponent
    resetGame();
    document.getElementById("analysisBox").style.display = "none";
    ensureP2PSocket();
    setStatus("进入棋友大厅，请发起或接受挑战");
  } else {
    // play-ai
    document.getElementById("analysisBox").style.display = "none";
    resetGame();
  }
}

function flipBoard() {
  flipped = !flipped;
  document.getElementById("flipBtn").textContent = flipped ? "恢复正常" : "翻转棋盘";
  draw();
}

function toggleSound() {
  audioEnabled = !audioEnabled;
  document.getElementById("soundBtn").textContent = audioEnabled ? "声音: 开" : "声音: 关";
  if (audioEnabled) playSelectSound();
}

function isGameOver() {
  return gameOverState().over;
}

// ── Game-over judgment ─────────────────────────────────────────────
// Returns { over, winner, reason } where:
//   winner: "red" | "black" | null
//   reason: "checkmate" | "stalemate" | "king-missing" | "flying" | null
//
// Xiangqi rules:
//   - Checkmate: side to move is in check AND has no legal move → side to move loses
//   - Stalemate: side to move is NOT in check but has no legal move → side to move loses
//     (in Xiangqi, unlike chess, stalemate is a loss for the stalemated side)
//   - Flying general: if both kings face each other on an open file, the side
//     to move can win by capturing — we flag it as the active side being exposed
function gameOverState() {
  // King missing means a king was captured (illegal in normal play but
  // Pikafish may return a move that captures the king if our move-gen is buggy).
  let redK = null, blackK = null;
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    if (board[r][c] === "K") redK = [r, c];
    else if (board[r][c] === "k") blackK = [r, c];
  }
  if (!redK) return { over: true, winner: "black", reason: "king-missing" };
  if (!blackK) return { over: true, winner: "red", reason: "king-missing" };

  // Check the side to move: do they have any legal escape?
  const moverRed = (side === "w");
  const inCheck = isCheck(side);
  if (hasAnyLegalMove(side)) return { over: false, winner: null, reason: null };
  // No legal move — it's mate or stalemate, mover loses
  return {
    over: true,
    winner: moverRed ? "black" : "red",
    reason: inCheck ? "checkmate" : "stalemate",
  };
}

// Is the given side's king currently attacked by any enemy piece?
function isCheck(sideToCheck) {
  // Find king
  const kingChar = sideToCheck === "w" ? "K" : "k";
  let kr = -1, kc = -1;
  outer: for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    if (board[r][c] === kingChar) { kr = r; kc = c; break outer; }
  }
  if (kr < 0) return false;
  // Check if any enemy piece can move to (kr, kc)
  const enemyIsRed = (sideToCheck !== "w");
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = board[r][c];
    if (!p) continue;
    if (enemyIsRed ? isRed(p) : isBlack(p)) {
      const targets = genMoves(r, c);
      for (const [tr, tc] of targets) {
        if (tr === kr && tc === kc) return true;
      }
    }
  }
  // Flying-general: kings face each other directly on the same file with no piece between
  const enemyKingChar = sideToCheck === "w" ? "k" : "K";
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    if (board[r][c] === enemyKingChar && c === kc) {
      let blocked = false;
      const lo = Math.min(r, kr) + 1, hi = Math.max(r, kr);
      for (let rr = lo; rr < hi; rr++) {
        if (board[rr][c]) { blocked = true; break; }
      }
      if (!blocked) return true;
    }
  }
  return false;
}

// Does the given side have at least one legal move?
// A move is legal if, after making it, the mover's own king is not in check.
function hasAnyLegalMove(sideToMove) {
  const moverIsRed = (sideToMove === "w");
  for (let r = 0; r < 10; r++) for (let c = 0; c < 9; c++) {
    const p = board[r][c];
    if (!p) continue;
    if (moverIsRed ? !isRed(p) : !isBlack(p)) continue;
    const targets = genMoves(r, c);
    for (const [tr, tc] of targets) {
      // Simulate move
      const captured = board[tr][tc];
      board[tr][tc] = p;
      board[r][c] = null;
      const stillInCheck = isCheck(sideToMove);
      // Restore
      board[r][c] = p;
      board[tr][tc] = captured;
      if (!stillInCheck) return true;
    }
  }
  return false;
}

function setStatus(msg, cls) {
  const el = document.getElementById("status");
  el.textContent = msg;
  el.className = "status" + (cls ? " " + cls : "");
}

function updateStatus() {
  const st = gameOverState();
  if (st.over) {
    const winnerName = st.winner === "red" ? "红方" : "黑方";
    let msg;
    if (st.reason === "checkmate") msg = `${winnerName} 绝杀！`;
    else if (st.reason === "stalemate") msg = `${winnerName} 胜（对方困毙）`;
    else if (st.reason === "king-missing") msg = `${winnerName} 胜利`;
    else msg = `${winnerName} 胜利`;
    setStatus(msg);
    return;
  }
  const mover = side === "w" ? "红方" : "黑方";
  if (mode === "play-ai") {
    if (side === sideChar(playerSide)) {
      setStatus(`轮到你走棋（${mover}）`);
    } else {
      setStatus(`轮到 AI（${mover}）`);
    }
  } else if (mode === "play-p2p") {
    if (p2pRoom && side === sideChar(p2pRoom.mySide)) {
      setStatus(`轮到你走棋（${mover}） · 对手 ${p2pRoom.opponent.nickname}`);
    } else if (p2pRoom) {
      setStatus(`等待对手走棋（${mover}） · ${p2pRoom.opponent.nickname}`);
    } else {
      setStatus("棋友大厅 · 等待匹配");
    }
  } else {
    setStatus(`分析模式 · 轮到 ${mover}`);
  }
}

function renderMoveList() {
  const el = document.getElementById("moveList");
  let html = "";
  for (let i = 0; i < moveHistory.length; i += 2) {
    const num = Math.floor(i / 2) + 1;
    const red = moveHistory[i];
    const black = moveHistory[i + 1];
    const redCn = red ? notationFromPiece(red.piece, red.from, red.to) : "";
    const blackCn = black ? notationFromPiece(black.piece, black.from, black.to) : "";
    const redUci = red ? red.uci.toUpperCase() : "";
    const blackUci = black ? black.uci.toUpperCase() : "";
    html += `<div><span class="move-num">${num}.</span> <span class="red">${redCn} <span class="move-uci">${redUci}</span></span> <span class="black">${blackCn} <span class="move-uci">${blackUci}</span></span></div>`;
  }
  el.innerHTML = html;
  el.scrollTop = el.scrollHeight;
  // Sync move count to the collapsed bar
  const countEl = document.getElementById("moveCount");
  if (countEl) countEl.textContent = moveHistory.length;
}

// ── 棋力等级系统 ───────────────────────────────────────────────────
// 业余: 1-1 ~ 9-3 (index 0-26), 专业: 专1-1 ~ 专3-3 (index 27-35)
const RANKS = [];
for (let n = 1; n <= 9; n++) for (let s = 1; s <= 3; s++) RANKS.push(`${n}-${s}`);
for (let n = 1; n <= 3; n++) for (let s = 1; s <= 3; s++) RANKS.push(`专${n}-${s}`);

function rankToDepth(rankIdx) {
  if (rankIdx < 27) return 6 + Math.floor(rankIdx * 10 / 27);  // 6 → 15
  return 16 + Math.floor((rankIdx - 27) * 8 / 8);              // 16 → 24
}

function rankLabel(idx) { return RANKS[idx] || "1-1"; }

function loadPlayerRank() {
  const stored = parseInt(localStorage.getItem("pikafish-rank"), 10);
  return (stored >= 0 && stored < RANKS.length) ? stored : 4; // default 2-2
}

function savePlayerRank(idx) {
  localStorage.setItem("pikafish-rank", String(idx));
}

let playerRankIdx = loadPlayerRank();
let gameStartTime = Date.now();
let pendingDrawOffer = false;

// Override aiDepth with rank-aware version
const aiDepth = () => {
  // Read the manual override if user picks a level explicitly, otherwise
  // fall back to the rank-driven depth.
  const manual = parseInt(document.getElementById("depth").value, 10);
  if (manual > 0) return manual;
  return rankToDepth(playerRankIdx);
};

// ── 下棋历史（localStorage + 服务器永久保存） ─────────────────────
const HISTORY_KEY = "pikafish-history-v1";
const MAX_HISTORY = 50;

// Persistent anonymous player ID — generated once, stored in localStorage.
// Used to fetch only this browser's games from the server.
function getPlayerId() {
  let id = localStorage.getItem("pikafish-player-id");
  if (!id) {
    id = "p-" + Date.now() + "-" + Math.random().toString(36).slice(2, 10);
    localStorage.setItem("pikafish-player-id", id);
  }
  return id;
}
const PLAYER_ID = getPlayerId();

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); }
  catch { return []; }
}

function saveHistory(arr) {
  localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(0, MAX_HISTORY)));
}

// Save a record both to localStorage (instant UI) and the server (permanent).
function pushHistory(record) {
  // Local: synchronous, instant
  const arr = loadHistory();
  arr.unshift(record);
  saveHistory(arr);
  renderHistory();
  // Server: async, permanent storage
  saveGameToServer(record);
}

async function saveGameToServer(record) {
  try {
    await fetch("/pikafish/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        playerId: PLAYER_ID,
        result: record.result,
        side: playerSide,
        oppRank: record.oppRank,
        moves: record.moves,
        reason: record.reason,
        rankBefore: record.playerRankBefore,
        rankAfter: record.playerRankAfter,
        rankDelta: record.rankDelta,
        duration: Math.round((Date.now() - gameStartTime) / 1000),
        moveList: moveHistory.map(m => m.uci),
      }),
    });
  } catch (err) {
    console.warn("[history] server save failed:", err.message);
  }
}

// On startup, fetch this player's history from the server (source of truth)
// and replace the local cache. Falls back to local if server is unreachable.
async function syncHistoryFromServer() {
  try {
    const res = await fetch(`/pikafish/api/games?playerId=${PLAYER_ID}&limit=${MAX_HISTORY}`);
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.games) && data.games.length) {
      // Normalize server records to the local shape used by renderHistory
      const normalized = data.games.map(g => ({
        time: g.time,
        result: g.result,
        oppRank: g.oppRank,
        moves: g.moves,
        reason: g.reason,
      }));
      saveHistory(normalized);
      renderHistory();
      console.log(`[history] loaded ${normalized.length} games from server`);
    }
  } catch (err) {
    console.warn("[history] server sync failed, using local:", err.message);
  }
}

function renderHistory() {
  const el = document.getElementById("historyList");
  if (!el) return;
  const arr = loadHistory();
  if (!arr.length) {
    el.innerHTML = `<div style="color:#666;font-size:12px;padding:8px 0">暂无对局</div>`;
    return;
  }
  el.innerHTML = arr.slice(0, 20).map((g, i) => {
    const resultColor = g.result === "胜" ? "#4ade80" : g.result === "负" ? "#f87171" : "#fbbf24";
    const dt = new Date(g.time);
    const dateStr = `${dt.getMonth()+1}/${dt.getDate()} ${String(dt.getHours()).padStart(2,"0")}:${String(dt.getMinutes()).padStart(2,"0")}`;
    return `<div class="hist-item">
      <span class="hist-res" style="color:${resultColor}">${g.result}</span>
      <span class="hist-rank">${g.oppRank}</span>
      <span class="hist-info">${g.moves}手 · ${g.reason || ""}</span>
      <span class="hist-time">${dateStr}</span>
    </div>`;
  }).join("");
}

function updateRankDisplay() {
  const el = document.getElementById("rankBadge");
  if (el) el.textContent = `当前段位: ${rankLabel(playerRankIdx)}`;
}

// ── 终局处理 ───────────────────────────────────────────────────────
// winner: "red" | "black" | "draw"
// reason: "checkmate" | "stalemate" | "resign" | "flee" | "draw-accepted" | "king-missing"
function finishGame(winner, reason) {
  // Already finished? Guard against duplicate calls.
  if (gameOverInfo) return;
  const playerSideColor = playerSide === "red" ? "red" : "black";
  const playerWon = winner === playerSideColor;
  const isDraw = winner === "draw";

  gameOverInfo = { winner, reason, playerWon, isDraw };

  // Determine new rank
  let rankDelta = 0;
  let rankNote = "";
  if (mode === "play-ai" || mode === "play-p2p") {
    if (playerWon) {
      rankDelta = +1;
      rankNote = "升段";
    } else if (!isDraw) {
      rankDelta = -1;
      rankNote = "降段";
    }
    const oldRank = playerRankIdx;
    playerRankIdx = Math.max(0, Math.min(RANKS.length - 1, playerRankIdx + rankDelta));
    if (oldRank !== playerRankIdx) savePlayerRank(playerRankIdx);
    updateRankDisplay();
  }

  // Record history (client-side cache; server is source of truth)
  if (mode === "play-ai" || mode === "play-p2p") {
    // For P2P the server already saved; for AI we save here. Skip double-save.
    const shouldSaveClient = mode === "play-ai";
    if (shouldSaveClient) {
      const oppRankIdx = Math.max(0, Math.min(RANKS.length - 1,
        // Mirror: AI plays at roughly the player's rank ± 0 so games are competitive
        playerRankIdx + (playerWon ? 1 : 0)));
      pushHistory({
        time: Date.now(),
        result: isDraw ? "和" : (playerWon ? "胜" : "负"),
        oppRank: rankLabel(oppRankIdx),
        moves: moveHistory.length,
        reason: reasonLabel(reason),
        playerRankBefore: rankLabel(oldRank),
        playerRankAfter: rankLabel(playerRankIdx),
        rankDelta,
      });
    }
  }

  updateStatus();
  draw();                       // paint the game-over tint + stamp
  requestAnimationFrame(() => draw());  // paranoia redraw
  // Shake the board unless this was a quiet resignation/flee/draw
  if (reason === "checkmate" || reason === "stalemate") {
    const wrap = canvas.parentElement;
    if (wrap) {
      wrap.classList.remove("game-over-shake");
      void wrap.offsetWidth;          // force reflow so animation restarts
      wrap.classList.add("game-over-shake");
    }
  }
  showResultOverlay(winner, reason, rankDelta);
}

function reasonLabel(r) {
  return ({
    "checkmate": "绝杀",
    "stalemate": "困毙",
    "resign": "认输",
    "flee": "逃跑",
    "draw-accepted": "和棋",
    "king-missing": "将军",
  })[r] || r || "";
}

let gameOverInfo = null;

// ── Player actions: resign / offer draw / flee ─────────────────────
// These must respond even when the AI is mid-think — a player should always
// be able to give up. We cancel any pending AI request via the abort
// controller when finishing the game.
function resign() {
  if (gameOverInfo) return;
  if (mode === "play-p2p") {
    if (!p2pRoom) return;
    p2pSend({ type: "game.resign", roomId: p2pRoom.roomId });
    return;
  }
  if (mode !== "play-ai") return;
  aiThinking = false;
  const winnerColor = playerSide === "red" ? "black" : "red";
  finishGame(winnerColor, "resign");
}

function flee() {
  if (gameOverInfo) return;
  if (mode === "play-p2p") {
    if (!p2pRoom) return;
    p2pSend({ type: "game.flee", roomId: p2pRoom.roomId });
    return;
  }
  if (mode !== "play-ai") return;
  aiThinking = false;
  const winnerColor = playerSide === "red" ? "black" : "red";
  finishGame(winnerColor, "flee");
}

async function offerDraw() {
  if (gameOverInfo) return;
  if (mode === "play-p2p") {
    if (!p2pRoom || pendingDrawOffer) return;
    pendingDrawOffer = true;
    p2pSend({ type: "game.draw.offer", roomId: p2pRoom.roomId });
    setStatus("已提和，等待对手回应...");
    return;
  }
  if (mode !== "play-ai") return;
  if (pendingDrawOffer) return;
  if (aiThinking) {
    setStatus("请等 AI 走完这一步再提和");
    return;
  }
  pendingDrawOffer = true;
  setStatus("提和中：等待 AI 评估...", "thinking");
  try {
    const moves = moveHistory.map(m => m.uci);
    // Need multipv >= 2 so the server returns lines
    const res = await fetch("/pikafish/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ moves, depth: 14, multipv: 2 }),
    });
    const data = await res.json();
    const lines = data.lines || [];
    // AI's perspective: it's the AI's turn (side !== playerSide) after the player's
    // last move, so the eval is from the AI's POV.
    const aiSide = side;
    const aiPov = redPovScore(lines[0], aiSide);
    // Convert to AI's own advantage: AI is black if player is red, etc.
    const aiColor = playerSide === "red" ? "black" : "red";
    const aiAdvantage = aiColor === "red" ? aiPov : -aiPov;

    // AI accepts if it's not clearly winning. Threshold: if AI is ahead by
    // more than ~150 cp (1.5 pawns) it refuses; otherwise accepts.
    const accept = aiAdvantage < 150;
    if (accept) {
      finishGame("draw", "draw-accepted");
    } else {
      setStatus(`AI 拒绝提和（评估 AI 占优 ${(aiAdvantage/100).toFixed(2)}）`);
      setTimeout(() => updateStatus(), 2500);
    }
  } catch (err) {
    setStatus(`提和出错: ${err.message}`);
  } finally {
    pendingDrawOffer = false;
  }
}

// ── Result overlay ─────────────────────────────────────────────────
function showResultOverlay(winner, reason, rankDelta) {
  const overlay = document.getElementById("resultOverlay");
  if (!overlay) return;
  const titleEl = overlay.querySelector(".result-title");
  const subEl = overlay.querySelector(".result-sub");
  const rankEl = overlay.querySelector(".result-rank");
  const playerColor = playerSide === "red" ? "红方" : "黑方";
  const playerWon = winner === playerSide;
  const isDraw = winner === "draw";

  let cls, title, sub;
  if (isDraw) {
    cls = "draw"; title = "和棋"; sub = "双方同意提和";
  } else if (playerWon) {
    cls = "win"; title = "胜！";
    sub = reason === "checkmate" ? "绝杀对手" :
          reason === "stalemate" ? "对手困毙" :
          reason === "resign" ? "对手认输" :
          reason === "flee" ? "对手逃跑" : reasonLabel(reason);
  } else {
    cls = "lose"; title = "负";
    sub = reason === "checkmate" ? "被绝杀" :
          reason === "stalemate" ? "被困毙" :
          reason === "resign" ? "你已认输" :
          reason === "flee" ? "你已逃跑" : reasonLabel(reason);
  }

  overlay.className = `result-overlay show ${cls}`;
  titleEl.textContent = title;
  subEl.textContent = sub;

  let rankText = `当前段位: ${rankLabel(playerRankIdx)}`;
  if (rankDelta > 0) rankText = `升段 → ${rankLabel(playerRankIdx)} ↑`;
  else if (rankDelta < 0) rankText = `降段 → ${rankLabel(playerRankIdx)} ↓`;
  rankEl.textContent = rankText;

  overlay.style.display = "flex";
}

function hideResultOverlay() {
  const overlay = document.getElementById("resultOverlay");
  if (!overlay) return;
  overlay.className = "result-overlay";
  overlay.style.display = "none";
}

// ── Auth + user badge ──────────────────────────────────────────────
async function loadCurrentUser() {
  try {
    const res = await fetch("/pikafish/api/me");
    if (!res.ok) { currentUser = null; renderUserBadge(); return; }
    const data = await res.json();
    currentUser = (data && data.user) ? data.user : null;
  } catch {
    currentUser = null;
  }
  renderUserBadge();
}

function renderUserBadge() {
  const bar = document.getElementById("userBar");
  if (!bar) return;
  if (!currentUser) {
    bar.innerHTML = `<a href="/login" class="user-login-link">登录 / 注册</a>`;
    return;
  }
  const rank = rankLabel(playerRankIdx);
  const avatar = currentUser.avatar
    ? `<img src="${currentUser.avatar}" class="user-avatar" alt="">`
    : `<span class="user-avatar user-avatar-placeholder">${(currentUser.nickname || currentUser.username || "?").slice(0, 1)}</span>`;
  bar.innerHTML = `${avatar}<span class="user-name">${escapeHtml(currentUser.nickname || currentUser.username)}</span><span class="user-rank">${rank}</span>`;
}

function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ── WebSocket client ───────────────────────────────────────────────
function p2pWsUrl() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}/pikafish/ws`;
}

function p2pSend(msg) {
  if (!p2pSocket || p2pSocket.readyState !== 1) {
    setStatus("连接已断开，正在重连...");
    ensureP2PSocket();
    return false;
  }
  try {
    p2pSocket.send(JSON.stringify(msg));
    return true;
  } catch (err) {
    console.error("p2pSend failed", err);
    return false;
  }
}

function ensureP2PSocket() {
  if (p2pSocket && (p2pSocket.readyState === 0 || p2pSocket.readyState === 1)) return;
  if (!currentUser) return;
  try {
    p2pSocket = new WebSocket(p2pWsUrl());
  } catch (err) {
    setStatus("WebSocket 连接失败：" + err.message);
    return;
  }
  p2pSocket.onopen = () => {
    setStatus("已连接到大厅");
  };
  p2pSocket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    dispatchP2PMessage(msg);
  };
  p2pSocket.onclose = (e) => {
    if (mode !== "play-p2p") return;
    if (e && e.code === 4001) {
      setStatus("未登录或会话过期，请重新登录");
      return;
    }
    setStatus("连接断开，3 秒后重连...");
    setTimeout(() => {
      if (mode === "play-p2p") ensureP2PSocket();
    }, 3000);
  };
  p2pSocket.onerror = () => {};
}

function dispatchP2PMessage(msg) {
  switch (msg.type) {
    case "lobby.update":    renderLobby(msg.challenges || []); break;
    case "game.start":      startP2PGame(msg); break;
    case "game.move":       applyRemoteMove(msg); break;
    case "game.draw.offer": handleDrawOffer(msg); break;
    case "game.draw.respond": handleDrawRespond(msg); break;
    case "game.end":        handleP2PGameEnd(msg); break;
    case "game.chat":       appendP2PChat(msg); break;
    case "error":           setStatus("服务器错误: " + (msg.message || ""), "thinking"); break;
  }
}

// ── Lobby actions ──────────────────────────────────────────────────
function lobbyJoin(side) {
  if (!currentUser) {
    setStatus("请先登录");
    window.open("/login", "_blank");
    return;
  }
  ensureP2PSocket();
  // side: "red" | "black" | "random"
  const actualSide = side === "random"
    ? (Math.random() < 0.5 ? "red" : "black")
    : side;
  myLobbyEntry = { side: actualSide };
  p2pSend({
    type: "lobby.join",
    side: actualSide,
    rank: rankLabel(playerRankIdx),
    nickname: currentUser.nickname || currentUser.username,
  });
  setStatus(`已发起挑战，执${actualSide === "red" ? "红" : "黑"}，等待对手接受...`);
  renderLobbyActions();
}

function lobbyLeave() {
  if (!myLobbyEntry) return;
  p2pSend({ type: "lobby.leave" });
  myLobbyEntry = null;
  setStatus("已取消挑战");
  renderLobbyActions();
}

function lobbyAccept(targetUserId) {
  if (!currentUser) return;
  p2pSend({ type: "lobby.accept", targetUserId });
  setStatus("正在加入对局...");
}

function renderLobby(challenges) {
  const list = document.getElementById("lobbyList");
  if (!list) return;
  const others = challenges.filter((c) => c.userId !== (currentUser && currentUser.id));
  if (!others.length) {
    list.innerHTML = `<li class="lobby-empty">大厅暂无挑战，发起一个吧</li>`;
    return;
  }
  list.innerHTML = others.map((c) => {
    const sideText = c.side === "red" ? "执红" : c.side === "black" ? "执黑" : "随机";
    return `<li class="lobby-row">
      <span class="lobby-name">${escapeHtml(c.nickname || "棋友")}</span>
      <span class="lobby-rank">${escapeHtml(c.rank || "")}</span>
      <span class="lobby-side">${sideText}</span>
      <button onclick="lobbyAccept('${c.userId}')" class="lobby-accept-btn">接受</button>
    </li>`;
  }).join("");
}

function renderLobbyActions() {
  const box = document.getElementById("lobbyActions");
  if (!box) return;
  if (myLobbyEntry) {
    box.innerHTML = `
      <div class="lobby-waiting">
        <span class="spinner"></span>
        <span>等待对手接受 (执${myLobbyEntry.side === "red" ? "红" : "黑"})...</span>
        <button onclick="lobbyLeave()" class="lobby-cancel-btn">取消</button>
      </div>`;
  } else {
    box.innerHTML = `
      <div class="lobby-create">
        <span>发起挑战：</span>
        <button onclick="lobbyJoin('red')" class="lobby-side-btn">执红</button>
        <button onclick="lobbyJoin('black')" class="lobby-side-btn">执黑</button>
        <button onclick="lobbyJoin('random')" class="lobby-side-btn">随机</button>
      </div>`;
  }
}

// ── P2P game flow ──────────────────────────────────────────────────
function startP2PGame(msg) {
  // msg: { roomId, mySide, opponent: { nickname, rank, avatar, userId }, moves: [] }
  p2pRoom = {
    roomId: msg.roomId,
    mySide: msg.mySide,                  // "red" | "black"
    opponent: msg.opponent || {},
  };
  myLobbyEntry = null;
  renderLobbyActions();

  // Reset board for new game
  parseFen(START_FEN);
  positionHistory = new Set([currentPositionHash()]);
  moveHistory = [];
  playerSide = msg.mySide;
  // Auto-flip board so my side is at the bottom
  flipped = msg.mySide === "black";

  // Hide lobby UI; show opponent info
  const lobbyBox = document.getElementById("lobbyBox");
  if (lobbyBox) lobbyBox.style.display = "none";
  const oppInfo = document.getElementById("oppInfo");
  if (oppInfo) {
    oppInfo.style.display = "flex";
    const opp = p2pRoom.opponent || {};
    oppInfo.innerHTML = `
      <span class="opp-label">对手:</span>
      <span class="opp-name">${escapeHtml(opp.nickname || "棋友")}</span>
      <span class="opp-rank">${escapeHtml(opp.rank || "")}</span>
      <span class="opp-side">你执${msg.mySide === "red" ? "红" : "黑"}</span>`;
  }

  draw();
  updateStatus();
  hideResultOverlay();
  setStatus("对局开始！" + (isMyTurn() ? "请你先行" : "请对手先行"));
}

function applyRemoteMove(msg) {
  // msg: { uci, mover }
  if (!p2pRoom) return;
  if (gameOverInfo) return;
  // Apply the move without re-sending to server
  doMove(msg.uci.slice(0, 2), msg.uci.slice(2, 4), { skipP2PSend: true });
}

function handleDrawOffer(msg) {
  if (!p2pRoom) return;
  if (gameOverInfo) return;
  // Show inline accept/decline prompt
  setStatus("对手提和：接受或拒绝", "thinking");
  const actionRow = document.querySelector(".action-row");
  if (!actionRow) return;
  // Temporarily inject a draw prompt; restore on response
  const existing = document.getElementById("p2pDrawPrompt");
  if (existing) existing.remove();
  const prompt = document.createElement("div");
  prompt.id = "p2pDrawPrompt";
  prompt.className = "draw-prompt";
  prompt.innerHTML = `
    <span>对手提议和棋</span>
    <button onclick="respondDraw(true)" class="draw-accept">接受</button>
    <button onclick="respondDraw(false)" class="draw-decline">拒绝</button>`;
  actionRow.appendChild(prompt);
}

function respondDraw(accept) {
  const prompt = document.getElementById("p2pDrawPrompt");
  if (prompt) prompt.remove();
  if (!p2pRoom) return;
  p2pSend({ type: "game.draw.respond", roomId: p2pRoom.roomId, accept });
  setStatus(accept ? "已接受和棋" : "已拒绝和棋");
  pendingDrawOffer = false;
}

function handleDrawRespond(msg) {
  pendingDrawOffer = false;
  if (msg.accept) {
    // Server will broadcast game.end with reason draw-accepted
    setStatus("对手接受和棋");
  } else {
    setStatus("对手拒绝和棋，继续战斗");
    setTimeout(() => updateStatus(), 2000);
  }
}

function handleP2PGameEnd(msg) {
  // msg: { winner, reason }
  // For P2P: winner is "red"|"black"|"draw" from server; translate to player-relative
  if (!p2pRoom) return;
  // Reset room state but keep opponent info briefly via overlay
  const winnerSide = msg.winner;  // red/black/draw
  finishGame(winnerSide, msg.reason);
  p2pRoom = null;
  // Show lobby again after a delay so player sees result
  setTimeout(() => {
    if (mode !== "play-p2p") return;
    const oppInfo = document.getElementById("oppInfo");
    if (oppInfo) oppInfo.style.display = "none";
    const lobbyBox = document.getElementById("lobbyBox");
    if (lobbyBox) lobbyBox.style.display = "block";
    renderLobbyActions();
    ensureP2PSocket();
  }, 4000);
}

function appendP2PChat(msg) {
  // Reserved for chat (optional); not implementing in v15 UI
}

// ── Init ───────────────────────────────────────────────────────────
parseFen(START_FEN);
positionHistory = new Set([currentPositionHash()]);
draw();
updateStatus();
updateRankDisplay();
renderHistory();
syncHistoryFromServer(); // pull permanent history on load
if (mode === "play-ai" && side === sideChar(playerSide)) {
  setTimeout(() => fetchSuggestions(), 400);
}

loadCurrentUser();
