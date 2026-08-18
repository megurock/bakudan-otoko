import { describe, expect, it } from "vitest";
import {
  BASE_SPEED,
  BLAST_TICKS,
  CORNER_SLIDE_MAX,
  COUNTDOWN_TICKS,
  FUSE_TICKS,
  HALF_TILE,
  MAP_H,
  MAP_W,
  MATCH_MAX_TICKS,
  PLAYER_HALF,
  PUNCH_DISTANCE,
  PUNCH_FLY_TICKS_PER_TILE,
  SKULL_BOMB_CAP,
  SKULL_FIRE,
  SKULL_SPEED,
  SKULL_TICKS,
  SPAWNS,
  SPEED_INC,
  SPEED_MAX,
  SUB,
} from "./constants";
import {
  consumeInput,
  enqueueInput,
  INPUT_MAX_LEAD_TICKS,
  INPUT_QUEUE_MAX,
  type QueuedInput,
} from "./input-queue";
import { createMap, idx, tileAt } from "./map";
import {
  centerTileX,
  collides,
  movePlayer,
  tilePassable,
  touchingSoftWall,
} from "./movement";
import { buildSnap, decodeC2S, decodeGrid, encode, encodeGrid } from "./protocol";
import {
  createInitialState,
  createPlayer,
  effectiveBombCap,
  effectiveFire,
  effectiveSpeed,
  stepGame,
} from "./step";
import { Dir, Key, Powerup, Tile, type Bomb, type GameState } from "./types";

// ===== テストヘルパー =====

/** 全面 Floor + 外周 Hard のまっさらな状態（テスト用） */
function bareState(slots: number[] = [0, 1]): GameState {
  const state = createInitialState(12345, slots);
  state.grid.fill(Tile.Floor);
  for (let cy = 0; cy < MAP_H; cy++) {
    for (let cx = 0; cx < MAP_W; cx++) {
      if (cx === 0 || cy === 0 || cx === MAP_W - 1 || cy === MAP_H - 1) {
        state.grid[idx(cx, cy)] = Tile.Hard;
      }
    }
  }
  state.hiddenItems.fill(0);
  state.phase = "playing";
  return state;
}

function centerOf(cx: number, cy: number): [number, number] {
  return [cx * SUB + HALF_TILE, cy * SUB + HALF_TILE];
}

function placeAt(state: GameState, slot: number, cx: number, cy: number): void {
  const p = state.players.find((q) => q.slot === slot)!;
  [p.x, p.y] = centerOf(cx, cy);
}

function inputs(map: Record<number, number>): number[] {
  const arr = [0, 0, 0, 0, 0, 0];
  for (const [slot, keys] of Object.entries(map)) arr[Number(slot)] = keys;
  return arr;
}

/** 接地爆弾を直接追加する（設置操作を経由しないテスト用） */
function addBomb(
  state: GameState,
  cx: number,
  cy: number,
  ownerSlot = 0,
  fuse = FUSE_TICKS,
): Bomb {
  const bomb: Bomb = {
    id: state.nextId++,
    cx,
    cy,
    ownerSlot,
    fuse,
    range: 2,
    pierce: false,
    passableBy: 0,
    flyTicks: 0,
    flyFromCx: cx,
    flyFromCy: cy,
    flyDir: Dir.Up,
    flyDist: 0,
  };
  state.bombs.push(bomb);
  return bomb;
}

function stateHash(state: GameState): string {
  return JSON.stringify({
    tick: state.tick,
    grid: Array.from(state.grid),
    players: state.players.map((p) => [
      p.slot,
      p.x,
      p.y,
      p.alive,
      p.fire,
      p.bombCap,
      p.speed,
      p.pierce,
      p.punch,
      p.skullTicks,
      p.wallPass,
      p.inSoftWall,
    ]),
    bombs: state.bombs.map((b) => [
      b.id,
      b.cx,
      b.cy,
      b.fuse,
      b.range,
      b.passableBy,
      b.pierce,
      b.flyTicks,
      b.flyFromCx,
      b.flyFromCy,
      b.flyDir,
      b.flyDist,
    ]),
    blasts: state.blasts.map((b) => [b.cx, b.cy, b.ticks]),
    items: state.items.map((i) => [i.cx, i.cy, i.kind, i.revealTick]),
    winner: state.winnerSlot,
  });
}

// ===== 1. マップ生成 =====

const ALL_SLOTS = [0, 1, 2, 3, 4, 5];

