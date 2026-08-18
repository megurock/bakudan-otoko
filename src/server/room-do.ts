import {
  COUNTDOWN_TICKS,
  DEFAULT_WIN_TARGET,
  FINISHED_RESET_MS,
  MAX_PLAYERS,
  NEXT_ROUND_DELAY_MS,
  START_GRACE_MS,
  TICK_MS,
  WIN_TARGET_OPTIONS,
} from "../shared/constants";
import {
  buildSnap,
  decodeC2S,
  encode,
  encodeGrid,
  type RosterEntry,
  type S2C,
} from "../shared/protocol";
import {
  consumeInput,
  enqueueInput,
  type QueuedInput,
} from "../shared/input-queue";
import { createInitialState, stepGame } from "../shared/step";
import type { GameState } from "../shared/types";
import type { Env } from "./env";

interface Attachment {
  slot: number;
  token: string;
}

interface RosterSlot {
  slot: number;
  name: string;
  token: string;
  ready: boolean;
}

const WATCHDOG_MS = 30_000;

/**
 * ゲームルームの Durable Object（権威サーバー）。
 * - 待機中: 完全イベント駆動（Hibernation 可能）
 * - 試合中: setTimeout 自己補正チェーンで 20 tick/s（alarm はウォッチドッグのみ）
 */
