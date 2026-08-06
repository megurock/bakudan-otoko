// エントリポイント: ?room= があればゲーム画面、なければロビー

import { COUNTDOWN_TICKS, HALF_TILE, MAP_W, SPAWNS, SUB } from "../shared/constants";
import { decodeGrid, type RosterEntry, type S2C } from "../shared/protocol";
import { InputTracker } from "./game/input";
import { SnapBuffer } from "./game/interpolation";
import { Net } from "./game/net";
import { Prediction } from "./game/prediction";
import { Renderer } from "./game/renderer";
import { SLOT_THEMES } from "./game/sprites";
import { renderLobby } from "./lobby";

const appRoot = document.getElementById("app")!;
const roomParam = new URLSearchParams(location.search).get("room");

if (!roomParam) {
  renderLobby(appRoot);
} else {
  startGame(appRoot, roomParam);
}

function startGame(app: HTMLElement, roomId: string): void {
  app.innerHTML = `
  <h1 style="margin:8px 0">💣 BakudanOtoko</h1>
  <div id="hud" style="margin-bottom:8px">
    <span id="status">connecting...</span>
    <button id="readyBtn" style="display:none;margin-left:12px;padding:4px 16px">Ready</button>
    <span id="stats" style="margin-left:16px"></span>
  </div>
  <div id="rosterView" style="margin-bottom:8px;min-height:1.2em"></div>
  <canvas id="game" style="border:2px solid #444;max-width:100%;image-rendering:pixelated"></canvas>
  <p style="color:#888">移動: 矢印キー / WASD ・ 爆弾: Space / Z ・ <a href="./" style="color:#6af">ロビーへ戻る</a>
    <span id="debug" style="float:right;color:#555;font-size:11px"></span></p>
`;

const statusEl = document.getElementById("status")!;
const readyBtn = document.getElementById("readyBtn") as HTMLButtonElement;
const rosterView = document.getElementById("rosterView")!;
const canvas = document.getElementById("game") as HTMLCanvasElement;

// ===== 状態 =====

const playerName =
  new URLSearchParams(location.search).get("name") ??
  `P${Math.floor(Math.random() * 1000)}`;

let mySlot = -1;
let token = sessionStorage.getItem(`bm-token-${roomId}`) ?? undefined;
let roster: RosterEntry[] = [];
let grid: Uint8Array | null = null;
let winnerSlot: number | null = null;
let countdownEndTick = COUNTDOWN_TICKS;
let ready = false;
let seq = 0;
let prediction: Prediction | null = null;

const renderer = new Renderer(canvas);
const snapBuffer = new SnapBuffer();
const debugEl = document.getElementById("debug")!;
const statsEl = document.getElementById("stats")!;

// ===== ネットワーク =====

const net = new Net(roomId, {
  onOpen() {
    statusEl.textContent = `room: ${roomId}`;
    net.send({ t: "join", name: playerName, token });
  },
  onClose() {
    statusEl.textContent = "disconnected（リロードで再接続）";
    readyBtn.style.display = "none";
  },
  onMessage(msg: S2C) {
    handleMessage(msg);
  },
});
net.connect();

function handleMessage(msg: S2C): void {
  switch (msg.t) {
    case "welcome":
      mySlot = msg.slot;
      token = msg.token;
      sessionStorage.setItem(`bm-token-${roomId}`, token);
      roster = msg.roster;
      if (msg.phase === "waiting") showWaitingUi();
      renderRoster();
      break;
    case "joinRejected":
      statusEl.textContent = `参加できません: ${msg.reason}`;
      break;
    case "roster":
      roster = msg.roster;
      renderRoster();
      if (msg.phase === "waiting" && readyBtn.style.display === "none" && mySlot >= 0) {
        resetToWaitingUi();
      }
      break;
    case "start":
      grid = decodeGrid(msg.grid);
      renderer.rebuildBackground(grid);
      renderer.resetMatchState();
      snapBuffer.clear();
      winnerSlot = null;
      countdownEndTick = msg.tick + msg.countdownTicks;
      readyBtn.style.display = "none";
      statusEl.textContent = `room: ${roomId}`;
      if (mySlot >= 0 && mySlot < SPAWNS.length) {
        const spawn = SPAWNS[mySlot]!;
        prediction = new Prediction(
          mySlot,
          spawn[0] * SUB + HALF_TILE,
          spawn[1] * SUB + HALF_TILE,
        );
        prediction.setGrid(grid);
      }
      break;
    case "snap":
      if (msg.g && grid) {
        for (const [cx, cy, tile] of msg.g) grid[cy * MAP_W + cx] = tile;
      }
      renderer.ingest(msg);
      snapBuffer.push(msg);
      if (prediction && grid) {
        prediction.onSnap(msg, grid);
        if (msg.ph === "playing") prediction.syncClock(msg.k, net.rttMs);
      }
      break;
    case "gameover":
      winnerSlot = msg.winnerSlot;
      prediction?.matchEnded();
      break;
    case "aborted":
      statusEl.textContent = `試合中断: ${msg.reason}`;
      resetToWaitingUi();
      break;
    case "pong":
      break;
  }
}

function showWaitingUi(): void {
  readyBtn.style.display = "";
  ready = false;
  readyBtn.textContent = "Ready";
}

function resetToWaitingUi(): void {
  grid = null;
  winnerSlot = null;
  prediction = null;
  snapBuffer.clear();
  renderer.resetMatchState();
  statusEl.textContent = `room: ${roomId}`;
  showWaitingUi();
}

readyBtn.addEventListener("click", () => {
  ready = !ready;
  readyBtn.textContent = ready ? "Cancel" : "Ready";
  net.send({ t: "ready", ready });
});

function renderRoster(): void {
  rosterView.innerHTML = roster
    .map((r) => {
      const color = SLOT_THEMES[r.slot]?.primary ?? "#fff";
      const state = r.connected ? (r.ready ? "✅" : "…") : "🔌";
      const me = r.slot === mySlot ? " (you)" : "";
      return `<span style="margin-right:12px"><span style="color:${color}">■</span> ${r.name}${me} ${state}</span>`;
    })
    .join("");
}

// ===== 入力 =====

const tracker = new InputTracker((mask) => {
  seq++;
  net.send({ t: "input", seq, tick: snapBuffer.latest?.k ?? 0, keys: mask });
});

// ===== 描画ループ =====

let lastDebugAt = 0;

function frame(): void {
  const now = performance.now();
  const players = snapBuffer.sample(now);

  // 自キャラは予測位置で上書き（他プレイヤーは補間のまま）
  if (prediction && prediction.alive) {
    prediction.frame(now, tracker.current);
    const mine = players.find((p) => p.slot === mySlot);
    if (mine) {
      mine.x = prediction.renderX;
      mine.y = prediction.renderY;
      mine.dir = prediction.dir;
    }
  }

  renderer.draw({
    grid,
    snap: snapBuffer.latest,
    players,
    roster,
    mySlot,
    winnerSlot,
    countdownEndTick,
  });

  if (now - lastDebugAt > 500) {
    lastDebugAt = now;
    debugEl.textContent = prediction
      ? `rtt:${net.rttMs.toFixed(0)}ms err:${prediction.lastError} fix:${prediction.corrections}`
      : `rtt:${net.rttMs.toFixed(0)}ms`;
    // 自分のステータス表示
    const mine = snapBuffer.latest?.p.find((p) => p[0] === mySlot);
    statsEl.textContent = mine
      ? `🔥${mine[5]} 💣${mine[6]} 👟${Math.round((mine[7] - 32) / 8)}`
      : "";
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
}
