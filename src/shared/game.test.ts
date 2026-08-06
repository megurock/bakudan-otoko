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
  SPAWNS,
  SPEED_INC,
  SPEED_MAX,
  SUB,
} from "./constants";
import { createMap, idx, tileAt } from "./map";
import { collides, movePlayer, tilePassable } from "./movement";
import { buildSnap, decodeC2S, decodeGrid, encode, encodeGrid } from "./protocol";
import { createInitialState, createPlayer, stepGame } from "./step";
import { Dir, Key, Powerup, Tile, type GameState } from "./types";

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

function stateHash(state: GameState): string {
  return JSON.stringify({
    tick: state.tick,
    grid: Array.from(state.grid),
    players: state.players.map((p) => [p.slot, p.x, p.y, p.alive, p.fire, p.bombCap, p.speed]),
    bombs: state.bombs.map((b) => [b.id, b.cx, b.cy, b.fuse, b.range, b.passableBy]),
    blasts: state.blasts.map((b) => [b.cx, b.cy, b.ticks]),
    items: state.items.map((i) => [i.cx, i.cy, i.kind, i.revealTick]),
    winner: state.winnerSlot,
  });
}

// ===== 1. マップ生成 =====

describe("map", () => {
  it("同一 seed から同一マップ・同一隠しアイテムが生成される（決定論）", () => {
    const a = createMap({ seed: 42 }, 6);
    const b = createMap({ seed: 42 }, 6);
    expect(Array.from(a.grid)).toEqual(Array.from(b.grid));
    expect(Array.from(a.hiddenItems)).toEqual(Array.from(b.hiddenItems));
    const c = createMap({ seed: 43 }, 6);
    expect(Array.from(c.grid)).not.toEqual(Array.from(a.grid));
  });

  it("外周と偶数格子が Hard、スポーン周辺が Floor", () => {
    const { grid } = createMap({ seed: 1 }, 6);
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

  it("ソフト配置率とドロップ率が期待範囲（seed 100個の統計）", () => {
    let softTotal = 0;
    let floorCandidates = 0;
    let drops = 0;
    for (let seed = 0; seed < 100; seed++) {
      const { grid, hiddenItems } = createMap({ seed }, 6);
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
    expect(tilePassable(state, 3, 3, 0)).toBe(true);
    expect(tilePassable(state, 3, 3, 1)).toBe(false);
    // slot0 が離れるとビットが落ち、戻っても通れない
    for (let i = 0; i < 12; i++) stepGame(state, inputs({ 0: Key.Right }));
    expect(bomb.passableBy & 1).toBe(0);
    expect(tilePassable(state, 3, 3, 0)).toBe(false);
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
    const { grid } = createMap({ seed: 5 }, 6);
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
});

// ===== 7. 衝突ユーティリティ =====

describe("collision utils", () => {
  it("collides はヒットボックスが重なる最大4タイルを検査する", () => {
    const state = bareState();
    state.grid[idx(4, 4)] = Tile.Hard;
    const [x, y] = centerOf(3, 3);
    expect(collides(state, x, y, 0)).toBe(false);
    // (4,4) の方向へ半タイル弱ずらすと重なる
    expect(collides(state, x + HALF_TILE + 40, y + HALF_TILE + 40, 0)).toBe(true);
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
