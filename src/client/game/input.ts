import { Key } from "../../shared/types";

const KEYMAP: Record<string, number> = {
  ArrowUp: Key.Up,
  ArrowDown: Key.Down,
  ArrowLeft: Key.Left,
  ArrowRight: Key.Right,
  KeyW: Key.Up,
  KeyS: Key.Down,
  KeyA: Key.Left,
  KeyD: Key.Right,
  Space: Key.Bomb,
  KeyZ: Key.Bomb,
};

/** キーボード状態を 5bit マスクとして追跡し、変化時にコールバックする */
export class InputTracker {
  private mask = 0;
  private readonly onChange: (mask: number) => void;

  constructor(onChange: (mask: number) => void) {
    this.onChange = onChange;
    window.addEventListener("keydown", (ev) => {
      const bit = KEYMAP[ev.code];
      if (bit === undefined) return;
      ev.preventDefault();
      if ((this.mask & bit) === 0) {
        this.mask |= bit;
        this.onChange(this.mask);
      }
    });
    window.addEventListener("keyup", (ev) => {
      const bit = KEYMAP[ev.code];
      if (bit === undefined) return;
      ev.preventDefault();
      if ((this.mask & bit) !== 0) {
        this.mask &= ~bit;
        this.onChange(this.mask);
      }
    });
    // フォーカス喪失・タブ非表示時は全キー解放（押しっぱなし事故防止）。
    // keyup を取りこぼしたまま Bomb ビットが立ち続けると、設置は押下エッジ判定なので
    // 以後まったく爆弾を置けなくなる。復帰契機は多めに張っておく。
    const releaseAll = (): void => {
      if (this.mask !== 0) {
        this.mask = 0;
        this.onChange(0);
      }
    };
    window.addEventListener("blur", releaseAll);
    window.addEventListener("pagehide", releaseAll);
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) releaseAll();
    });
    // 復帰時はサーバー側に古い押下状態が残っている可能性があるため、
    // ローカルが 0 でも無条件に解放を送って状態を揃える
    const forceRelease = (): void => {
      this.mask = 0;
      this.onChange(0);
    };
    window.addEventListener("focus", forceRelease);
    window.addEventListener("pageshow", forceRelease);
  }

  get current(): number {
    return this.mask;
  }
}
