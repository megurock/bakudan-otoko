// 実際の生成マップ上で、報告された操作手順をそのまま再現するシナリオテスト。
// 単体テストが人工的なマップを使うのに対し、こちらは createMap の出力で検証する。

import { describe, expect, it } from "vitest";
import { HALF_TILE, MAP_H, MAP_W, PLAYER_HALF, SUB } from "./constants";
import { createMap, idx, tileAt } from "./map";
import { touchingSoftWall } from "./movement";
import { createInitialState, stepGame } from "./step";
import { Key, Powerup, Tile, type GameState } from "./types";

const SLOTS = [0, 1];

function inputs(map: Record<number, number>): number[] {
  const arr = [0, 0, 0, 0, 0, 0];
  for (const [slot, keys] of Object.entries(map)) arr[Number(slot)] = keys;
  return arr;
}

/** 実マップを使った playing 状態を作る */
function realState(seed: number): GameState {
  const state = createInitialState(seed, SLOTS);
  state.phase = "playing";
  return state;
}

describe("wall pass scenario (実マップ)", () => {
  it("生成マップには必ず壁すり抜けが埋まっており、周囲は壊せるブロックである", () => {
    for (let seed = 0; seed < 20; seed++) {
      const { grid, hiddenItems } = createMap({ seed }, SLOTS);
      const found: number[] = [];
      for (let i = 0; i < hiddenItems.length; i++) {
        if (hiddenItems[i] === Powerup.WallPass + 1) found.push(i);
      }
      expect(found.length).toBeGreaterThanOrEqual(1);
      for (const i of found) expect(grid[i]).toBe(Tile.Soft);
    }
  });

  it("報告手順の再現: 潜る → 半歩出る → 戻る、を繰り返しても破綻しない", () => {
    // 縦に並んだブロック帯を用意し、その中で往復・上下移動を試す
    const state = realState(7);
    state.grid.fill(Tile.Floor);
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (cx === 0 || cy === 0 || cx === MAP_W - 1 || cy === MAP_H - 1) {
          state.grid[idx(cx, cy)] = Tile.Hard;
        }
      }
    }
    // (4,2)(4,3)(4,4) を壁にする（上下に動ける壁帯）
    state.grid[idx(4, 2)] = Tile.Soft;
    state.grid[idx(4, 3)] = Tile.Soft;
    state.grid[idx(4, 4)] = Tile.Soft;

    const p = state.players[0]!;
    p.x = 3 * SUB + HALF_TILE;
    p.y = 3 * SUB + HALF_TILE;
    p.wallPass = 1;

    // 1. 壁に潜る
    for (let i = 0; i < 6; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(true);
    expect(p.wallPass).toBe(1);

    // 2. 壁の中で上下に動ける（報告 4 の確認）
    const yBefore = p.y;
    for (let i = 0; i < 4; i++) stepGame(state, inputs({ 0: Key.Up }));
    expect(p.y).toBeLessThan(yBefore);
    for (let i = 0; i < 8; i++) stepGame(state, inputs({ 0: Key.Down }));
    expect(p.y).toBeGreaterThan(yBefore);
    // 縦に動いても壁の中にいる限り効力は残る
    expect(p.wallPass).toBe(1);

    // 3. 半歩出て戻るを繰り返す（報告 2〜3 の確認）
    for (let i = 0; i < 6; i++) stepGame(state, inputs({ 0: Key.Up })); // 帯の中央へ戻す
    for (let n = 0; n < 4; n++) {
      for (let i = 0; i < 3; i++) stepGame(state, inputs({ 0: Key.Right }));
      for (let i = 0; i < 3; i++) stepGame(state, inputs({ 0: Key.Left }));
    }
    // 往復しても壁の中に留まれているだけで、効力は消えも増えもしない
    expect(p.wallPass).toBe(1);

    // 4. 完全に抜けきると効力が切れ、二度と入れない
    for (let i = 0; i < 20; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(false);
    expect(p.wallPass).toBe(0);
    for (let i = 0; i < 30; i++) stepGame(state, inputs({ 0: Key.Left }));
    // 壁 (4,3) の右面にぴったり接して停止する（中へは戻れない）
    expect(p.x).toBe(5 * SUB + PLAYER_HALF);
    expect(touchingSoftWall(state.grid, p)).toBe(false);
    expect(tileAt(state.grid, 4, 3)).toBe(Tile.Soft); // 壁は壊れていない
  });

  it("半透明が解ける瞬間と効力が切れる瞬間が一致する", () => {
    // 半透明表示は snap の inSoftWall（= touchingSoftWall）で描くので、
    // この2つが同じ tick で切り替わることを保証する。
    // ズレると「透明が解けたのにまだ壁を通れる」状態が生まれる。
    const state = realState(11);
    state.grid.fill(Tile.Floor);
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (cx === 0 || cy === 0 || cx === MAP_W - 1 || cy === MAP_H - 1) {
          state.grid[idx(cx, cy)] = Tile.Hard;
        }
      }
    }
    state.grid[idx(4, 3)] = Tile.Soft;

    const p = state.players[0]!;
    p.x = 3 * SUB + HALF_TILE;
    p.y = 3 * SUB + HALF_TILE;
    p.wallPass = 1;

    let sawInside = false;
    for (let i = 0; i < 24; i++) {
      stepGame(state, inputs({ 0: Key.Right }));
      const touching = touchingSoftWall(state.grid, p);
      // 表示に使う inSoftWall と、実際の接触判定が常に一致している
      expect(p.inSoftWall).toBe(touching);
      if (touching) {
        sawInside = true;
        // 壁に触れている間は効力が残っている
        expect(p.wallPass).toBe(1);
      } else if (sawInside) {
        // 触れなくなった＝半透明が解けた時点で、効力も失われている
        expect(p.wallPass).toBe(0);
      }
    }
    expect(sawInside).toBe(true);
  });

  it("壁の中で効力が切れても、進行方向へ抜け出せる（閉じ込めなし）", () => {
    const state = realState(3);
    state.grid.fill(Tile.Floor);
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (cx === 0 || cy === 0 || cx === MAP_W - 1 || cy === MAP_H - 1) {
          state.grid[idx(cx, cy)] = Tile.Hard;
        }
      }
    }
    state.grid[idx(4, 3)] = Tile.Soft;
    const p = state.players[0]!;
    p.x = 4 * SUB + HALF_TILE;
    p.y = 3 * SUB + HALF_TILE;
    p.wallPass = 0; // 壁の中でチャージ切れの状況
    p.inSoftWall = true;

    // 壁を出るまで進めれば十分（出たあとも自由に動ける）
    for (let i = 0; i < 8; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(false);
    expect(Math.floor(p.x / SUB)).toBeGreaterThanOrEqual(5);
  });
});
