import { MAP_H, MAP_W } from "./constants";
import type { GameEvent, GameState, Phase } from "./types";

// ===== ロースター =====
export interface RosterEntry {
  slot: number;
  name: string;
  ready: boolean;
  connected: boolean;
}

// ===== クライアント → サーバー =====
export type C2S =
  | { t: "join"; name: string; token?: string }
  | { t: "ready"; ready: boolean }
  | { t: "setWinTarget"; winTarget: number }
  | { t: "input"; seq: number; tick: number; keys: number }
  | { t: "ping"; ts: number };

// ===== サーバー → クライアント =====

// snap のエンティティはタプル（キー名の反復を排して帯域を約1/3に）
export type SnapPlayer = [
  slot: number,
  x: number,
  y: number,
  dir: number,
  flags: number, // bit0=alive bit1=connected bit2=pierce bit3=inSoftWall bit4=punch
  fire: number,
  bombCap: number,
  speed: number,
  skullTicks: number,
  wallPass: number,
];
export type SnapBomb = [
  id: number,
  cx: number,
  cy: number,
  fuse: number,
  range: number,
  ownerSlot: number,
  pierce: 0 | 1,
  // 設置直後にすり抜けられるプレイヤーのビットマスク。クライアント予測が
  // サーバーと同じ判定を再現するために必要（近似するとひっかかりが出る）
  passableBy: number,
  // パンチ飛翔。予測が「飛翔中は通行可」をサーバーと同じ値で再現するために必要。
  // cx/cy は着地（予定）タイル、flyFrom は発射元（描画の補間用）。
  // 画面端をラップして飛ぶため、from→cx の直線からは経路が導けない。
  // 方向と総マス数を明示的に送る
  flyTicks: number,
  flyFromCx: number,
  flyFromCy: number,
  flyDir: number,
  flyDist: number,
];
export type SnapBlast = [cx: number, cy: number, dir: number, shape: number];
export type SnapItem = [cx: number, cy: number, kind: number];
export type SnapGridDiff = [cx: number, cy: number, tile: number];

export interface Snap {
  t: "snap";
  k: number; // サーバー tick（この snap は tick k の処理結果）
  ph: Phase;
  p: SnapPlayer[];
  b: SnapBomb[];
  f: SnapBlast[];
  u: SnapItem[]; // reveal 済みアイテムのみ
  g?: SnapGridDiff[];
  e?: GameEvent[];
  a: number[]; // slot → 処理済み入力 seq（reconciliation ack）
}

export type S2C =
  | {
      t: "welcome";
      slot: number;
      token: string;
      phase: Phase;
      roster: RosterEntry[];
      winTarget: number;
      wins: number[];
      round: number;
      proto: 1;
    }
  | { t: "joinRejected"; reason: "full" | "in_progress" | "bad_token" }
  | { t: "roster"; roster: RosterEntry[]; phase: Phase }
  // 全員 Ready 後の開始猶予。endsAt までに誰かが Ready を外すと startCancelled が来る
  | { t: "startPending"; endsAt: number; players: number }
  | { t: "startCancelled" }
  | {
      t: "start";
      seed: number;
      tick: number;
      countdownTicks: number;
      grid: string; // 数字文字列（MAP_W*MAP_H 桁）
      slots: number[];
    }
  | Snap
  // シリーズ（何勝先取）の状態。wins は slot → 勝数
  | {
      t: "series";
      winTarget: number;
      wins: number[];
      round: number;
      championSlot: number | null; // 先取達成者。null = 続行中
    }
  | {
      t: "gameover";
      winnerSlot: number; // -1 = 引き分け
      wins: number[];
      winTarget: number;
      championSlot: number | null; // シリーズ全体の勝者。null = 次戦へ
    }
  | { t: "aborted"; reason: string }
  | { t: "pong"; ts: number; serverTick: number };

// ===== encode / decode =====

export function encode(msg: C2S | S2C): string {
  return JSON.stringify(msg);
}

export function decodeC2S(data: string): C2S | null {
  try {
    const msg = JSON.parse(data) as C2S;
    if (typeof msg !== "object" || msg === null || typeof msg.t !== "string") {
      return null;
    }
    return msg;
  } catch {
    return null;
  }
}

export function decodeS2C(data: string): S2C | null {
  try {
    const msg = JSON.parse(data) as S2C;
    if (typeof msg !== "object" || msg === null || typeof msg.t !== "string") {
      return null;
    }
    return msg;
  } catch {
    return null;
  }
}

// ===== グリッドのシリアライズ =====

export function encodeGrid(grid: Uint8Array): string {
  let s = "";
  for (let i = 0; i < grid.length; i++) s += grid[i];
  return s;
}

export function decodeGrid(s: string): Uint8Array {
  const grid = new Uint8Array(MAP_W * MAP_H);
  for (let i = 0; i < grid.length && i < s.length; i++) {
    grid[i] = s.charCodeAt(i) - 48;
  }
  return grid;
}

// ===== スナップショット構築（サーバー側で使用） =====

export function buildSnap(state: GameState, ackSeqs: number[]): Snap {
  const snap: Snap = {
    t: "snap",
    k: state.tick,
    ph: state.phase,
    p: state.players.map((p) => [
      p.slot,
      p.x,
      p.y,
      p.dir,
      (p.alive ? 1 : 0) |
        (p.connected ? 2 : 0) |
        (p.pierce ? 4 : 0) |
        (p.inSoftWall ? 8 : 0) |
        (p.punch ? 16 : 0),
      p.fire,
      p.bombCap,
      p.speed,
      p.skullTicks,
      p.wallPass,
    ]),
    b: state.bombs.map((b) => [
      b.id,
      b.cx,
      b.cy,
      b.fuse,
      b.range,
      b.ownerSlot,
      b.pierce ? 1 : 0,
      b.passableBy,
      b.flyTicks,
      b.flyFromCx,
      b.flyFromCy,
      b.flyDir,
      b.flyDist,
    ]),
    f: state.blasts.map((bl) => [bl.cx, bl.cy, bl.dir, bl.shape]),
    u: state.items
      .filter((it) => it.revealTick <= state.tick)
      .map((it) => [it.cx, it.cy, it.kind]),
    a: ackSeqs,
  };
  if (state.gridDiffs.length > 0) snap.g = [...state.gridDiffs];
  if (state.events.length > 0) snap.e = [...state.events];
  return snap;
}
