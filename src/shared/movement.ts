import {
  CORNER_SLIDE_MAX,
  HALF_TILE,
  PLAYER_HALF,
  SKULL_SPEED,
  SUB,
} from "./constants";
import { tileAt } from "./map";
import { Dir, Key, Tile, type Bomb, type Player } from "./types";

/** 移動判定に必要な最小限の世界。GameState はこれを満たす。
 *  クライアント側予測では最新スナップショットから構築した部分世界を渡す */
export interface World {
  grid: Uint8Array;
  bombs: Bomb[];
}

/** タイル (cx,cy) が p にとって通行可能か（グリッド + 爆弾 + 壁すり抜け） */
export function tilePassable(
  state: World,
  cx: number,
  cy: number,
  p: Player,
): boolean {
  const t = tileAt(state.grid, cx, cy);
  if (t === Tile.Soft) {
    if (p.wallPass > 0) return true;
    // チャージが尽きていても、いま体が食い込んでいるブロックからは抜け出せる
    // （スタック防止）。p.inSoftWall が落ちた後は触れていても侵入不可になるので、
    // 抜けきった後に半歩戻って再侵入することはできない
    return p.inSoftWall && boxOverlapsTile(p, cx, cy);
  }
  if (t !== Tile.Floor) return false;
  for (const b of state.bombs) {
    if (b.cx === cx && b.cy === cy) return (b.passableBy & (1 << p.slot)) !== 0;
  }
  return true;
}

/** 中心 (x,y) のヒットボックスがいずれかの不通行タイルと重なるか */
export function collides(
  state: World,
  x: number,
  y: number,
  p: Player,
): boolean {
  // ボックスは [x-HALF, x+HALF)。境界ちょうどは含まない
  const x0 = Math.floor((x - PLAYER_HALF) / SUB);
  const x1 = Math.floor((x + PLAYER_HALF - 1) / SUB);
  const y0 = Math.floor((y - PLAYER_HALF) / SUB);
  const y1 = Math.floor((y + PLAYER_HALF - 1) / SUB);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (!tilePassable(state, cx, cy, p)) return true;
    }
  }
  return false;
}

/** ヒットボックスがタイル (cx,cy) に重なっているか */
export function boxOverlapsTile(p: Player, cx: number, cy: number): boolean {
  const x0 = Math.floor((p.x - PLAYER_HALF) / SUB);
  const x1 = Math.floor((p.x + PLAYER_HALF - 1) / SUB);
  const y0 = Math.floor((p.y - PLAYER_HALF) / SUB);
  const y1 = Math.floor((p.y + PLAYER_HALF - 1) / SUB);
  return cx >= x0 && cx <= x1 && cy >= y0 && cy <= y1;
}

/**
 * 体の一部でもソフトブロックに触れているか。
 * 「壁の中にいる」の判定は中心タイルではなくこれを使う。中心タイルだと
 * 半身が壁に残ったまま「抜けた」と誤判定し、効力が早く切れてしまう。
 */
export function touchingSoftWall(grid: Uint8Array, p: Player): boolean {
  const x0 = Math.floor((p.x - PLAYER_HALF) / SUB);
  const x1 = Math.floor((p.x + PLAYER_HALF - 1) / SUB);
  const y0 = Math.floor((p.y - PLAYER_HALF) / SUB);
  const y1 = Math.floor((p.y + PLAYER_HALF - 1) / SUB);
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      if (tileAt(grid, cx, cy) === Tile.Soft) return true;
    }
  }
  return false;
}

export function centerTileX(p: Player): number {
  return Math.floor(p.x / SUB);
}
export function centerTileY(p: Player): number {
  return Math.floor(p.y / SUB);
}

function moveAxis(
  state: World,
  p: Player,
  axis: 0 | 1, // 0=x, 1=y
  sign: number,
  amount: number,
  allowSlide: boolean,
): void {
  const cur = axis === 0 ? p.x : p.y;
  const target = cur + sign * amount;
  const tx = axis === 0 ? target : p.x;
  const ty = axis === 1 ? target : p.y;

  if (!collides(state, tx, ty, p)) {
    if (axis === 0) p.x = target;
    else p.y = target;
    return;
  }

  // (a) 壁ぎわまで詰める（進行方向の先端が入るタイルの境界にクランプ）
  let clamped: number;
  if (sign > 0) {
    const leadTile = Math.floor((target + PLAYER_HALF - 1) / SUB);
    clamped = leadTile * SUB - PLAYER_HALF;
  } else {
    const leadTile = Math.floor((target - PLAYER_HALF) / SUB);
    clamped = (leadTile + 1) * SUB + PLAYER_HALF;
  }
  // クランプが逆方向へ動かす場合は現在位置を維持
  if ((sign > 0 && clamped > cur) || (sign < 0 && clamped < cur)) {
    const cx2 = axis === 0 ? clamped : p.x;
    const cy2 = axis === 1 ? clamped : p.y;
    if (!collides(state, cx2, cy2, p)) {
      if (axis === 0) p.x = clamped;
      else p.y = clamped;
    }
  }

  if (!allowSlide) return;

  // (b) コーナースライド: 進行方向の1マス先（中心タイル基準）が空いていて、
  //     垂直軸のズレが小さければタイル中心へ整列を助ける
  const ctx = Math.floor(p.x / SUB);
  const cty = Math.floor(p.y / SUB);
  const nx = axis === 0 ? ctx + sign : ctx;
  const ny = axis === 1 ? cty + sign : cty;
  if (!tilePassable(state, nx, ny, p)) return;

  const perp = axis === 0 ? p.y : p.x;
  const center = (axis === 0 ? cty : ctx) * SUB + HALF_TILE;
  const off = perp - center;
  if (off === 0 || Math.abs(off) > CORNER_SLIDE_MAX) return;

  const slideSign = off > 0 ? -1 : 1;
  const slideAmt = Math.min(amount, Math.abs(off));
  moveAxis(state, p, axis === 0 ? 1 : 0, slideSign, slideAmt, false);
}

/** 1 tick 分のプレイヤー移動（キー入力に基づく）。サーバー/クライアント予測で共有 */
export function movePlayer(state: World, p: Player, keys: number): void {
  const dx = ((keys & Key.Right) !== 0 ? 1 : 0) - ((keys & Key.Left) !== 0 ? 1 : 0);
  let dy = ((keys & Key.Down) !== 0 ? 1 : 0) - ((keys & Key.Up) !== 0 ? 1 : 0);
  if (dx !== 0 && dy !== 0) dy = 0; // 斜め入力は水平優先（決定論のため固定）
  if (dx === 0 && dy === 0) return;

  p.dir = dx > 0 ? Dir.Right : dx < 0 ? Dir.Left : dy > 0 ? Dir.Down : Dir.Up;
  // ドクロ中は実効速度が落ちる。クライアント予測もこの関数を通るので予測がズレない
  const speed = p.skullTicks > 0 ? Math.min(SKULL_SPEED, p.speed) : p.speed;
  if (dx !== 0) moveAxis(state, p, 0, dx, speed, true);
  else moveAxis(state, p, 1, dy, speed, true);
}