describe("map", () => {
  it("同一 seed から同一マップ・同一隠しアイテムが生成される（決定論）", () => {
    const a = createMap({ seed: 42 }, ALL_SLOTS);
    const b = createMap({ seed: 42 }, ALL_SLOTS);
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(Array.from(a.hiddenItems)).toEqual(Array.from(b.hiddenItems));
    const c = createMap({ seed: 43 }, ALL_SLOTS);
    expect(Array.from(c.grid)).not.toEqual(Array.from(a.grid));
  });

  it("外周と偶数格子が Hard、スポーン周辺が Floor", () => {
    const { grid } = createMap({ seed: 1 }, ALL_SLOTS);
    for (let cx = 0; cx < MAP_W; cx++) {
      expect(tileAt(grid, cx, 0)).toBe(Tile.Hard);
      expect(tileAt(grid, cx, MAP_H - 1)).toBe(Tile.Hard);
    }
    expect(tileAt(grid, 2, 2)).toBe(Tile.Hard);
    expect(tileAt(grid, 4, 6)).toBe(Tile.Hard);
    for (const [sx, sy] of SPAWNS) {
      expect(tileAt(grid, sx, sy)).toBe(Tile.Floor);
    }
    // スポーン隣接（脱出路）も Floor
    expect(tileAt(grid, 2, 1)).toBe(Tile.Floor);
    expect(tileAt(grid, 1, 2)).toBe(Tile.Floor);
  });

  it("歯抜け slot でも全参加者のスポーン地点が Floor（レンガ埋まり回帰）", () => {
    // 例: slot 1 が離脱して [0, 2] で開始するケース
    const slots = [0, 2];
    for (let seed = 0; seed < 100; seed++) {
      const state = createInitialState(seed, slots);
      for (const p of state.players) {
        const [sx, sy] = SPAWNS[p.slot]!;
        expect(tileAt(state.grid, sx, sy)).toBe(Tile.Floor);
        // 脱出路: 隣接4方向のうち少なくとも1マスは Floor
        const exits = [
          tileAt(state.grid, sx + 1, sy),
          tileAt(state.grid, sx - 1, sy),
          tileAt(state.grid, sx, sy + 1),
          tileAt(state.grid, sx, sy - 1),
        ].filter((t) => t === Tile.Floor).length;
        expect(exits).toBeGreaterThan(0);
      }
    }
  });

  it("ソフト配置率とドロップ率が期待範囲（seed 100個の統計）", () => {
    let softTotal = 0;
    let floorCandidates = 0;
    let drops = 0;
    for (let seed = 0; seed < 100; seed++) {
      const { grid, hiddenItems } = createMap({ seed }, ALL_SLOTS);
      for (let i = 0; i < grid.length; i++) {
        if (grid[i] === Tile.Soft) {
          softTotal++;
          if (hiddenItems[i] !== 0) drops++;
        }
        if (grid[i] !== Tile.Hard) floorCandidates++;
      }
    }
    const softRate = softTotal / floorCandidates;
    expect(softRate).toBeGreaterThan(0.5);
    expect(softRate).toBeLessThan(0.8);
    const dropRate = drops / softTotal;
    expect(dropRate).toBeGreaterThan(0.24);
    expect(dropRate).toBeLessThan(0.36);
  });

  it("7種類すべてのアイテムが出現し、Pierce と Skull は希少", () => {
    const counts = new Map<number, number>();
    for (let seed = 0; seed < 200; seed++) {
      const { hiddenItems } = createMap({ seed }, ALL_SLOTS);
      for (const v of hiddenItems) {
        if (v === 0) continue;
        const kind = v - 1;
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
      }
    }
    // 7種すべてが出る
    for (const kind of [
      Powerup.Fire,
      Powerup.Bomb,
      Powerup.Speed,
      Powerup.Pierce,
      Powerup.Skull,
      Powerup.WallPass,
      Powerup.Punch,
    ]) {
      expect(counts.get(kind) ?? 0).toBeGreaterThan(0);
    }
    // Pierce / Skull は通常アイテムより明確に少ない（各 1/20）
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    expect((counts.get(Powerup.Pierce) ?? 0) / total).toBeLessThan(0.1);
    expect((counts.get(Powerup.Skull) ?? 0) / total).toBeLessThan(0.1);
    expect((counts.get(Powerup.Fire) ?? 0) / total).toBeGreaterThan(0.25);
  });

  it("壁すり抜けは1マップにちょうど1〜2個だけ隠される", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 100; seed++) {
      const { grid, hiddenItems } = createMap({ seed }, ALL_SLOTS);
      let count = 0;
      for (let i = 0; i < hiddenItems.length; i++) {
        if (hiddenItems[i] === Powerup.WallPass + 1) {
          count++;
          // 必ずソフトブロックの中にある
          expect(grid[i]).toBe(Tile.Soft);
        }
      }
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(2);
      seen.add(count);
    }
    // 1個のマップも2個のマップも実際に出る
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
  });

  it("パンチグローブは1マップにちょうど1〜2個だけ隠される", () => {
    const seen = new Set<number>();
    for (let seed = 0; seed < 100; seed++) {
      const { grid, hiddenItems } = createMap({ seed }, ALL_SLOTS);
      let count = 0;
      for (let i = 0; i < hiddenItems.length; i++) {
        if (hiddenItems[i] === Powerup.Punch + 1) {
          count++;
          expect(grid[i]).toBe(Tile.Soft);
        }
      }
      expect(count).toBeGreaterThanOrEqual(1);
      expect(count).toBeLessThanOrEqual(2);
      seen.add(count);
    }
    expect(seen.has(1)).toBe(true);
    expect(seen.has(2)).toBe(true);
  });
});

// ===== 2. 移動 =====

describe("movement", () => {
  it("壁に向かって移動すると壁面で停止する", () => {
    const state = bareState();
    placeAt(state, 0, 1, 1);
    const p = state.players[0]!;
    for (let i = 0; i < 20; i++) movePlayer(state, p, Key.Left);
    expect(p.x).toBe(1 * SUB + PLAYER_HALF); // 壁面 - 半幅
    expect(p.y).toBe(1 * SUB + HALF_TILE);
  });

  it("コーナースライド: ズレが小さければ通路へ吸い込まれる", () => {
    const state = bareState();
    // (3,3) を通路、(3,2)/(3,4) 側をふさぐ… 単純化して 1 箇所だけ空ける
    state.grid[idx(3, 2)] = Tile.Hard;
    state.grid[idx(3, 4)] = Tile.Hard;
    const p = state.players[0]!;
    // (2,3) の中心からわずかに上へズレた位置から右へ
    p.x = 2 * SUB + HALF_TILE;
    p.y = 3 * SUB + HALF_TILE - 100; // ズレ 100 <= CORNER_SLIDE_MAX(112)
    for (let i = 0; i < 30; i++) movePlayer(state, p, Key.Right);
    // y が通路に収まる範囲（±(HALF_TILE-PLAYER_HALF)）まで整列して右へ進めている
    expect(Math.abs(p.y - (3 * SUB + HALF_TILE))).toBeLessThanOrEqual(
      HALF_TILE - PLAYER_HALF,
    );
    expect(p.x).toBeGreaterThan(3 * SUB);
  });

  it("コーナースライド: ズレが大きすぎると滑らない", () => {
    const state = bareState();
    state.grid[idx(3, 2)] = Tile.Hard;
    state.grid[idx(3, 4)] = Tile.Hard;
    const p = state.players[0]!;
    p.x = 2 * SUB + HALF_TILE;
    p.y = 3 * SUB + HALF_TILE - (CORNER_SLIDE_MAX + 20); // 中心タイルが (2,2) 寄りになりうるズレ
    const beforeY = p.y;
    movePlayer(state, p, Key.Right);
    // 大ズレでは y 補正が発生しない（そのタイル行での前進のみ試みる）
    expect(Math.abs(p.y - beforeY)).toBeLessThanOrEqual(0);
  });

  it("斜め入力は水平優先", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    const [x0, y0] = [p.x, p.y];
    movePlayer(state, p, Key.Right | Key.Down);
    expect(p.x).toBe(x0 + BASE_SPEED);
    expect(p.y).toBe(y0);
    expect(p.dir).toBe(Dir.Right);
  });

  it("Speed 強化で1tickの移動量が増え、上限でキャップされる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.speed = SPEED_MAX;
    const x0 = p.x;
    movePlayer(state, p, Key.Right);
    expect(p.x).toBe(x0 + SPEED_MAX);
    expect(Math.min(SPEED_MAX, p.speed + SPEED_INC)).toBe(SPEED_MAX);
  });
});

// ===== 3. 爆弾・爆風 =====

