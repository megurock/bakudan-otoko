import { decodeS2C, encode, type C2S, type S2C } from "../../shared/protocol";

export interface NetCallbacks {
  onMessage: (msg: S2C) => void;
  onClose: () => void;
  onOpen: () => void;
}

const PING_INTERVAL_MS = 2000;

export class Net {
  private ws: WebSocket | null = null;
  private readonly url: string;
  private readonly cb: NetCallbacks;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  /** RTT の指数移動平均 (ms)。pong 受信で更新 */
  rttMs = 100;
  /** 最後の pong が伝えたサーバー tick */
  lastServerTick = 0;

  constructor(roomId: string, cb: NetCallbacks) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    this.url = `${proto}//${location.host}/ws/room/${encodeURIComponent(roomId)}`;
    this.cb = cb;
  }

  connect(): void {
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener("open", () => {
      this.cb.onOpen();
      this.pingTimer = setInterval(() => {
        this.send({ t: "ping", ts: performance.now() });
      }, PING_INTERVAL_MS);
      this.send({ t: "ping", ts: performance.now() });
    });
    ws.addEventListener("message", (ev) => {
      const msg = decodeS2C(String(ev.data));
      if (!msg) return;
      if (msg.t === "pong") {
        const rtt = performance.now() - msg.ts;
        this.rttMs = this.rttMs * 0.8 + rtt * 0.2;
        this.lastServerTick = msg.serverTick;
      }
      this.cb.onMessage(msg);
    });
    ws.addEventListener("close", () => {
      if (this.pingTimer !== null) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.cb.onClose();
    });
    ws.addEventListener("error", () => {
      // close イベント側で処理
    });
  }

  send(msg: C2S): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(encode(msg));
    }
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
