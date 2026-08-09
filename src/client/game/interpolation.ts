import { TICK_MS } from "../../shared/constants";
import type { Snap } from "../../shared/protocol";

const INTERP_DELAY_MS = 100; // 2スナップショット分の遅延で描画

export interface InterpPlayer {
  slot: number;
  x: number;
  y: number;
  dir: number;
  alive: boolean;
  connected: boolean;
  pierce: boolean;
  fire: number;
  bombCap: number;
  speed: number;
  skullTicks: number;
}

interface BufferedSnap {
  snap: Snap;
  at: number; // 受信時刻 (performance.now)
}

/**
 * スナップショットバッファ。描画時刻を約100ms過去にずらし、
 * それを挟む2つのスナップショット間でプレイヤー位置を線形補間する。
 */
export class SnapBuffer {
  private buf: BufferedSnap[] = [];

  push(snap: Snap): void {
    this.buf.push({ snap, at: performance.now() });
    // 直近 20 個（約1秒分）だけ保持
    if (this.buf.length > 20) this.buf.shift();
  }

  clear(): void {
    this.buf = [];
  }

  get latest(): Snap | null {
    return this.buf.length > 0 ? this.buf[this.buf.length - 1]!.snap : null;
  }

  /**
   * 補間済みプレイヤー位置を返す。
   * サーバー時間軸の推定: 最新スナップの tick 時刻 + 受信からの経過。
   */
  sample(now: number): InterpPlayer[] {
    if (this.buf.length === 0) return [];
    const latest = this.buf[this.buf.length - 1]!;
    // 推定サーバー時刻（ms, tick換算）から補間遅延を引いた描画対象時刻
    const estServerMs = latest.snap.k * TICK_MS + (now - latest.at);
    const renderMs = estServerMs - INTERP_DELAY_MS;

    // renderMs を挟む2つの snap を探す
    let older = this.buf[0]!;
    let newer = latest;
    for (let i = this.buf.length - 1; i >= 0; i--) {
      const b = this.buf[i]!;
      if (b.snap.k * TICK_MS <= renderMs) {
        older = b;
        newer = this.buf[Math.min(i + 1, this.buf.length - 1)]!;
        break;
      }
    }

    const t0 = older.snap.k * TICK_MS;
    const t1 = newer.snap.k * TICK_MS;
    const alpha = t1 > t0 ? Math.min(1, Math.max(0, (renderMs - t0) / (t1 - t0))) : 1;

    const result: InterpPlayer[] = [];
    for (const pNew of newer.snap.p) {
      const [slot, x1, y1, dir, flags, fire, bombCap, speed, skullTicks] = pNew;
      const pOld = older.snap.p.find((q) => q[0] === slot) ?? pNew;
      const [, x0, y0] = pOld;
      result.push({
        slot,
        x: x0 + (x1 - x0) * alpha,
        y: y0 + (y1 - y0) * alpha,
        dir,
        alive: (flags & 1) !== 0,
        connected: (flags & 2) !== 0,
        pierce: (flags & 4) !== 0,
        fire,
        bombCap,
        speed,
        skullTicks,
      });
    }
    return result;
  }
}