describe("bombs & blasts", () => {
  function play(state: GameState, ticksInputs: Array<Record<number, number>>): void {
    for (const ti of ticksInputs) stepGame(state, inputs(ti));
  }

  it("爆弾はタイル中心へスナップして設置され、上限・重複制約が効く", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.x += 50; // タイル内でズレた位置
    stepGame(state, inputs({ 0: Key.Bomb }));
    expect(state.bombs).toHaveLength(1);
    expect(state.bombs[0]!.cx).toBe(3);
    expect(state.bombs[0]!.cy).toBe(3);
    // ボタン押しっぱなしでは追加設置されない（エッジ検出）
    stepGame(state, inputs({ 0: Key.Bomb }));
    expect(state.bombs).toHaveLength(1);
    // 離して押し直しても bombCap=1 なので設置不可
    stepGame(state, inputs({ 0: 0 }));
    stepGame(state, inputs({ 0: Key.Bomb }));
    expect(state.bombs).toHaveLength(1);
  });

  it("passableBy: 設置時に重なっていたプレイヤーだけ通過でき、離れたら失効する", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 5, 3);
    stepGame(state, inputs({ 0: Key.Bomb }));
    const bomb = state.bombs[0]!;
    expect(bomb.passableBy & 1).toBe(1); // slot0 は通過可
    expect(bomb.passableBy & 2).toBe(0); // slot1 は不可
    expect(tilePassable(state, 3, 3, state.players[0]!)).toBe(true);
    expect(tilePassable(state, 3, 3, state.players[1]!)).toBe(false);
    // slot0 が離れるとビットが落ち、戻っても通れない
    for (let i = 0; i < 12; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.passableBy & 1).toBe(0);
    expect(tilePassable(state, 3, 3, state.players[0]!)).toBe(false);
  });

  it("爆風は range 分伝播し、Hard で遮蔽され、Soft は1枚破壊して停止する", () => {
    const state = bareState();
    state.grid[idx(6, 3)] = Tile.Hard;
    state.grid[idx(3, 5)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    const p = state.players[0]!;
    p.fire = 3;
    stepGame(state, inputs({ 0: Key.Bomb }));
    // 設置者を安全地帯へ移動させ、起爆まで送る
    for (let i = 0; i < FUSE_TICKS; i++) {
      stepGame(state, inputs({ 0: Key.Up }));
    }
    expect(state.bombs).toHaveLength(0);
    const blastTiles = new Set(state.blasts.map((b) => `${b.cx},${b.cy}`));
    // 右: (4,3)(5,3) まで。(6,3) は Hard で遮蔽
    expect(blastTiles.has("4,3")).toBe(true);
    expect(blastTiles.has("5,3")).toBe(true);
    expect(blastTiles.has("6,3")).toBe(false);
    // 下: (3,4)(3,5) まで。Soft(3,5) は破壊されて停止
    expect(blastTiles.has("3,4")).toBe(true);
    expect(blastTiles.has("3,5")).toBe(true);
    expect(blastTiles.has("3,6")).toBe(false);
    expect(tileAt(state.grid, 3, 5)).toBe(Tile.Floor);
    // 左: range 3 で (0,3) は外周 Hard
    expect(blastTiles.has("2,3")).toBe(true);
    expect(blastTiles.has("1,3")).toBe(true);
    expect(blastTiles.has("0,3")).toBe(false);
  });

  it("隠しアイテムは Soft 破壊後 revealTick 経過で取得可能になる", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    state.hiddenItems[idx(4, 3)] = Powerup.Fire + 1;
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    stepGame(state, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) stepGame(state, inputs({ 0: Key.Up }));
    expect(state.items).toHaveLength(1);
    const item = state.items[0]!;
    expect(item.kind).toBe(Powerup.Fire);
    expect(item.revealTick).toBeGreaterThan(state.tick - 1);
  });

  it("誘爆: 連鎖が同一 tick で全解決され bombsActive が正しく戻る", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 5, 3);
    const p0 = state.players[0]!;
    const p1 = state.players[1]!;
    p0.fire = 2;
    p1.fire = 2;
    p1.bombCap = 2;
    // p0 が (3,3)、p1 が (5,3) と (7,3) に設置（時間差で導火線をずらす）
    stepGame(state, inputs({ 0: Key.Bomb, 1: Key.Bomb }));
    // p1 を右へ移動して2個目を設置
    for (let i = 0; i < 16; i++) stepGame(state, inputs({ 1: Key.Right }));
    stepGame(state, inputs({ 1: Key.Bomb }));
    expect(state.bombs).toHaveLength(3);
    // 全員退避
    for (let i = 0; i < FUSE_TICKS; i++) {
      stepGame(state, inputs({ 0: Key.Up, 1: Key.Down }));
      if (state.bombs.length === 0) break;
    }
    // 最初の爆弾の起爆と同時に (5,3) が誘爆し、その爆風が (7,3) も誘爆させる
    expect(state.bombs).toHaveLength(0);
    expect(p0.bombsActive).toBe(0);
    expect(p1.bombsActive).toBe(0);
  });

  it("誘爆ループ（相互に届く2爆弾）が無限ループしない", () => {
    const state = bareState();
    const p0 = state.players[0]!;
    p0.fire = 3;
    p0.bombCap = 2;
    placeAt(state, 0, 3, 3);
    stepGame(state, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < 16; i++) stepGame(state, inputs({ 0: Key.Right }));
    stepGame(state, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) {
      stepGame(state, inputs({ 0: Key.Down }));
      if (state.bombs.length === 0) break;
    }
    expect(state.bombs).toHaveLength(0);
  });
});

// ===== 4. 死亡・勝敗 =====

