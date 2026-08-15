// エントリポイント: ?room= があればゲーム画面、なければロビー

import {
  COUNTDOWN_TICKS,
  DEFAULT_WIN_TARGET,
  HALF_TILE,
  MAP_W,
  SPAWNS,
  START_GRACE_MS,
  SUB,
  TICK_RATE,
  WIN_TARGET_OPTIONS,
} from "../shared/constants";
import { decodeGrid, type RosterEntry, type S2C } from "../shared/protocol";
import { InputTracker } from "./game/input";
import { SnapBuffer } from "./game/interpolation";
import { Net } from "./game/net";
import { Prediction } from "./game/prediction";
import { Renderer } from "./game/renderer";
import { SLOT_THEMES } from "./game/sprites";
import { renderHelp } from "./help";
import { renderLobby } from "./lobby";

const appRoot = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const roomParam = params.get("room");

if (params.has("help")) {
  renderHelp(appRoot);
} else if (!roomParam) {
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
  <div id="seriesView" style="margin-bottom:8px;min-height:1.2em;font-size:13px"></div>
  <div id="startHint" style="margin-bottom:8px;min-height:1.4em;color:#888;font-size:13px"></div>
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
const startHintEl = document.getElementById("startHint")!;
const seriesEl = document.getElementById("seriesView")!;

// シリーズ（何勝先取）の状態
let winTarget = DEFAULT_WIN_TARGET;
let wins: number[] = [];
let round = 0;
let championSlot: number | null = null;

/** 何勝先取の設定 UI と現在のスコアを描画 */
function renderSeries(): void {
  const waiting = readyBtn.style.display !== "none";
  const inSeries = round > 0;

  // 待機中かつシリーズ未開始のときだけ設定を変更できる
  if (waiting && !inSeries) {
    const opts = WIN_TARGET_OPTIONS.map((n) => {
      const on = n === winTarget;
      const label = n === 1 ? "1本勝負" : `${n}本先取`;
      return (
        `<button data-target="${n}" style="margin-right:6px;padding:3px 10px;` +
        `background:${on ? "#3f8ce8" : "#2a2a3e"};color:${on ? "#fff" : "#aaa"};` +
        `border:1px solid ${on ? "#5aa4f0" : "#444"};border-radius:4px;cursor:pointer">${label}</button>`
      );
    }).join("");
    seriesEl.innerHTML = `<span style="color:#888;margin-right:8px">勝敗形式:</span>${opts}`;
    for (const btn of seriesEl.querySelectorAll<HTMLButtonElement>("button[data-target]")) {
      btn.addEventListener("click", () => {
        net.send({ t: "setWinTarget", winTarget: Number(btn.dataset.target) });
      });
    }
    return;
  }

  // シリーズ中はスコアボードを表示
  if (inSeries) {
    const scores = roster
      .map((r) => {
        const w = wins[r.slot] ?? 0;
        const color = SLOT_THEMES[r.slot]?.primary ?? "#fff";
        const champ = championSlot === r.slot ? " 👑" : "";
        return (
          `<span style="margin-right:14px"><span style="color:${color}">■</span> ` +
          `${r.name} <strong>${w}</strong>${champ}</span>`
        );
      })
      .join("");
    const label = winTarget === 1 ? "1本勝負" : `${winTarget}本先取`;
    seriesEl.innerHTML =
      `<span style="color:#888;margin-right:8px">${label} / 第${round}試合</span>${scores}`;
    return;
  }

  seriesEl.innerHTML = "";
}

// 開始猶予。サーバーとクライアントの時計はズレうるので、絶対時刻ではなく
// 「受信時点から START_GRACE_MS」をローカル時計で数える
let startPendingUntil: number | null = null;
let startPendingPlayers = 0;
let hintTimer: ReturnType<typeof setInterval> | null = null;

function clearStartPending(): void {
  startPendingUntil = null;
  startPendingPlayers = 0;
  if (hintTimer !== null) {
    clearInterval(hintTimer);
    hintTimer = null;
  }
}

/** Ready ボタンの文言とヒントを、今の状況に合わせて描き直す */
function updateStartUi(): void {
  const waiting = readyBtn.style.display !== "none";
  if (!waiting) {
    startHintEl.textContent = "";
    return;
  }

  const others = roster.filter((r) => r.slot !== mySlot);
  const notReady = roster.filter((r) => !r.ready);

  if (startPendingUntil !== null) {
    const left = Math.max(0, Math.ceil((startPendingUntil - performance.now()) / 1000));
    startHintEl.innerHTML =
      `<span style="color:#e67e22">まもなく開始（${left}秒）…</span> ` +
      `${startPendingPlayers}人で対戦します。` +
      `<span style="color:#aaa">待つ人がいるなら Cancel で中止できます。</span>`;
    readyBtn.textContent = "Cancel";
    return;
  }

  // 2人未満では「n人で開始」は誤解を招く（その人数では始まらない）ので出さない
  readyBtn.textContent = ready
    ? "Cancel"
    : roster.length >= 2
      ? `Ready（${roster.length}人で開始）`
      : "Ready";

  if (roster.length < 2) {
    startHintEl.textContent = "対戦にはあと1人以上必要です。誰かの参加を待っています…";
  } else if (notReady.length > 0) {
    const names = notReady.map((r) => r.name).join(", ");
    startHintEl.textContent =
      `全員が Ready を押すと開始します（未準備: ${names}）。` +
      `まだ来ていない人がいるなら、揃うまで待ってください。`;
  } else {
    startHintEl.textContent = `${others.length + 1}人が準備完了です。`;
  }
}

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
      winTarget = msg.winTarget;
      wins = msg.wins;
      round = msg.round;
      if (msg.phase === "waiting") showWaitingUi();
      renderRoster();
      updateStartUi();
      renderSeries();
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
      updateStartUi();
      renderSeries();
      break;
    case "startPending":
      startPendingUntil = performance.now() + START_GRACE_MS;
      startPendingPlayers = msg.players;
      if (hintTimer === null) hintTimer = setInterval(updateStartUi, 250);
      updateStartUi();
      break;
    case "startCancelled":
      clearStartPending();
      updateStartUi();
      break;
    case "start":
      grid = decodeGrid(msg.grid);
      renderer.rebuildBackground(grid);
      renderer.resetMatchState();
      snapBuffer.clear();
      winnerSlot = null;
      countdownEndTick = msg.tick + msg.countdownTicks;
      readyBtn.style.display = "none";
      clearStartPending();
      startHintEl.textContent = "";
      championSlot = null;
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
    case "series":
      winTarget = msg.winTarget;
      wins = msg.wins;
      round = msg.round;
      championSlot = msg.championSlot;
      renderSeries();
      break;
    case "gameover":
      winnerSlot = msg.winnerSlot;
      wins = msg.wins;
      winTarget = msg.winTarget;
      championSlot = msg.championSlot;
      prediction?.matchEnded();
      renderSeries();
      // シリーズ続行なら次の試合が自動で始まることを伝える
      startHintEl.textContent =
        msg.championSlot === null
          ? "まもなく次の試合が始まります…"
          : "";
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
  clearStartPending();
  updateStartUi();
  renderSeries();
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
  net.send({ t: "ready", ready });
  // 取り消しの体感を早くするため、サーバーの startCancelled を待たずに畳む
  if (!ready) clearStartPending();
  updateStartUi();
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
  // 予測 tick を添えて送る。サーバーはこの tick まで適用を保留するので、
  // クライアント予測とサーバー適用タイミングが一致し reconciliation が発生しない。
  net.send({
    t: "input",
    seq,
    tick: prediction?.inputTick ?? snapBuffer.latest?.k ?? 0,
    keys: mask,
  });
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
      // 半透明も予測に合わせる。snap 由来のままだと自キャラだけ表示が遅れる
      mine.inSoftWall = prediction.inSoftWall;
    }
  }

  renderer.draw({
    grid,
    snap: snapBuffer.latest,
    players,
    roster,
    mySlot,
    winnerSlot,
    championSlot,
    winTarget,
    wins,
    countdownEndTick,
  });

  if (now - lastDebugAt > 500) {
    lastDebugAt = now;
    debugEl.textContent = prediction
      ? `rtt:${net.rttMs.toFixed(0)}ms err:${prediction.lastError} fix:${prediction.corrections}`
      : `rtt:${net.rttMs.toFixed(0)}ms`;
    // 自分のステータス表示
    const mine = snapBuffer.latest?.p.find((p) => p[0] === mySlot);
    if (mine) {
      const [, , , , flags, fire, bombCap, speed, skullTicks, wallPass] = mine;
      const parts = [`🔥${fire}`, `💣${bombCap}`, `👟${Math.round((speed - 32) / 8)}`];
      if ((flags & 4) !== 0) parts.push("➡️貫通");
      if ((flags & 16) !== 0) parts.push("👊パンチ");
      const wp = wallPass ?? 0;
      if (wp > 0) parts.push(wp > 1 ? `👻すり抜け×${wp}` : "👻すり抜け");
      if (skullTicks > 0) parts.push(`💀${Math.ceil(skullTicks / TICK_RATE)}秒`);
      statsEl.textContent = parts.join(" ");
      statsEl.style.color = skullTicks > 0 ? "#e74c3c" : "";
    } else {
      statsEl.textContent = "";
    }
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
}
