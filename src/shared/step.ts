import {
  BASE_SPEED,
  BLAST_TICKS,
  BOMB_CAP_MAX,
  COUNTDOWN_TICKS,
  FIRE_MAX,
  FUSE_TICKS,
  HALF_TILE,
  MAP_H,
  MAP_W,
  MATCH_MAX_TICKS,
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
import { createMap, idx, tileAt } from "./map";
import {
  boxOverlapsTile,
  centerTileX,
  centerTileY,
  movePlayer,
  touchingSoftWall,
} from "./movement";
import type { RngState } from "./rng";
import {
  Dir,
  Key,
  Powerup,
  Tile,
  type Bomb,
  type GameState,
  type InputMap,
  type Player,
} from "./types";

export function createPlayer(slot: number): Player {
  const spawn = SPAWNS[slot] ?? SPAWNS[0]!;
  return {
    slot,
    x: spawn[0] * SUB + HALF_TILE,
    y: spawn[1] * SUB + HALF_TILE,
    dir: Dir.Down,
    alive: true,
    connected: true,
    speed: BASE_SPEED,
    fire: 1,
    bombCap: 1,
    bombsActive: 0,
    pierce: false,
    punch: false,
    skullTicks: 0,
    wallPass: 0,
    inSoftWall: false,
    keys: 0,
    prevKeys: 0,
  };
}

/** 試合開始用の初期状態を生成（countdown フェーズから始まる） */
export function createInitialState(seed: number, slots: number[]): GameState {
  const rng: RngState = { seed };
  const map = createMap(rng, slots);
  return {
    tick: 0,
    phase: "countdown",
    phaseEndsTick: COUNTDOWN_TICKS,
    seed: rng.seed,
    nextId: 1,
    grid: map.grid,
    hiddenItems: map.hiddenItems,
    players: [...slots].sort((a, b) => a - b).map(createPlayer),
    bombs: [],
    blasts: [],
    items: [],
    winnerSlot: null,
    events: [],
    gridDiffs: [],
  };
}

// Dir → タイル差分（Dir enum の値がそのままインデックス）
const DIR_DELTA: ReadonlyArray<readonly [number, number]> = [
  [0, -1], // Up
  [0, 1], // Down
  [-1, 0], // Left
  [1, 0], // Right
];

// 飛翔中の爆弾も cx/cy に着地予定タイルを持つ（着地マスの予約）。
// 設置の重複判定には findBombAt を、当たり判定・誘爆・パンチ対象には
// 接地爆弾だけを見る findGroundedBombAt を使う
function findBombAt(state: GameState, cx: number, cy: number): Bomb | undefined {
  return state.bombs.find((b) => b.cx === cx && b.cy === cy);
}

function findGroundedBombAt(
  state: GameState,
  cx: number,
  cy: number,
): Bomb | undefined {
  return state.bombs.find((b) => b.flyTicks === 0 && b.cx === cx && b.cy === cy);
}

function addBlast(
  state: GameState,
  cx: number,
  cy: number,
  dir: Dir,
  shape: 0 | 1 | 2,
): void {
  state.blasts.push({ cx, cy, dir, shape, ticks: BLAST_TICKS });
}

/** 誘爆込みの爆発解決（同一 tick 内で BFS 一括処理） */
function resolveExplosions(state: GameState, queue: Bomb[]): void {
  const exploded = new Set<number>();
  while (queue.length > 0) {
    const bomb = queue.pop()!;
    if (exploded.has(bomb.id)) continue;
    exploded.add(bomb.id);

    const bi = state.bombs.indexOf(bomb);
    if (bi >= 0) state.bombs.splice(bi, 1);
    const owner = state.players.find((p) => p.slot === bomb.ownerSlot);
    if (owner) owner.bombsActive = Math.max(0, owner.bombsActive - 1);

    state.events.push(["boom", bomb.cx, bomb.cy]);
    addBlast(state, bomb.cx, bomb.cy, Dir.Up, 0);

    for (const dir of [Dir.Up, Dir.Down, Dir.Left, Dir.Right]) {
      const [dx, dy] = DIR_DELTA[dir]!;
      for (let step = 1; step <= bomb.range; step++) {
        const cx = bomb.cx + dx * step;
        const cy = bomb.cy + dy * step;
        const t = tileAt(state.grid, cx, cy);
        if (t === Tile.Hard) break;
        if (t === Tile.Soft) {
          state.grid[idx(cx, cy)] = Tile.Floor;
          state.gridDiffs.push([cx, cy, Tile.Floor]);
          const hidden = state.hiddenItems[idx(cx, cy)] ?? 0;
          if (hidden !== 0) {
            state.items.push({
              cx,
              cy,
              kind: (hidden - 1) as Powerup,
              revealTick: state.tick + BLAST_TICKS,
            });
            state.hiddenItems[idx(cx, cy)] = 0;
          }
          // 貫通爆弾はブロックを壊しても止まらず、レンジ分まで突き抜ける
          if (bomb.pierce) {
            addBlast(state, cx, cy, dir, step === bomb.range ? 2 : 1);
            continue;
          }
          addBlast(state, cx, cy, dir, 2);
          break;
        }
        // Floor: 未起爆爆弾があれば誘爆して遮蔽（飛翔中は対象外、爆風は素通り）
        const other = findGroundedBombAt(state, cx, cy);
        if (other && !exploded.has(other.id)) {
          queue.push(other);
          addBlast(state, cx, cy, dir, 2);
          break;
        }
        // reveal 済みアイテムは焼失（爆風は貫通）
        for (let i = state.items.length - 1; i >= 0; i--) {
          const item = state.items[i]!;
          if (item.cx === cx && item.cy === cy && item.revealTick <= state.tick) {
            state.items.splice(i, 1);
          }
        }
        addBlast(state, cx, cy, dir, step === bomb.range ? 2 : 1);
      }
    }
  }
}

function tryPlaceBomb(state: GameState, p: Player): void {
  const pressed = (p.keys & Key.Bomb) !== 0 && (p.prevKeys & Key.Bomb) === 0;
  if (!pressed) return;
  if (p.bombsActive >= effectiveBombCap(p)) return;

  const cx = centerTileX(p);
  const cy = centerTileY(p);
  if (tileAt(state.grid, cx, cy) !== Tile.Floor) return;
  if (findBombAt(state, cx, cy)) return;
  if (state.blasts.some((bl) => bl.cx === cx && bl.cy === cy)) return;

  // 設置時にこのマスへ重なっている全プレイヤーが通過可能（離れたら失効）
  let passableBy = 0;
  for (const q of state.players) {
    if (q.alive && boxOverlapsTile(q, cx, cy)) passableBy |= 1 << q.slot;
  }

  state.bombs.push({
    id: state.nextId++,
    cx,
    cy,
    ownerSlot: p.slot,
    fuse: FUSE_TICKS,
    range: effectiveFire(p), // 設置時点の能力をコピー（後からの強化は既設爆弾に影響しない）
    pierce: p.pierce,
    passableBy,
    flyTicks: 0,
    flyFromCx: cx,
    flyFromCy: cy,
  });
  p.bombsActive++;
  state.events.push(["place", p.slot]);
}

/**
 * ボムパンチ: 向いている方向の隣接タイルにある接地爆弾を、同方向へ
 * PUNCH_DISTANCE マス飛ばす（足元の爆弾は対象外）。着地点は発動時に確定し、
 * 3マス先が塞がっていれば 1 マスずつ延長して最初の空きマスへ。
 * マップ外まで空きがなければ不成立（爆弾は動かない）。
 */
function tryPunch(state: GameState, p: Player): void {
  if (!p.punch) return;
  const pressed = (p.keys & Key.Punch) !== 0 && (p.prevKeys & Key.Punch) === 0;
  if (!pressed) return;

  const [dx, dy] = DIR_DELTA[p.dir]!;
  const bx = centerTileX(p) + dx;
  const by = centerTileY(p) + dy;
  const bomb = findGroundedBombAt(state, bx, by);
  if (!bomb) return;

  // 空きマス = Floor かつ爆弾なし（飛翔中爆弾の着地予約も含めて避ける）
  let dist = PUNCH_DISTANCE;
  for (;;) {
    const tx = bx + dx * dist;
    const ty = by + dy * dist;
    if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return; // マップ外 = 不成立
    if (tileAt(state.grid, tx, ty) === Tile.Floor && !findBombAt(state, tx, ty)) break;
    dist++;
  }

  bomb.flyFromCx = bomb.cx;
  bomb.flyFromCy = bomb.cy;
  bomb.cx = bx + dx * dist;
  bomb.cy = by + dy * dist;
  bomb.flyTicks = dist * PUNCH_FLY_TICKS_PER_TILE;
  bomb.passableBy = 0; // 飛翔中は判定対象外。着地時に重なりで再セットする
  state.events.push(["punch", p.slot]);
}

// ドクロ中の実効能力。素の値は保持しておき、デバフが切れたら元に戻る
export function effectiveFire(p: Player): number {
  return p.skullTicks > 0 ? Math.min(SKULL_FIRE, p.fire) : p.fire;
}
export function effectiveBombCap(p: Player): number {
  return p.skullTicks > 0 ? Math.min(SKULL_BOMB_CAP, p.bombCap) : p.bombCap;
}
export function effectiveSpeed(p: Player): number {
  return p.skullTicks > 0 ? Math.min(SKULL_SPEED, p.speed) : p.speed;
}

function pickupItem(state: GameState, p: Player): void {
  const cx = centerTileX(p);
  const cy = centerTileY(p);
  for (let i = state.items.length - 1; i >= 0; i--) {
    const item = state.items[i]!;
    if (item.cx !== cx || item.cy !== cy || item.revealTick > state.tick) continue;
    switch (item.kind) {
      case Powerup.Fire:
        p.fire = Math.min(FIRE_MAX, p.fire + 1);
        break;
      case Powerup.Bomb:
        p.bombCap = Math.min(BOMB_CAP_MAX, p.bombCap + 1);
        break;
      case Powerup.Speed:
        p.speed = Math.min(SPEED_MAX, p.speed + SPEED_INC);
        break;
      case Powerup.Pierce:
        p.pierce = true;
        break;
      case Powerup.Skull:
        // 罠。取ると一定時間、能力が最低値に落ちる（貫通は失わない）
        p.skullTicks = SKULL_TICKS;
        break;
      case Powerup.WallPass:
        p.wallPass++;
        break;
      case Powerup.Punch:
        p.punch = true;
        break;
    }
    state.items.splice(i, 1);
    state.events.push(["pickup", p.slot, item.kind]);
  }
}

/**
 * 権威シミュレーション 1 tick。
 * 処理順は仕様として固定（テストで担保）:
 * 爆風減衰 → 導火線 → 爆発解決 → プレイヤー(設置→移動→取得) → passableBy 更新 → 死亡 → 勝敗
 */
export function stepGame(state: GameState, inputs: InputMap): void {
  state.events = [];
  state.gridDiffs = [];

  if (state.phase === "countdown") {
    state.tick++;
    if (state.tick >= state.phaseEndsTick) state.phase = "playing";
    return;
  }
  if (state.phase !== "playing") return;

  // 1. 爆風の減衰
  for (let i = state.blasts.length - 1; i >= 0; i--) {
    const bl = state.blasts[i]!;
    bl.ticks--;
    if (bl.ticks <= 0) state.blasts.splice(i, 1);
  }

  // 2. 導火線と飛翔の進行。飛翔中も導火線は進むが、爆発は着地まで遅延する。
  //    着地をここ（プレイヤー処理より前）で行うことで、着地時の即時爆発が
  //    同 tick のステップ3（誘爆 BFS）にそのまま乗る
  const explodeQueue: Bomb[] = [];
  for (const b of state.bombs) {
    b.fuse--;
    if (b.flyTicks > 0) {
      b.flyTicks--;
      if (b.flyTicks === 0) {
        // 着地: このマスへ重なっているプレイヤーは通過可能（設置時と同じ規則）
        let mask = 0;
        for (const q of state.players) {
          if (q.alive && boxOverlapsTile(q, b.cx, b.cy)) mask |= 1 << q.slot;
        }
        b.passableBy = mask;
        // 導火線切れ、または着地マスに爆風が残っていれば即爆発
        if (b.fuse <= 0 || state.blasts.some((bl) => bl.cx === b.cx && bl.cy === b.cy)) {
          explodeQueue.push(b);
        }
      }
      continue;
    }
    if (b.fuse <= 0) explodeQueue.push(b);
  }

  // 3. 爆発解決（誘爆込み）
  resolveExplosions(state, explodeQueue);

  // 4. プレイヤー処理（slot 昇順）
  for (const p of state.players) {
    if (!p.alive) continue;
    if (p.skullTicks > 0) p.skullTicks--;
    p.prevKeys = p.keys;
    p.keys = inputs[p.slot] ?? 0;
    tryPlaceBomb(state, p);
    tryPunch(state, p);
    movePlayer(state, p, p.keys);
    // 壁すり抜けの消費: ブロックに入り、完全に抜けきった時点で1チャージ消費する。
    // 判定に体全体を使うのは、中心タイルだけで見ると半身が壁に残っていても
    // 「抜けた」ことになり、効力が早く切れてしまうため
    // （連続したブロック帯は1回のすり抜けとして扱う）
    const inSoft = touchingSoftWall(state.grid, p);
    if (p.inSoftWall && !inSoft && p.wallPass > 0) p.wallPass--;
    p.inSoftWall = inSoft;
    pickupItem(state, p);
  }

  // 5. passableBy 更新: 離れたプレイヤーのビットを落とす（再セットしない）
  for (const b of state.bombs) {
    for (const p of state.players) {
      const bit = 1 << p.slot;
      if ((b.passableBy & bit) === 0) continue;
      if (!p.alive || !boxOverlapsTile(p, b.cx, b.cy)) b.passableBy &= ~bit;
    }
  }

  // 6. 死亡判定（中心タイルが爆風マス）
  for (const p of state.players) {
    if (!p.alive) continue;
    const cx = centerTileX(p);
    const cy = centerTileY(p);
    if (state.blasts.some((bl) => bl.cx === cx && bl.cy === cy)) {
      p.alive = false;
      state.events.push(["die", p.slot]);
    }
  }

  // 7. 勝敗判定
  const alive = state.players.filter((p) => p.alive);
  if (alive.length <= 1) {
    state.phase = "finished";
    state.winnerSlot = alive.length === 1 ? alive[0]!.slot : -1;
  } else if (state.tick >= MATCH_MAX_TICKS) {
    state.phase = "finished";
    state.winnerSlot = -1;
  }

  // 8. tick 前進
  state.tick++;
}