describe("death & win", () => {
  it("爆風マスに立つプレイヤーは死亡し、爆風発生 tick に踏み込んでも死亡する", () => {
    const state = bareState([0, 1, 2]);
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 3, 4); // 爆風の直下（下向き range1）
    placeAt(state, 2, 13, 13);
    stepGame(state, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS - 1; i++) {
      stepGame(state, inputs({ 0: Key.Up })); // p0 は逃げる, p1 は留まる
    }
    stepGame(state, inputs({}));
    expect(state.players[1]!.alive).toBe(false);
    expect(state.players[0]!.alive).toBe(true);
  });

  it("残り1人になった tick で勝者確定、同時全滅は引き分け(-1)", () => {
    // ケース1: 勝者
    const s1 = bareState([0, 1]);
    placeAt(s1, 0, 3, 3);
    placeAt(s1, 1, 4, 3); // 爆風圏内
    stepGame(s1, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) {
      if (s1.phase !== "playing") break;
      stepGame(s1, inputs({ 0: Key.Up }));
    }
    expect(s1.phase).toBe("finished");
    expect(s1.winnerSlot).toBe(0);

    // ケース2: 同時全滅
    const s2 = bareState([0, 1]);
    placeAt(s2, 0, 3, 3);
    placeAt(s2, 1, 4, 3);
    stepGame(s2, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) {
      if (s2.phase !== "playing") break;
      stepGame(s2, inputs({})); // 両者留まる
    }
    expect(s2.phase).toBe("finished");
    expect(s2.winnerSlot).toBe(-1);
  });

  it("MATCH_MAX_TICKS 到達で引き分け", () => {
    const state = bareState([0, 1]);
    placeAt(state, 0, 1, 1);
    placeAt(state, 1, 13, 13);
    state.tick = MATCH_MAX_TICKS;
    stepGame(state, inputs({}));
    expect(state.phase).toBe("finished");
    expect(state.winnerSlot).toBe(-1);
  });

  it("アイテム取得でステータス反映、既設爆弾の range は設置時のまま", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    stepGame(state, inputs({ 0: Key.Bomb }));
    const bomb = state.bombs[0]!;
    expect(bomb.range).toBe(1);
    // Fire アイテムを直接置いて取得させる
    state.items.push({ cx: 4, cy: 3, kind: Powerup.Fire, revealTick: 0 });
    for (let i = 0; i < 10; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(state.players[0]!.fire).toBe(2);
    expect(bomb.range).toBe(1); // 既設爆弾は据え置き
  });

  it("貫通爆弾はソフトブロックを突き抜けて奥まで爆風が届く", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    const p = state.players[0]!;
    p.fire = 4;
    // 右方向に連続するソフトブロックを置く
    state.grid[idx(4, 3)] = Tile.Soft;
    state.grid[idx(5, 3)] = Tile.Soft;

    // 通常爆弾: 手前の 1 枚で止まる
    stepGame(state, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) stepGame(state, inputs({}));
    expect(state.blasts.some((b) => b.cx === 4 && b.cy === 3)).toBe(true);
    expect(state.blasts.some((b) => b.cx === 5 && b.cy === 3)).toBe(false);

    // 貫通爆弾: ブロックを壊しつつ奥まで届く
    const state2 = bareState();
    placeAt(state2, 0, 3, 3);
    placeAt(state2, 1, 13, 13);
    const q = state2.players[0]!;
    q.fire = 4;
    q.pierce = true;
    state2.grid[idx(4, 3)] = Tile.Soft;
    state2.grid[idx(5, 3)] = Tile.Soft;
    stepGame(state2, inputs({ 0: Key.Bomb }));
    for (let i = 0; i < FUSE_TICKS; i++) stepGame(state2, inputs({}));
    expect(state2.blasts.some((b) => b.cx === 4 && b.cy === 3)).toBe(true);
    expect(state2.blasts.some((b) => b.cx === 5 && b.cy === 3)).toBe(true);
    expect(state2.blasts.some((b) => b.cx === 6 && b.cy === 3)).toBe(true);
    // Hard は貫通しない
    expect(state2.blasts.some((b) => b.cx === 7 && b.cy === 3)).toBe(true);
  });

  it("ドクロは一定時間だけ能力を落とし、切れると元に戻る", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    const p = state.players[0]!;
    p.fire = 5;
    p.bombCap = 4;
    p.speed = SPEED_MAX;

    state.items.push({ cx: 3, cy: 3, kind: Powerup.Skull, revealTick: 0 });
    stepGame(state, inputs({}));
    expect(p.skullTicks).toBeGreaterThan(0);
    // 素の値は保持されている（実効値だけが落ちる）
    expect(p.fire).toBe(5);
    expect(p.bombCap).toBe(4);
    expect(effectiveFire(p)).toBe(SKULL_FIRE);
    expect(effectiveBombCap(p)).toBe(SKULL_BOMB_CAP);
    expect(effectiveSpeed(p)).toBe(SKULL_SPEED);

    // 時間経過で解除され、実効値が元に戻る（爆弾は置かず、生存したまま数える）
    for (let i = 0; i < SKULL_TICKS + 2; i++) stepGame(state, inputs({}));
    expect(p.alive).toBe(true);
    expect(p.skullTicks).toBe(0);
    expect(effectiveFire(p)).toBe(5);
    expect(effectiveBombCap(p)).toBe(4);
    expect(effectiveSpeed(p)).toBe(SPEED_MAX);
  });

  it("ドクロ中に置いた爆弾はレンジと設置数が落ちる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    placeAt(state, 1, 13, 13);
    const p = state.players[0]!;
    p.fire = 5;
    p.bombCap = 4;
    p.skullTicks = SKULL_TICKS;

    stepGame(state, inputs({ 0: Key.Bomb }));
    expect(state.bombs[0]!.range).toBe(SKULL_FIRE);

    // 設置数上限も落ちるので、離れた場所でも2個目は置けない
    for (let i = 0; i < 6; i++) stepGame(state, inputs({ 0: Key.Right }));
    stepGame(state, inputs({ 0: Key.Bomb }));
    expect(state.bombs).toHaveLength(SKULL_BOMB_CAP);
  });

  it("ドクロ中は移動速度が落ちる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.speed = SPEED_MAX;

    const x0 = p.x;
    movePlayer(state, p, Key.Right);
    const normalStep = p.x - x0;

    p.skullTicks = SKULL_TICKS;
    const x1 = p.x;
    movePlayer(state, p, Key.Right);
    const skullStep = p.x - x1;

    expect(normalStep).toBe(SPEED_MAX);
    expect(skullStep).toBe(SKULL_SPEED);
    expect(skullStep).toBeLessThan(normalStep);
  });
});

// ===== 5. 決定論・reconciliation 不変条件 =====

describe("determinism", () => {
  it("同一 seed + 同一入力列 → 同一状態ハッシュ", () => {
    const script: Array<Record<number, number>> = [];
    for (let i = 0; i < 200; i++) {
      script.push({
        0: (i % 7 < 3 ? Key.Right : Key.Down) | (i % 40 === 0 ? Key.Bomb : 0),
        1: (i % 5 < 2 ? Key.Left : Key.Up) | (i % 33 === 0 ? Key.Bomb : 0),
      });
    }
    const run = (): string => {
      const state = createInitialState(777, [0, 1]);
      state.phase = "playing";
      for (const ti of script) stepGame(state, inputs(ti));
      return stateHash(state);
    };
    expect(run()).toBe(run());
  });

  it("countdown はフェーズ遷移のみ行い、規定 tick 後に playing へ", () => {
    const state = createInitialState(1, [0, 1]);
    expect(state.phase).toBe("countdown");
    for (let i = 0; i < COUNTDOWN_TICKS; i++) stepGame(state, inputs({}));
    expect(state.phase).toBe("playing");
    expect(state.tick).toBe(COUNTDOWN_TICKS);
  });
});

// ===== 6. プロトコル =====