export class RoomDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  private roster = new Map<number, RosterSlot>();
  private loaded = false;
  private roomId: string | null = null;

  private game: GameState | null = null;
  /** 何勝先取。ロビーで変更でき、シリーズ終了までは固定 */
  private winTarget = DEFAULT_WIN_TARGET;
  /** slot → 勝数。シリーズ中のみ意味を持つ */
  private wins: number[] = new Array(MAX_PLAYERS).fill(0);
  /** 何戦目か（1始まり） */
  private round = 0;
  private pendingKeys: number[] = new Array(MAX_PLAYERS).fill(0);
  private lastSeq: number[] = new Array(MAX_PLAYERS).fill(0);
  /**
   * slot ごとの入力キュー（tick 昇順）。クライアントは「この入力が効くべき tick」を
   * 添えて送るので、その tick に達するまで適用を保留する。これによりクライアント予測と
   * サーバー適用タイミングが一致し、押下/離鍵のたびの reconciliation が消える。
   */
  private inputQueue: QueuedInput[][] = Array.from({ length: MAX_PLAYERS }, () => []);

  private timer: ReturnType<typeof setTimeout> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  /** 全員 Ready 後の開始猶予タイマー */
  private startTimer: ReturnType<typeof setTimeout> | null = null;
  private loopStart = 0;
  private loopN = 0;
  private lastTickAt = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  // ===== 接続受け入れ =====

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("Expected WebSocket", { status: 426 });
    }
    const roomId = request.headers.get("x-room-id");
    if (roomId) {
      this.roomId = roomId;
      await this.ctx.storage.put("roomId", roomId);
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server); // Hibernation 対応
    return new Response(null, { status: 101, webSocket: client });
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<RosterSlot[]>("roster");
    if (stored) {
      this.roster = new Map(stored.map((r) => [r.slot, r]));
    }
    this.roomId = (await this.ctx.storage.get<string>("roomId")) ?? null;
    this.winTarget =
      (await this.ctx.storage.get<number>("winTarget")) ?? DEFAULT_WIN_TARGET;
    this.loaded = true;
  }

  // ===== ロビーへの報告 =====

  private lobbyStub(): DurableObjectStub {
    return this.env.LOBBY_DO.get(this.env.LOBBY_DO.idFromName("global"));
  }

  private reportLobby(): void {
    if (!this.roomId) return;
    const body = JSON.stringify({
      id: this.roomId,
      players: this.roster.size,
      status: this.game ? "playing" : "waiting",
    });
    void this.lobbyStub()
      .fetch("https://lobby/report", { method: "POST", body })
      .catch(() => {});
  }

  private removeFromLobby(): void {
    if (!this.roomId) return;
    const body = JSON.stringify({ id: this.roomId });
    void this.lobbyStub()
      .fetch("https://lobby/remove", { method: "POST", body })
      .catch(() => {});
  }

  private async persistRoster(): Promise<void> {
    await this.ctx.storage.put("roster", [...this.roster.values()]);
  }

  // ===== メッセージ処理 =====

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== "string") return;
    await this.ensureLoaded();
    const msg = decodeC2S(message);
    if (!msg) return;

    if (msg.t === "join") {
      await this.handleJoin(ws, msg.name, msg.token);
      return;
    }

    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;

    switch (msg.t) {
      case "ready": {
        const entry = this.roster.get(att.slot);
        if (!entry || this.game) return;
        entry.ready = msg.ready === true;
        await this.persistRoster();
        this.broadcastRoster();
        await this.maybeStart();
        return;
      }
      case "input": {
        if (typeof msg.keys !== "number" || typeof msg.seq !== "number") return;
        if (msg.seq <= (this.lastSeq[att.slot] ?? 0)) return; // 後退 seq は無視
        this.lastSeq[att.slot] = msg.seq;
        const q = this.inputQueue[att.slot];
        if (q) enqueueInput(q, (this.game?.tick ?? 0) + 1, msg.tick, msg.keys & 31);
        return;
      }
      case "setWinTarget": {
        // 待機中のみ変更可。シリーズ途中で目標が動くと勝敗の意味が変わるため
        if (this.game || this.round > 0) return;
        const v = msg.winTarget;
        if (!WIN_TARGET_OPTIONS.includes(v as (typeof WIN_TARGET_OPTIONS)[number])) return;
        if (v === this.winTarget) return; // 同じ値なら Ready を巻き込まない
        this.winTarget = v;
        // ルール変更は合意のやり直し: 全員の Ready を解除し、開始猶予も取り消す。
        // Ready は「今のルールで始めてよい」という合意なので、ルールが変われば
        // 全員が新しいルールを見て押し直すまで開始しない
        for (const e of this.roster.values()) e.ready = false;
        this.cancelStartGrace();
        await this.ctx.storage.put("winTarget", v);
        await this.persistRoster();
        this.broadcastSeries(null);
        this.broadcastRoster();
        return;
      }
      case "ping": {
        this.send(ws, { t: "pong", ts: msg.ts, serverTick: this.game?.tick ?? 0 });
        return;
      }
    }
  }

  private async handleJoin(ws: WebSocket, name: string, token?: string): Promise<void> {
    if (ws.deserializeAttachment()) return; // 二重 join

    const safeName = String(name ?? "").slice(0, 12) || "player";

    // 再接続（token 一致）。旧ソケットがまだ生きていてもスロットを引き継ぐ。
    // ページ遷移での再参加では、古いソケットの close がサーバーに届く前に
    // 新しい接続の join が処理されることがある。ここで接続状態を条件にすると
    // 同じプレイヤーに新スロットを配ってしまい、ロスターが増殖する。
    if (token) {
      const entry = [...this.roster.values()].find((r) => r.token === token);
      if (entry) {
        this.closeSocketsForSlot(entry.slot, ws);
        entry.name = safeName;
        ws.serializeAttachment({ slot: entry.slot, token: entry.token });
        if (this.game) {
          const p = this.game.players.find((q) => q.slot === entry.slot);
          if (p) p.connected = true;
        }
        await this.persistRoster();
        this.sendWelcome(ws, entry.slot, entry.token);
        if (this.game) this.sendStartInfo(ws, this.game);
        this.broadcastRoster();
        return;
      }
    }

    // 試合中の新規参加は拒否
    if (this.game) {
      this.send(ws, { t: "joinRejected", reason: "in_progress" });
      return;
    }

    // 空きスロットへ割り当て
    let slot = -1;
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if (!this.roster.has(s)) {
        slot = s;
        break;
      }
    }
    if (slot < 0) {
      this.send(ws, { t: "joinRejected", reason: "full" });
      return;
    }

    const newToken = crypto.randomUUID();
    this.roster.set(slot, { slot, name: safeName, token: newToken, ready: false });
    // 新しく入った人は未 Ready なので開始条件が崩れる。猶予中なら取り消す
    this.cancelStartGrace();
    await this.persistRoster();
    ws.serializeAttachment({ slot, token: newToken });
    this.sendWelcome(ws, slot, newToken);
    this.broadcastRoster();
    this.reportLobby();
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.ensureLoaded();
    const att = ws.deserializeAttachment() as Attachment | null;

    if (att) {
      this.pendingKeys[att.slot] = 0;
      if (this.game) {
        // 試合中: スロットは残す（token で再接続可能）
        const p = this.game.players.find((q) => q.slot === att.slot);
        if (p) p.connected = false;
      } else {
        this.roster.delete(att.slot);
        await this.persistRoster();
      }
    }

    // 全員退出したらルームを畳む
    if (this.liveSockets().length === 0) {
      await this.teardown();
      return;
    }
    this.broadcastRoster();
    this.reportLobby();
    if (this.game) return;
    // シリーズの試合間に人数が足りなくなったら、次戦を待たずに畳む
    if (this.round > 0 && this.roster.size < 2) {
      await this.resetToWaiting("not_enough_players");
      return;
    }
    await this.maybeStart();
  }

  // ===== 試合ライフサイクル =====

  /**
   * 開始条件（2人以上・全員 Ready）を満たしたら猶予タイマーを張る。
   * 条件が崩れたら（Ready 解除・退室）タイマーを取り消す。
   * 即開始しないのは、まだ入室していない相手を待っている最中に
   * 先に揃った人たちだけで始まってしまう事故を防ぐため。
   */
  private async maybeStart(): Promise<void> {
    if (this.game) return;
    // シリーズ進行中（次戦待ち）は Ready 経由の開始を受け付けない
    if (this.round > 0) return;
    const entries = [...this.roster.values()];
    const ready = entries.length >= 2 && entries.every((e) => e.ready);

    if (!ready) {
      this.cancelStartGrace();
      return;
    }
    if (this.startTimer !== null) return; // 既に猶予中

    const endsAt = Date.now() + START_GRACE_MS;
    this.startTimer = setTimeout(() => {
      this.startTimer = null;
      void this.beginMatch();
    }, START_GRACE_MS);
    this.broadcast({ t: "startPending", endsAt, players: entries.length });
  }

  private cancelStartGrace(): void {
    if (this.startTimer === null) return;
    clearTimeout(this.startTimer);
    this.startTimer = null;
    this.broadcast({ t: "startCancelled" });
  }

  private async beginMatch(): Promise<void> {
    if (this.game) return;
    const entries = [...this.roster.values()];
    // シリーズ 1 戦目は「全員 Ready」が条件。2 戦目以降は続きなので Ready を求めない
    const isFirstRound = this.round === 0;
    if (entries.length < 2) {
      if (!isFirstRound) await this.resetToWaiting("not_enough_players");
      return;
    }
    if (isFirstRound && !entries.every((e) => e.ready)) return;

    if (isFirstRound) this.wins.fill(0);
    this.round++;

    const seed = (Math.random() * 0x100000000) >>> 0;
    const slots = entries.map((e) => e.slot);
    this.game = createInitialState(seed, slots);
    this.pendingKeys.fill(0);
    this.lastSeq.fill(0);
    this.clearInputQueues();

    await this.ctx.storage.put("matchActive", true);
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);

    this.broadcast({
      t: "start",
      seed,
      tick: 0,
      countdownTicks: COUNTDOWN_TICKS,
      grid: encodeGrid(this.game.grid),
      slots,
    });
    this.broadcastSeries(null);
    this.reportLobby();
    this.startLoop();
  }

  private startLoop(): void {
    this.stopLoop();
    this.loopStart = Date.now();
    this.loopN = 0;
    const step = (): void => {
      this.timer = null;
      const game = this.game;
      if (!game || (game.phase !== "playing" && game.phase !== "countdown")) return;

      this.lastTickAt = Date.now();
      stepGame(game, this.collectInputs(game));
      this.broadcast(buildSnap(game, [...this.lastSeq]));

      if (game.winnerSlot !== null) {
        // stepGame 内で finished へ遷移した
        void this.endMatch(game.winnerSlot);
        return;
      }

      this.loopN++;
      const next = this.loopStart + this.loopN * TICK_MS - Date.now();
      this.timer = setTimeout(step, Math.max(0, next));
    };
    step();
  }

  private stopLoop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearInputQueues(): void {
    for (const q of this.inputQueue) q.length = 0;
  }

  private collectInputs(game: GameState): number[] {
    // これから stepGame が生成するのは tick game.tick + 1 の状態。
    // クライアントが「tick k で効く」と予測した入力はその step で適用する。
    const applyingTick = game.tick + 1;
    const inputs: number[] = new Array(MAX_PLAYERS).fill(0);
    for (const p of game.players) {
      const q = this.inputQueue[p.slot];
      if (q) {
        this.pendingKeys[p.slot] = consumeInput(q, applyingTick, this.pendingKeys[p.slot] ?? 0);
      }
      inputs[p.slot] = p.connected ? (this.pendingKeys[p.slot] ?? 0) : 0;
    }
    return inputs;
  }

  /**
   * 1 試合の決着処理。勝者に 1 勝加算し、先取条件を満たしたらシリーズ終了。
   * 満たしていなければ一定時間後に次の試合を自動で開始する。
   */
  private async endMatch(winnerSlot: number): Promise<void> {
    this.stopLoop();
    await this.ctx.storage.delete("matchActive");
    await this.ctx.storage.deleteAlarm();

    // 引き分け(-1)は加算しない
    if (winnerSlot >= 0) this.wins[winnerSlot] = (this.wins[winnerSlot] ?? 0) + 1;

    const champion = this.findChampion();
    this.broadcast({
      t: "gameover",
      winnerSlot,
      wins: [...this.wins],
      winTarget: this.winTarget,
      championSlot: champion,
    });
    // スコアボード用にシリーズ状態も更新して配る
    this.broadcastSeries(champion);

    if (champion !== null) {
      // シリーズ終了 → 待機へ戻す
      this.resetTimer = setTimeout(() => {
        void this.resetToWaiting("");
      }, FINISHED_RESET_MS);
      return;
    }

    // シリーズ続行 → 次の試合を自動開始（Ready を押し直させない）。
    // 前試合の GameState は畳んでおく（残っていると beginMatch が即 return する）
    this.game = null;
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      void this.beginMatch();
    }, NEXT_ROUND_DELAY_MS);
  }

  /** 先取条件を満たした slot。まだなら null */
  private findChampion(): number | null {
    for (let s = 0; s < MAX_PLAYERS; s++) {
      if ((this.wins[s] ?? 0) >= this.winTarget) return s;
    }
    return null;
  }

  private async resetToWaiting(abortReason: string): Promise<void> {
    this.stopLoop();
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.game = null;
    this.pendingKeys.fill(0);
    this.lastSeq.fill(0);
    this.clearInputQueues();
    // シリーズを畳む（winTarget は次のシリーズにも引き継ぐ）
    this.wins.fill(0);
    this.round = 0;

    // 切断済みプレイヤーのスロットを解放し、ready をリセット
    for (const [slot, entry] of [...this.roster.entries()]) {
      if (!this.isSlotConnected(slot)) this.roster.delete(slot);
      else entry.ready = false;
    }
    await this.persistRoster();
    await this.ctx.storage.delete("matchActive");
    await this.ctx.storage.deleteAlarm();

    if (abortReason) this.broadcast({ t: "aborted", reason: abortReason });
    this.broadcastSeries(null);
    this.broadcastRoster();
    this.reportLobby();
  }

  private async teardown(): Promise<void> {
    this.stopLoop();
    if (this.resetTimer !== null) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.startTimer !== null) {
      clearTimeout(this.startTimer);
      this.startTimer = null;
    }
    this.game = null;
    this.roster.clear();
    this.loaded = true;
    this.removeFromLobby();
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ===== ウォッチドッグ =====

  async alarm(): Promise<void> {
    await this.ensureLoaded();
    const matchActive = await this.ctx.storage.get<boolean>("matchActive");
    if (!matchActive) return;

    const stale = Date.now() - this.lastTickAt > 2_000;
    if (this.game === null || stale) {
      // DO が evict されて試合状態が失われた（またはループが死んだ）
      await this.resetToWaiting("server_restart");
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + WATCHDOG_MS);
  }

  // ===== 送信ユーティリティ =====

  private liveSockets(): WebSocket[] {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
  }

  /**
   * 同じ slot を掴んでいる古いソケットを閉じる（except は残す）。
   * attachment を外してから閉じるので、遅れて届く webSocketClose は
   * このスロットを roster から削除しない（新しい接続が持ち主になっている）。
   */
  private closeSocketsForSlot(slot: number, except: WebSocket): void {
    for (const old of this.ctx.getWebSockets()) {
      if (old === except) continue;
      const att = old.deserializeAttachment() as Attachment | null;
      if (att?.slot !== slot) continue;
      old.serializeAttachment(null);
      try {
        old.close(1000, "replaced_by_new_connection");
      } catch {
        // 既に閉じている場合は無視
      }
    }
  }

  private isSlotConnected(slot: number): boolean {
    return this.liveSockets().some((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return att?.slot === slot;
    });
  }

  private send(ws: WebSocket, msg: S2C): void {
    try {
      ws.send(encode(msg));
    } catch {
      // 切断済みは無視
    }
  }

  private broadcast(msg: S2C): void {
    const data = encode(msg);
    for (const ws of this.liveSockets()) {
      try {
        ws.send(data);
      } catch {
        // 切断済みは無視
      }
    }
  }

  private rosterEntries(): RosterEntry[] {
    return [...this.roster.values()]
      .sort((a, b) => a.slot - b.slot)
      .map((r) => ({
        slot: r.slot,
        name: r.name,
        ready: r.ready,
        connected: this.isSlotConnected(r.slot),
      }));
  }

  private broadcastSeries(championSlot: number | null): void {
    this.broadcast({
      t: "series",
      winTarget: this.winTarget,
      wins: [...this.wins],
      round: this.round,
      championSlot,
    });
  }

  private broadcastRoster(): void {
    this.broadcast({
      t: "roster",
      roster: this.rosterEntries(),
      phase: this.game?.phase ?? "waiting",
    });
  }

  private sendWelcome(ws: WebSocket, slot: number, token: string): void {
    this.send(ws, {
      t: "welcome",
      slot,
      token,
      phase: this.game?.phase ?? "waiting",
      roster: this.rosterEntries(),
      winTarget: this.winTarget,
      wins: [...this.wins],
      round: this.round,
      proto: 1,
    });
  }

  private sendStartInfo(ws: WebSocket, game: GameState): void {
    this.send(ws, {
      t: "start",
      seed: 0, // 再接続時は grid が権威（seed からの再生成は不要）
      tick: game.tick,
      countdownTicks: Math.max(0, game.phaseEndsTick - game.tick),
      grid: encodeGrid(game.grid),
      slots: game.players.map((p) => p.slot),
    });
  }
}
