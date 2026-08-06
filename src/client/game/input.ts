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
    // フォーカス喪失時は全キー解放（押しっぱなし事故防止）
    window.addEventListener("blur", () => {
      if (this.mask !== 0) {
        this.mask = 0;
        this.onChange(0);
      }
    });
  }

  get current(): number {
    return this.mask;
  }
}