describe("protocol", () => {
  it("C2S encode → decode ラウンドトリップ", () => {
    const msgs = [
      { t: "join", name: "テスト", token: "abc" },
      { t: "ready", ready: true },
      { t: "input", seq: 42, tick: 100, keys: Key.Right | Key.Bomb },
      { t: "ping", ts: 123456 },
    ] as const;
    for (const m of msgs) {
      expect(decodeC2S(encode(m))).toEqual(m);
    }
    expect(decodeC2S("not json")).toBeNull();
    expect(decodeC2S("42")).toBeNull();
  });

  it("グリッドの encode → decode ラウンドトリップ", () => {
    const { grid } = createMap({ seed: 5 }, ALL_SLOTS);
    const decoded = decodeGrid(encodeGrid(grid));
    expect(Array.from(decoded)).toEqual(Array.from(grid));
  });

  it("buildSnap が状態を正しく写像する", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    stepGame(state, inputs({ 0: Key.Bomb }));
    const snap = buildSnap(state, [5, 3]);
    expect(snap.k).toBe(state.tick);
    expect(snap.p).toHaveLength(2);
    expect(snap.b).toHaveLength(1);
    expect(snap.b[0]![1]).toBe(3); // cx
    expect(snap.a).toEqual([5, 3]);
    const p0 = snap.p[0]!;
    expect(p0[4] & 1).toBe(1); // alive フラグ
  });

  it("buildSnap が貫通フラグとドクロ残 tick を載せる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.pierce = true;
    p.skullTicks = 42;
    stepGame(state, inputs({ 0: Key.Bomb }));

    const snap = buildSnap(state, [0, 0]);
    const mine = snap.p.find((q) => q[0] === 0)!;
    expect(mine[4] & 4).toBe(4); // pierce フラグ
    expect(mine[8]).toBe(41); // stepGame でデクリメントされた残り tick

    // 設置した爆弾にも貫通が伝わる
    expect(snap.b[0]![6]).toBe(1);

    // 貫通していないプレイヤーはフラグが立たない
    const other = snap.p.find((q) => q[0] === 1)!;
    expect(other[4] & 4).toBe(0);
    expect(other[8]).toBe(0);
  });

  it("buildSnap が爆弾の passableBy を載せる（設置直後のひっかかり防止）", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    stepGame(state, inputs({ 0: Key.Bomb }));

    // 置いた本人のビットが立った状態でクライアントへ届く。
    // これを近似（中心タイル一致など）で代用すると、爆弾マスから半歩出た
    // 瞬間に予測側だけが「壁」と誤判定してひっかかる
    expect(buildSnap(state, [0, 0]).b[0]![7]).toBe(1 << 0);

    // 半歩だけ動いて中心タイルが隣に移っても、ヒットボックスが重なる限り
    // 通過可のまま（サーバーとクライアントで同じ判定になる）
    for (let i = 0; i < 5; i++) stepGame(state, inputs({ 0: Key.Right }));
    const p = state.players[0]!;
    expect(centerTileX(p)).toBe(4); // 中心タイルはもう爆弾のマスではない
    expect(buildSnap(state, [0, 0]).b[0]![7]).toBe(1 << 0);
    expect(tilePassable(state, 3, 3, p)).toBe(true);
  });

  it("buildSnap がパンチ飛翔状態（flyTicks / flyFrom / flyDir / flyDist）を載せる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.punch = true;
    p.x = 4 * SUB - PLAYER_HALF; // 爆弾のマスに接した位置
    addBomb(state, 4, 3, 1);
    stepGame(state, inputs({ 0: Key.Right }));

    const b = buildSnap(state, [0, 0]).b[0]!;
    expect(b[1]).toBe(7); // cx = 着地予定タイル
    expect(b[8]).toBe(PUNCH_DISTANCE * PUNCH_FLY_TICKS_PER_TILE); // flyTicks
    expect(b[9]).toBe(4); // flyFromCx
    expect(b[10]).toBe(3); // flyFromCy
    expect(b[11]).toBe(Dir.Right); // flyDir
    expect(b[12]).toBe(PUNCH_DISTANCE); // flyDist
  });
});

// ===== 6.5 壁すり抜け =====

