import {
  DROP_PCT,
  MAP_H,
  MAP_W,
  PUNCH_MAX_COUNT,
  PUNCH_MIN_COUNT,
  SOFT_FILL_PCT,
  SPAWNS,
  WALLPASS_MAX_COUNT,
  WALLPASS_MIN_COUNT,
} from "./constants";
import { randBelow, type RngState } from "./rng";
import { Powerup, Tile } from "./types";

export function idx(cx: number, cy: number): number {
  return cy * MAP_W + cx;
}

export function tileAt(grid: Uint8Array, cx: number, cy: number): number {
  if (cx < 0 || cy < 0 || cx >= MAP_W || cy >= MAP_H) return Tile.Hard;
  return grid[idx(cx, cy)] ?? Tile.Hard;
}

export interface MapData {
  grid: Uint8Array;
  hiddenItems: Uint8Array; // 0=なし, kind+1
}

/**
 * マップ生成。外周とハード格子柱 + ソフトブロック + 隠しアイテム配置。
 * ドロップはこの時点で確定するため playing 中のシミュレーションは乱数フリー。
 * slots は参加プレイヤーの slot 番号（歯抜けあり得る）。各 SPAWNS[slot] 周辺を予約する。
 */
export function createMap(rng: RngState, slots: readonly number[]): MapData {
  const grid = new Uint8Array(MAP_W * MAP_H);
  const hiddenItems = new Uint8Array(MAP_W * MAP_H);

  // 外周 + 偶数格子柱
  for (let cy = 0; cy < MAP_H; cy++) {
    for (let cx = 0; cx < MAP_W; cx++) {
      const isBorder = cx === 0 || cy === 0 || cx === MAP_W - 1 || cy === MAP_H - 1;
      const isPillar = cx % 2 === 0 && cy % 2 === 0;
      if (isBorder || isPillar) grid[idx(cx, cy)] = Tile.Hard;
    }
  }

  // スポーン周辺の予約（ソフトブロックを置かない）: 本人マス + 各方向へ距離2まで
  const reserved = new Set<number>();
  const spawns = slots.map((s) => SPAWNS[s] ?? SPAWNS[0]!);
  for (const [sx, sy] of spawns) {
    reserved.add(idx(sx, sy));
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      for (let d = 1; d <= 2; d++) {
        const nx = sx + dx * d;
        const ny = sy + dy * d;
        if (tileAt(grid, nx, ny) === Tile.Hard) break; // 柱・外周で打ち切り
        reserved.add(idx(nx, ny));
      }
    }
  }

  // ソフトブロック配置 + 隠しアイテム確定
  for (let cy = 1; cy < MAP_H - 1; cy++) {
    for (let cx = 1; cx < MAP_W - 1; cx++) {
      const i = idx(cx, cy);
      if (grid[i] !== Tile.Floor || reserved.has(i)) continue;
      if (randBelow(rng, 100) < SOFT_FILL_PCT) {
        grid[i] = Tile.Soft;
        if (randBelow(rng, 100) < DROP_PCT) {
          // Fire:7 Bomb:6 Speed:5 Pierce:1 Skull:1（計 20）
          // Pierce は強力なので希少に、Skull は罠なので少量だけ混ぜる
          const r = randBelow(rng, 20);
          const kind =
            r < 7
              ? Powerup.Fire
              : r < 13
                ? Powerup.Bomb
                : r < 18
                  ? Powerup.Speed
                  : r < 19
                    ? Powerup.Pierce
                    : Powerup.Skull;
          hiddenItems[i] = kind + 1;
        }
      }
    }
  }

  // 壁すり抜け（レア）: 通常の抽選とは別枠で、アイテムの入っていない
  // ソフトブロックへ確定で 1〜2 個だけ隠す
  const emptySofts: number[] = [];
  for (let i = 0; i < grid.length; i++) {
    if (grid[i] === Tile.Soft && hiddenItems[i] === 0) emptySofts.push(i);
  }
  const wallPassCount = Math.min(
    emptySofts.length,
    WALLPASS_MIN_COUNT + randBelow(rng, WALLPASS_MAX_COUNT - WALLPASS_MIN_COUNT + 1),
  );
  for (let n = 0; n < wallPassCount; n++) {
    const j = randBelow(rng, emptySofts.length);
    const cell = emptySofts.splice(j, 1)[0]!;
    hiddenItems[cell] = Powerup.WallPass + 1;
  }

  // パンチグローブ（レア）: 壁すり抜けと同じく別枠で確定 1〜2 個
  const punchCount = Math.min(
    emptySofts.length,
    PUNCH_MIN_COUNT + randBelow(rng, PUNCH_MAX_COUNT - PUNCH_MIN_COUNT + 1),
  );
  for (let n = 0; n < punchCount; n++) {
    const j = randBelow(rng, emptySofts.length);
    const cell = emptySofts.splice(j, 1)[0]!;
    hiddenItems[cell] = Powerup.Punch + 1;
  }

  return { grid, hiddenItems };
}
