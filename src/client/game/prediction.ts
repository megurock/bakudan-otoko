import { BASE_SPEED, HALF_TILE, SUB, TICK_MS } from "../../shared/constants";
import { movePlayer, type World } from "../../shared/movement";
import type { Snap } from "../../shared/protocol";
import { Dir, type Bomb, type Player } from "../../shared/types";

const EPS = 8; // 許容予測誤差 (units)
const SNAP_ERROR = HALF_TILE; // これ以上のズレは即スナップ
const HISTORY_SIZE = 64;

interface HistoryEntry {
  tick: number;
  keys: number;
  x: number;
  y: number;
}

/**
 * 自キャラのクライアント側予測。
 * - サーバーと同じ movePlayer を「最新スナップの世界(グリッド+爆弾)」に対して先行実行
 * - スナップ受信時に同 tick の予測位置と照合し、ズレたら巻き戻して再適用
 * - 表示誤差は指数減衰オフセットで滑らかに吸収（大ズレは即スナップ）
 */
export class Prediction {
  private readonly slot: number;
  private readonly me: Player;
  private world: World = { grid: new Uint8Array(0), bombs: [] };
  private history: HistoryEntry[] = [];
  private predictedTick = 0;
  private accumulator = 0;
  private lastFrame = 0;
  private renderErrX = 0;
  private renderErrY = 0;
  private started = false;

  // デバッグ統計
  corrections = 0;
  lastError = 0;

  constructor(slot: number, spawnX: number, spawnY: number) {
    this.slot = slot;
    this.me = {
      slot,
      x: spawnX,
      y: spawnY,
      dir: Dir.Down,
      alive: true,
      connected: true,
      speed: BASE_SPEED,
      fire: 1,
      bombCap: 1,
      bombsActive: 0,
      keys: 0,
      prevKeys: 0,
    };
  }

  setGrid(grid: Uint8Array): void {
    this.world.grid = grid;
  }

  /** サーバー tick に予測時計を同期して予測を開始する */
  syncClock(serverTick: number, rttMs: number): void {
    const lead = Math.ceil(rttMs / 2 / TICK_MS) + 1;
    const target = serverTick + lead;
    if (!this.started || Math.abs(target - this.predictedTick) > 10) {
      this.predictedTick = target;
      this.started = true;
    }
  }

  /** rAF から毎フレーム呼ぶ。固定タイムステップで予測 tick を消化 */
  frame(now: number, keys: number): void {
    if (!this.started || !this.me.alive) return;
    if (this.lastFrame === 0) this.lastFrame = now;
    this.accumulator += now - this.lastFrame;
    this.lastFrame = now;
    // 遅延スパイク時の暴走防止
    if (this.accumulator > 250) this.accumulator = 250;

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      movePlayer(this.world, this.me, keys);
      this.history.push({ tick: this.predictedTick, keys, x: this.me.x, y: this.me.y });
      if (this.history.length > HISTORY_SIZE) this.history.shift();
      this.predictedTick++;
    }
    // 表示誤差の指数減衰
    this.renderErrX *= 0.85;
    this.renderErrY *= 0.85;
    if (Math.abs(this.renderErrX) < 1) this.renderErrX = 0;
    if (Math.abs(this.renderErrY) < 1) this.renderErrY = 0;
  }

  /** スナップ受信時の照合（reconciliation） */
  onSnap(snap: Snap, grid: Uint8Array): void {
    const server = snap.p.find((p) => p[0] === this.slot);
    if (!server) return;
    const [, sx, sy, , flags, fire, bombCap, speed] = server;

    // 世界を最新化（爆弾は snap の値をそのまま採用）
    this.world.grid = grid;
    this.world.bombs = snap.b.map(
      ([id, cx, cy, fuse, range, ownerSlot]): Bomb => ({
        id,
        cx,
        cy,
        ownerSlot,
        fuse,
        range,
        // 自分が上に乗っている爆弾の passableBy はサーバーが権威だが snap に含めない。
        // 自マスの爆弾のみ通過可として近似（設置直後の予測用）
        passableBy:
          Math.floor(this.me.x / SUB) === cx && Math.floor(this.me.y / SUB) === cy
            ? 1 << this.slot
            : 0,
      }),
    );
    this.me.alive = (flags & 1) !== 0;
    this.me.fire = fire;
    this.me.bombCap = bombCap;
    this.me.speed = speed;
    if (!this.me.alive) return;

    if (!this.started) {
      this.me.x = sx;
      this.me.y = sy;
      return;
    }

    const h = this.history.find((e) => e.tick === snap.k);
    if (!h) {
      // 履歴外（開始直後 or 大幅遅延）: サーバー位置に合わせる
      this.me.x = sx;
      this.me.y = sy;
      return;
    }

    const err = Math.abs(h.x - sx) + Math.abs(h.y - sy);
    this.lastError = err;
    if (err <= EPS) return; // 予測一致

    // 訂正: サーバー位置から履歴入力を再適用
    this.corrections++;
    const prevX = this.me.x + this.renderErrX;
    const prevY = this.me.y + this.renderErrY;
    this.me.x = sx;
    this.me.y = sy;
    for (const e of this.history) {
      if (e.tick <= snap.k) continue;
      movePlayer(this.world, this.me, e.keys);
      e.x = this.me.x;
      e.y = this.me.y;
    }
    // 表示の連続性: 直前の表示位置との差をオフセットとして減衰させる
    const dx = prevX - this.me.x;
    const dy = prevY - this.me.y;
    if (Math.abs(dx) + Math.abs(dy) <= SNAP_ERROR) {
      this.renderErrX = dx;
      this.renderErrY = dy;
    } else {
      this.renderErrX = 0;
      this.renderErrY = 0;
    }
  }

  matchEnded(): void {
    this.started = false;
    this.history = [];
  }

  get alive(): boolean {
    return this.me.alive;
  }

  /** 描画用の位置（予測 + 減衰オフセット） */
  get renderX(): number {
    return this.me.x + this.renderErrX;
  }
  get renderY(): number {
    return this.me.y + this.renderErrY;
  }
  get dir(): number {
    return this.me.dir;
  }
}
