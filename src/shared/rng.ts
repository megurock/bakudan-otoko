// mulberry32 ベースの決定論 PRNG。seed を消費して書き戻す。
// 整数演算のみ（浮動小数点を状態に持ち込まない）。

export interface RngState {
  seed: number;
}

/** 32bit 符号なし整数を返し、seed を進める */
export function rand32(s: RngState): number {
  s.seed = (s.seed + 0x6d2b79f5) | 0;
  let t = s.seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return (t ^ (t >>> 14)) >>> 0;
}

/** 0 <= n < max の整数 */
export function randBelow(s: RngState, max: number): number {
  return rand32(s) % max;
}