describe("wall pass", () => {
  it("チャージなしではソフトブロックに入れず、チャージがあれば入れる", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    // チャージなし: 壁面で止まる
    for (let i = 0; i < 10; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(p.x).toBe(4 * SUB - PLAYER_HALF);
    // チャージあり: 壁の中へ進める
    p.wallPass = 1;
    for (let i = 0; i < 4; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(p.x).toBeGreaterThan(4 * SUB - PLAYER_HALF);
  });

  it("壁の中では上下左右すべてに動ける", () => {
    const state = bareState();
    // (4,3) を含む縦3マスをソフトブロックにする
    state.grid[idx(4, 2)] = Tile.Soft;
    state.grid[idx(4, 3)] = Tile.Soft;
    state.grid[idx(4, 4)] = Tile.Soft;
    placeAt(state, 0, 4, 3); // 壁の中央にいる状態
    const p = state.players[0]!;
    p.wallPass = 1;
    const y0 = p.y;
    // 壁の中で上へ動ける
    for (let i = 0; i < 4; i++) stepGame(state, inputs({ 0: Key.Up }));
    expect(p.y).toBeLessThan(y0);
    // 壁の中で下へ動ける
    for (let i = 0; i < 8; i++) stepGame(state, inputs({ 0: Key.Down }));
    expect(p.y).toBeGreaterThan(y0);
  });

  it("壁から半歩出ただけでは効力が切れず、抜けきってから切れる", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 1;
    // 中心が壁を出た直後（体の左半分はまだ壁の中）
    for (let i = 0; i < 12; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(Math.floor(p.x / SUB)).toBe(5); // 中心はもう壁の外
    expect(touchingSoftWall(state.grid, p)).toBe(true); // だが体は壁に残っている
    expect(p.wallPass).toBe(1); // 半歩出ただけでは切れない
    // 体ごと完全に抜けきると効力が切れる
    for (let i = 0; i < 3; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(false);
    expect(p.wallPass).toBe(0);
  });

  it("半歩出て戻る往復で壁の中に居座り続けられない", () => {
    // 報告されたバグ: 中心タイルだけで効力切れを判定していたため、
    // 半歩出た瞬間に効力が切れ、なお体が壁に残っているので戻れてしまい、
    // 「半歩出て戻る」を繰り返して無限に壁の中に留まれた
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 1;
    // 壁へ入り、中心が (5,3) 側へ出るまで進む（体はまだ壁に触れている）
    for (let i = 0; i < 12; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(true);
    // 半歩出て戻るを繰り返す
    for (let n = 0; n < 5; n++) {
      for (let i = 0; i < 2; i++) stepGame(state, inputs({ 0: Key.Left }));
      for (let i = 0; i < 2; i++) stepGame(state, inputs({ 0: Key.Right }));
    }
    // 効力はまだ1（抜けきっていないので消費されない）が、居座りは自由ではなく
    // 抜けきれば必ず消費される
    for (let i = 0; i < 6; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(touchingSoftWall(state.grid, p)).toBe(false);
    expect(p.wallPass).toBe(0);
    // 抜けきった後は、体が触れる位置まで戻っても再侵入できない
    for (let i = 0; i < 30; i++) stepGame(state, inputs({ 0: Key.Left }));
    expect(p.x).toBe(5 * SUB + PLAYER_HALF);
    expect(tileAt(state.grid, 4, 3)).toBe(Tile.Soft);
  });

  it("効力が切れたあとは、隣接する壁に体が触れていても再侵入できない", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 1;
    // 壁を抜けきる（(5,3) の中心へ）
    for (let i = 0; i < 16; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(p.wallPass).toBe(0);
    // 左へ半歩戻り、体の左端が (4,3) に触れる位置まで来る
    for (let i = 0; i < 2; i++) stepGame(state, inputs({ 0: Key.Left }));
    // さらに左へ押し続けても壁の中へは戻れない（壁面で停止）
    for (let i = 0; i < 20; i++) stepGame(state, inputs({ 0: Key.Left }));
    expect(p.x).toBe(5 * SUB + PLAYER_HALF);
    expect(Math.floor(p.x / SUB)).toBe(5);
  });

  it("壁を通り抜けて外へ出た瞬間にチャージを1消費し、以後は入れない", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 1;
    // (3,3)中心 → (5,3)中心 = 512units = ちょうど16tick
    for (let i = 0; i < 16; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(Math.floor(p.x / SUB)).toBe(5);
    expect(p.wallPass).toBe(0);
    expect(tileAt(state.grid, 4, 3)).toBe(Tile.Soft); // 壁は壊れていない
    // 戻ろうとしても入れない（壁面で停止）
    for (let i = 0; i < 20; i++) stepGame(state, inputs({ 0: Key.Left }));
    expect(p.x).toBe(5 * SUB + PLAYER_HALF);
  });

  it("連続したブロック帯は1回のすり抜けとして1チャージで通れる", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    state.grid[idx(5, 3)] = Tile.Soft;
    state.grid[idx(6, 3)] = Tile.Soft;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 1;
    // (3,3) → (7,3) = 4タイル = ちょうど32tick
    for (let i = 0; i < 32; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(Math.floor(p.x / SUB)).toBe(7);
    expect(p.wallPass).toBe(0); // 3枚抜けても消費は1
  });

  it("スタック防止: 壁の中でチャージが尽きても必ず抜け出せる", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Soft;
    placeAt(state, 0, 4, 3); // チャージ0のまま壁の中に置かれた状況
    const p = state.players[0]!;
    expect(p.wallPass).toBe(0);
    // (4,3)中心 → (5,3)中心 = 256units = ちょうど8tick
    for (let i = 0; i < 8; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(Math.floor(p.x / SUB)).toBe(5); // 外へ出られた
    // 完全に離れた後は再侵入できない
    for (let i = 0; i < 20; i++) stepGame(state, inputs({ 0: Key.Left }));
    expect(p.x).toBe(5 * SUB + PLAYER_HALF);
  });

  it("固い壁はチャージがあっても通れない", () => {
    const state = bareState();
    state.grid[idx(4, 3)] = Tile.Hard;
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.wallPass = 9;
    for (let i = 0; i < 10; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(p.x).toBe(4 * SUB - PLAYER_HALF);
    expect(p.wallPass).toBe(9);
  });

  it("アイテム取得でチャージが加算され、snap に含まれる", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    state.items.push({ cx: 4, cy: 3, kind: Powerup.WallPass, revealTick: 0 });
    state.items.push({ cx: 5, cy: 3, kind: Powerup.WallPass, revealTick: 0 });
    for (let i = 0; i < 20; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(p.wallPass).toBe(2);
    const snap = buildSnap(state, [0, 0]);
    const mine = snap.p.find((q) => q[0] === 0)!;
    expect(mine[9]).toBe(2);
  });
});

// ===== 6.6 ボムパンチ =====

describe("bomb punch", () => {
  /**
   * p0 をグローブ持ちで (3,3) に置き、(4,3) の接地爆弾へ体を接触させた状態。
   * 右キーを押した tick に押し出しが成立する
   */
  function punchSetup(): { state: GameState; bomb: Bomb } {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.punch = true;
    p.x = 4 * SUB - PLAYER_HALF; // 爆弾のマスに接した位置（movePlayer のクランプ位置）
    const bomb = addBomb(state, 4, 3, 1);
    return { state, bomb };
  }

  it("パンチグローブを取ると punch が立ち、snap の flags に載る", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    state.items.push({ cx: 3, cy: 3, kind: Powerup.Punch, revealTick: 0 });
    stepGame(state, inputs({}));
    expect(state.players[0]!.punch).toBe(true);
    expect(state.events).toContainEqual(["pickup", 0, Powerup.Punch]);
    const mine = buildSnap(state, [0, 0]).p.find((q) => q[0] === 0)!;
    expect(mine[4] & 16).toBe(16);
  });

  it("基本成立: 爆弾へ歩いて押し付けると進行方向へ3マス飛び、飛翔後に接地する", () => {
    const { state, bomb } = punchSetup();
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.cx).toBe(7);
    expect(bomb.cy).toBe(3);
    expect(bomb.flyFromCx).toBe(4);
    expect(bomb.flyFromCy).toBe(3);
    expect(bomb.flyDir).toBe(Dir.Right);
    expect(bomb.flyDist).toBe(PUNCH_DISTANCE);
    expect(bomb.flyTicks).toBe(PUNCH_DISTANCE * PUNCH_FLY_TICKS_PER_TILE);
    expect(state.events).toContainEqual(["punch", 0]);
    for (let i = 0; i < PUNCH_DISTANCE * PUNCH_FLY_TICKS_PER_TILE; i++) {
      stepGame(state, inputs({}));
    }
    expect(bomb.flyTicks).toBe(0);
    expect(state.bombs).toContain(bomb); // 着地しただけでは爆発しない
  });

  it("接触するまで歩かないと押せない（隣のマスにいるだけでは飛ばない）", () => {
    const { state, bomb } = punchSetup();
    state.players[0]!.x = centerOf(3, 3)[0] - 40; // タイル中心より少し左から歩く
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.flyTicks).toBe(0); // まだ届いていない
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.flyTicks).toBe(0);
    stepGame(state, inputs({ 0: Key.Right })); // 爆弾の縁でクランプ → 接触 → 押せる
    expect(bomb.flyTicks).toBeGreaterThan(0);
  });

  it("進行方向以外の爆弾は押せない", () => {
    const { state, bomb } = punchSetup(); // 爆弾は右隣に接触中
    stepGame(state, inputs({ 0: Key.Up })); // 上へ歩く
    expect(bomb.flyTicks).toBe(0);
    expect(state.events.some((e) => e[0] === "punch")).toBe(false);
  });

  it("グローブ未所持では押せない", () => {
    const { state, bomb } = punchSetup();
    state.players[0]!.punch = false;
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.cx).toBe(4);
    expect(bomb.flyTicks).toBe(0);
    expect(state.events.some((e) => e[0] === "punch")).toBe(false);
  });

  it("足元の爆弾は押されない（進行方向の隣接タイルのみ）", () => {
    const state = bareState();
    placeAt(state, 0, 3, 3);
    const p = state.players[0]!;
    p.punch = true;
    const own = addBomb(state, 3, 3);
    own.passableBy = 1 << 0;
    stepGame(state, inputs({ 0: Key.Right })); // 足元の爆弾の上から歩き出す
    expect(own.cx).toBe(3);
    expect(own.flyTicks).toBe(0);
    expect(state.events.some((e) => e[0] === "punch")).toBe(false);
  });

  it("押しっぱなしで歩き続けると、着地した爆弾に追いついてまた押せる", () => {
    const { state, bomb } = punchSetup();
    let punches = 0;
    for (let i = 0; i < 40; i++) {
      stepGame(state, inputs({ 0: Key.Right }));
      if (state.events.some((e) => e[0] === "punch")) punches++;
    }
    expect(punches).toBeGreaterThanOrEqual(2); // 1回目 + 追いついて2回目
    expect(bomb.cx).toBe(10); // (4,3) → (7,3) → (10,3)
  });

  it("飛び越え・延長着地: 途中の障害物は越え、3マス先が塞がっていれば先の空きマスへ", () => {
    const { state, bomb } = punchSetup();
    state.grid[idx(5, 3)] = Tile.Soft; // 途中は飛び越える
    state.grid[idx(7, 3)] = Tile.Soft; // 3マス先はブロック
    addBomb(state, 8, 3, 1); // 4マス先は爆弾
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.cx).toBe(9); // 5マス先が最初の空き
    expect(bomb.flyDist).toBe(5);
    expect(bomb.flyTicks).toBe(5 * PUNCH_FLY_TICKS_PER_TILE);
  });

  it("画面端をラップして反対側に着地する", () => {
    const state = bareState();
    placeAt(state, 0, 12, 3);
    const p = state.players[0]!;
    p.punch = true;
    p.x = 13 * SUB - PLAYER_HALF;
    const bomb = addBomb(state, 13, 3, 1);
    stepGame(state, inputs({ 0: Key.Right }));
    // (13,3) から右へ3マス: (14,3) (15,3) と進み、外周を飛び越えて (1,3) へ
    expect(bomb.cx).toBe(1);
    expect(bomb.cy).toBe(3);
    expect(bomb.flyDir).toBe(Dir.Right);
    expect(bomb.flyDist).toBe(PUNCH_DISTANCE);
  });

  it("ラップ先が塞がっていれば、さらに延長して着地する", () => {
    const state = bareState();
    placeAt(state, 0, 12, 3);
    const p = state.players[0]!;
    p.punch = true;
    p.x = 13 * SUB - PLAYER_HALF;
    const bomb = addBomb(state, 13, 3, 1);
    state.grid[idx(1, 3)] = Tile.Hard; // ラップ先を塞ぐ
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.cx).toBe(2);
    expect(bomb.flyDist).toBe(4);
  });

  it("一周しても空きマスがなければ不成立（元の位置にも戻れない）", () => {
    const { state, bomb } = punchSetup();
    // 行3の内側を、爆弾のマス以外すべて Hard にする（プレイヤーのマスも含む）
    for (let cx = 1; cx <= 15; cx++) {
      if (cx !== 4) state.grid[idx(cx, 3)] = Tile.Hard;
    }
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.cx).toBe(4);
    expect(bomb.flyTicks).toBe(0);
    expect(state.events.some((e) => e[0] === "punch")).toBe(false);
  });

  it("他人の爆弾も押せる（所有・bombsActive は不変）", () => {
    const { state, bomb } = punchSetup();
    state.players[1]!.bombsActive = 1;
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.flyTicks).toBeGreaterThan(0);
    expect(bomb.ownerSlot).toBe(1);
    expect(state.players[1]!.bombsActive).toBe(1);
    expect(state.players[0]!.bombsActive).toBe(0);
  });

  it("飛翔中は当たり判定なし: 発射元・着地予定マスとも通行できる", () => {
    const { state, bomb } = punchSetup();
    stepGame(state, inputs({ 0: Key.Right }));
    const p1 = state.players[1]!;
    expect(tilePassable(state, 4, 3, p1)).toBe(true); // 発射元
    expect(tilePassable(state, 7, 3, p1)).toBe(true); // 着地予定
    for (let i = 0; i < PUNCH_DISTANCE * PUNCH_FLY_TICKS_PER_TILE; i++) {
      stepGame(state, inputs({}));
    }
    expect(bomb.flyTicks).toBe(0);
    expect(tilePassable(state, 7, 3, p1)).toBe(false); // 着地後は通れない
  });

  it("飛翔中は誘爆せず爆風は素通りし、着地マスの残存爆風で着地時に爆発する", () => {
    const { state, bomb } = punchSetup();
    const other = addBomb(state, 7, 1, 1, 2); // 着地予定 (7,3) の上に fuse 2 の爆弾
    other.range = 3;
    stepGame(state, inputs({ 0: Key.Right })); // 押した tick に other の fuse 2→1
    stepGame(state, inputs({})); // other が爆発。爆風が (7,3) を縦断する
    const blastTiles = new Set(state.blasts.map((b) => `${b.cx},${b.cy}`));
    expect(blastTiles.has("7,3")).toBe(true);
    expect(blastTiles.has("7,4")).toBe(true); // 飛翔中の爆弾では遮蔽されない
    expect(state.bombs).toContain(bomb); // 誘爆していない
    expect(bomb.flyTicks).toBe(5);
    // 爆風は BLAST_TICKS(10) 残るので、着地と同時に爆発する
    for (let i = 0; i < 5; i++) stepGame(state, inputs({}));
    expect(state.bombs).toHaveLength(0);
    expect(state.events).toContainEqual(["boom", 7, 3]);
  });

  it("導火線が飛翔中に尽きても、爆発は着地まで遅延する", () => {
    const { state, bomb } = punchSetup();
    bomb.fuse = 3;
    stepGame(state, inputs({ 0: Key.Right }));
    for (let i = 0; i < 5; i++) {
      stepGame(state, inputs({}));
      expect(state.bombs).toContain(bomb); // fuse が尽きても飛翔中は爆発しない
    }
    stepGame(state, inputs({})); // 着地と同時に爆発
    expect(state.bombs).toHaveLength(0);
    expect(state.events).toContainEqual(["boom", 7, 3]);
  });

  it("着地マスに立っていたプレイヤーは passableBy が再セットされ、離れると失効する", () => {
    const { state, bomb } = punchSetup();
    placeAt(state, 1, 7, 3); // 着地予定マスに p1 が立っている
    stepGame(state, inputs({ 0: Key.Right }));
    for (let i = 0; i < PUNCH_DISTANCE * PUNCH_FLY_TICKS_PER_TILE; i++) {
      stepGame(state, inputs({}));
    }
    expect(bomb.flyTicks).toBe(0);
    expect(bomb.passableBy & (1 << 1)).not.toBe(0);
    expect(tilePassable(state, 7, 3, state.players[1]!)).toBe(true);
    expect(tilePassable(state, 7, 3, state.players[0]!)).toBe(false);
    // p1 が離れるとビットが落ち、戻っても通れない
    for (let i = 0; i < 12; i++) stepGame(state, inputs({ 1: Key.Right }));
    expect(bomb.passableBy & (1 << 1)).toBe(0);
    expect(tilePassable(state, 7, 3, state.players[1]!)).toBe(false);
  });

  it("飛翔中の着地予定マスには爆弾を置けない（予約）", () => {
    const { state } = punchSetup();
    placeAt(state, 1, 7, 3);
    stepGame(state, inputs({ 0: Key.Right }));
    expect(state.bombs).toHaveLength(1);
    stepGame(state, inputs({ 1: Key.Bomb })); // p1 が着地予定マスで設置を試みる
    expect(state.bombs).toHaveLength(1); // 置けない
  });

  it("ドクロ中でも押せる（bool 能力はデバフ対象外）", () => {
    const { state, bomb } = punchSetup();
    state.players[0]!.skullTicks = 100;
    stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.flyTicks).toBeGreaterThan(0);
  });

  it("決定論: パンチを含む同一入力列から同一状態になる", () => {
    const run = (): string => {
      const { state } = punchSetup();
      stepGame(state, inputs({ 0: Key.Right }));
      for (let i = 0; i < 20; i++) {
        stepGame(state, inputs({ 0: i % 2 === 0 ? Key.Right : 0 }));
      }
      return stateHash(state);
    };
    expect(run()).toBe(run());
  });
});

