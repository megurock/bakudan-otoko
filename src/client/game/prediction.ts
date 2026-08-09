import { BASE_SPEED, HALF_TILE, SUB, TICK_MS } from "../../shared/constants";
import { movePlayer, type World } from "../../shared/movement";
import type { Snap } from "../../shared/protocol";
import { Dir, type Bomb, type Player } from "../../shared/types";

const EPS = 8; // 許容予測誤差 (units)
const SNAP_ERROR = HALF_TILE; // これ以上のズレは即スナップ
const HISTORY_SIZE = 64;
// 訂正オフセットを表示上に溶かす半減期。短すぎると「引き戻される」感触になる
const RENDER_ERR_HALFLIFE_MS = 120;
// RTT のゆらぎ・tick 境界の丸めを吸収する先行マージン。大きいほど入力遅延が増えるので最小限に
const LEAD_MARGIN_TICKS = 2;

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
  /** tick 間の描画補間用: 直前 tick 終了時点の位置 */
  private prevX = 0;
  private prevY = 0;

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
      pierce: false,
      skullTicks: 0,
      keys: 0,
      prevKeys: 0,
    };
    this.prevX = spawnX;
    this.prevY = spawnY;
  }

  /** 入力に添える「この入力が有効になるべき tick」 */
  get inputTick(): number {
    return this.predictedTick;
  }

  setGrid(grid: Uint8Array): void {
    this.world.grid = grid;
  }

  /**
   * サーバー tick に予測時計を同期して予測を開始する。
   *
   * 受け取った serverTick は「片道分（RTT/2）古い」情報で、こちらが今から送る入力が
   * 届くまでにさらに片道分かかる。入力がサーバーに「未来の tick」として届くためには
   * ラウンドトリップ全体を先行させる必要がある（+ 安全マージン）。
   * 先行が足りないと入力が過去 tick 扱いで次 tick に押し出され、
   * 予測とサーバーが 1tick ずれて押下/離鍵のたびに reconciliation が起きる。
   */
  syncClock(serverTick: number, rttMs: number): void {
    const lead = Math.ceil(rttMs / TICK_MS) + LEAD_MARGIN_TICKS;
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
    const dt = now - this.lastFrame;
    this.accumulator += dt;
    this.lastFrame = now;
    // 遅延スパイク時の暴走防止
    if (this.accumulator > 250) this.accumulator = 250;

    while (this.accumulator >= TICK_MS) {
      this.accumulator -= TICK_MS;
      this.prevX = this.me.x;
      this.prevY = this.me.y;
      movePlayer(this.world, this.me, keys);
      this.history.push({ tick: this.predictedTick, keys, x: this.me.x, y: this.me.y });
      if (this.history.length > HISTORY_SIZE) this.history.shift();
      this.predictedTick++;
    }
    // 表示誤差の指数減衰（フレームレート非依存: 半減期 RENDER_ERR_HALFLIFE_MS）
    const decay = Math.pow(0.5, dt / RENDER_ERR_HALFLIFE_MS);
    this.renderErrX *= decay;
    this.renderErrY *= decay;
    if (Math.abs(this.renderErrX) < 1) this.renderErrX = 0;
    if (Math.abs(this.renderErrY) < 1) this.renderErrY = 0;
  }

  /** スナップ受信時の照合（reconciliation） */
  onSnap(snap: Snap, grid: Uint8Array): void {
    const server = snap.p.find((p) => p[0] === this.slot);
    if (!server) return;
    const [, sx, sy, , flags, fire, bombCap, speed, skullTicks] = server;

    // 世界を最新化（爆弾は snap の値をそのまま採用）
    this.world.grid = grid;
    this.world.bombs = snap.b.map(
      ([id, cx, cy, fuse, range, ownerSlot, pierce]): Bomb => ({
        id,
        cx,
        cy,
        ownerSlot,
        fuse,
        range,
        pierce: pierce === 1,
        // 自分が上に乗っている爆弾の passableBy はサーバーが権威だが snap に含めない。
        // 自マスの爆弾のみ通過可として近似（設置直後の予測用）
        passableBy:
          Math.floor(this.me.x / SUB) === cx && Math.floor(this.me.y / SUB) === cy
            ? 1 << this.slot
            : 0,
      }),
    );
    this.me.alive = (flags & 1) !== 0;
    this.me.pierce = (flags & 4) !== 0;
    this.me.fire = fire;
    this.me.bombCap = bombCap;
    this.me.speed = speed;
    this.me.skullTicks = skullTicks;
    if (!this.me.alive) return;

    if (!this.started) {
      this.setPosition(sx, sy);
      return;
    }

    const h = this.history.find((e) => e.tick === snap.k);
    if (!h) {
      // 履歴外（開始直後 or 大幅遅延）: サーバー位置に合わせる
      this.setPosition(sx, sy);
      return;
    }

    const err = Math.abs(h.x - sx) + Math.abs(h.y - sy);
    this.lastError = err;
    if (err <= EPS) return; // 予測一致

    // 訂正: サーバー位置から履歴入力を再適用
    this.corrections++;
    // 起点は「いま画面に見えている位置」= 補間 + オフセット込み
    const prevX = this.renderX;
    const prevY = this.renderY;
    this.me.x = sx;
    this.me.y = sy;
    for (const e of this.history) {
      if (e.tick <= snap.k) continue;
      movePlayer(this.world, this.me, e.keys);
      e.x = this.me.x;
      e.y = this.me.y;
    }
    // 再適用後は tick 境界の位置なので補間起点を畳む
    this.prevX = this.me.x;
    this.prevY = this.me.y;
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

  /** 予測位置を強制的に置き、補間・オフセットを畳む */
  private setPosition(x: number, y: number): void {
    this.me.x = x;
    this.me.y = y;
    this.prevX = x;
    this.prevY = y;
    this.renderErrX = 0;
    this.renderErrY = 0;
  }

  matchEnded(): void {
    this.started = false;
    this.history = [];
  }

  get alive(): boolean {
    return this.me.alive;
  }

  /**
   * 描画用の位置（tick 間補間 + 減衰オフセット）。
   * 予測は 20Hz の固定ステップなので、そのまま描くと 60fps では 3 フレームに 1 回だけ
   * 飛ぶカクついた動きになる。accumulator の進み具合で前 tick と現 tick を補間する。
   */
  private get alpha(): number {
    return Math.min(1, this.accumulator / TICK_MS);
  }
  get renderX(): number {
    return this.prevX + (this.me.x - this.prevX) * this.alpha + this.renderErrX;
  }
  get renderY(): number {
    return this.prevY + (this.me.y - this.prevY) * this.alpha + this.renderErrY;
  }
  get dir(): number {
    return this.me.dir;
  }
}
