// 入力キュー。サーバー権威シミュレーションの入力タイミング制御。
// shared 配下は環境非依存・決定論（Math.random / Date.now / 浮動小数点 禁止）。

/** 先読み許容 tick 数（RTT 200ms ≒ 4tick 先読みを想定し余裕を持たせる） */
export const INPUT_MAX_LEAD_TICKS = 20;
/** slot あたりの保持上限 */
export const INPUT_QUEUE_MAX = 32;

export interface QueuedInput {
  tick: number;
  keys: number;
}

/**
 * 入力をキューに積む（tick 昇順を維持）。
 *
 * クライアントは「この入力が有効になるべき tick」を添えて送る。サーバーがそれを尊重する
 * ことで、クライアント予測とサーバー適用のタイミングが一致し、キーの押下/離鍵のたびに
 * 発生していた reconciliation（＝位置の引き戻し）が消える。
 *
 * @param nextTick 次に stepGame が生成する tick。これより過去を指定された入力
 *                 （遅延到着）は取りこぼさず nextTick で適用する。
 */
export function enqueueInput(
  queue: QueuedInput[],
  nextTick: number,
  tick: number,
  keys: number,
): void {
  const safeTick = Number.isFinite(tick) ? Math.max(tick, nextTick) : nextTick;
  // 未来へ行き過ぎた入力は握り潰す（不正・時計ズレ対策）
  if (safeTick > nextTick + INPUT_MAX_LEAD_TICKS) return;

  // 同 tick の再送・上書きは後着を採用
  const at = queue.findIndex((e) => e.tick === safeTick);
  if (at >= 0) {
    queue[at]!.keys = keys;
    return;
  }

  const insertAt = queue.findIndex((e) => e.tick > safeTick);
  const entry: QueuedInput = { tick: safeTick, keys };
  if (insertAt < 0) queue.push(entry);
  else queue.splice(insertAt, 0, entry);

  if (queue.length > INPUT_QUEUE_MAX) queue.splice(0, queue.length - INPUT_QUEUE_MAX);
}

/**
 * applyingTick までに有効化された入力を消化し、最新のキー状態を返す。
 * 該当がなければ fallback（前回のキー状態）をそのまま返す。
 */
export function consumeInput(
  queue: QueuedInput[],
  applyingTick: number,
  fallback: number,
): number {
  let consumed = 0;
  while (consumed < queue.length && queue[consumed]!.tick <= applyingTick) consumed++;
  if (consumed === 0) return fallback;
  const keys = queue[consumed - 1]!.keys;
  queue.splice(0, consumed);
  return keys;
}