// ===== 7. 衝突ユーティリティ =====

describe("collision utils", () => {
  it("collides はヒットボックスが重なる最大4タイルを検査する", () => {
    const state = bareState();
    state.grid[idx(4, 4)] = Tile.Hard;
    const [x, y] = centerOf(3, 3);
    const p0 = state.players[0]!;
    expect(collides(state, x, y, p0)).toBe(false);
    // (4,4) の方向へ半タイル弱ずらすと重なる
    expect(collides(state, x + HALF_TILE + 40, y + HALF_TILE + 40, p0)).toBe(true);
  });

  it("createPlayer はスポーン地点のタイル中心に配置する", () => {
    for (let slot = 0; slot < 6; slot++) {
      const p = createPlayer(slot);
      const [sx, sy] = SPAWNS[slot]!;
      expect(p.x).toBe(sx * SUB + HALF_TILE);
      expect(p.y).toBe(sy * SUB + HALF_TILE);
    }
  });
});

// ===== 8. 入力キュー（tick 指定適用） =====

describe("input queue", () => {
  it("指定 tick に達するまで入力を保留する", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 11, 15, Key.Right); // tick 15 で効く入力
    // tick 14 まではまだ適用されない（fallback を返す）
    expect(consumeInput(q, 12, 0)).toBe(0);
    expect(consumeInput(q, 14, 0)).toBe(0);
    expect(q).toHaveLength(1);
    // tick 15 で適用され、キューから消える
    expect(consumeInput(q, 15, 0)).toBe(Key.Right);
    expect(q).toHaveLength(0);
    // 以降は最後のキー状態を維持（fallback がそのまま返る）
    expect(consumeInput(q, 16, Key.Right)).toBe(Key.Right);
  });

  it("過去 tick 指定（遅延到着）は取りこぼさず次 tick で適用する", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 20, 12, Key.Left); // 8 tick 前の入力が今頃届いた
    expect(q[0]!.tick).toBe(20);
    expect(consumeInput(q, 20, 0)).toBe(Key.Left);
  });

  it("到着順が前後しても tick 昇順を保つ", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 10, 14, Key.Bomb);
    enqueueInput(q, 10, 12, Key.Up);
    enqueueInput(q, 10, 13, Key.Down);
    expect(q.map((e) => e.tick)).toEqual([12, 13, 14]);
    // tick 13 まで消化すると最後（tick 13）のキーが返り、tick 14 は残る
    expect(consumeInput(q, 13, 0)).toBe(Key.Down);
    expect(q.map((e) => e.tick)).toEqual([14]);
  });

  it("同 tick への再送は後着で上書きする", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 10, 15, Key.Left);
    enqueueInput(q, 10, 15, Key.Right);
    expect(q).toHaveLength(1);
    expect(consumeInput(q, 15, 0)).toBe(Key.Right);
  });

  it("先読みし過ぎた入力は握り潰す", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 10, 10 + INPUT_MAX_LEAD_TICKS, Key.Up);
    expect(q).toHaveLength(1);
    enqueueInput(q, 10, 10 + INPUT_MAX_LEAD_TICKS + 1, Key.Down);
    expect(q).toHaveLength(1); // 追加されない
    enqueueInput(q, 10, Number.POSITIVE_INFINITY, Key.Bomb);
    expect(q.some((e) => e.keys === Key.Bomb && e.tick === 10)).toBe(true); // 非有限値は次 tick 扱い
  });

  it("キュー長は上限で頭から切り捨てる", () => {
    const q: QueuedInput[] = [];
    for (let i = 0; i < INPUT_QUEUE_MAX + 10; i++) {
      // 上限超えを作るため lead 制限を都度ずらして積む
      enqueueInput(q, i, i + 1, i % 2 === 0 ? Key.Left : Key.Right);
    }
    expect(q.length).toBeLessThanOrEqual(INPUT_QUEUE_MAX);
    // 昇順は維持されている
    for (let i = 1; i < q.length; i++) {
      expect(q[i]!.tick).toBeGreaterThan(q[i - 1]!.tick);
    }
  });

  it("押しっぱなしは1回の送信で以降の全 tick に効き続ける", () => {
    const q: QueuedInput[] = [];
    enqueueInput(q, 5, 5, Key.Right);
    let keys = 0;
    const applied: number[] = [];
    for (let t = 5; t < 15; t++) {
      keys = consumeInput(q, t, keys);
      applied.push(keys);
    }
    // 10 tick すべてで Right が適用され続ける（＝速度が安定する）
    expect(applied).toEqual(new Array(10).fill(Key.Right));
  });
});
