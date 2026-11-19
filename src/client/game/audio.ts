// チップチューン音響エンジン。音源ファイルを使わず Web Audio API で
// SE と BGM をすべて合成する（レトロなドット絵の世界観に合わせた矩形波・三角波・ノイズ）。
//
// ブラウザの自動再生制限のため、AudioContext は最初のユーザー操作
// （pointerdown / keydown）で起動し、それまでの BGM 開始要求は保留しておく。
//
// BGM と SE は別々のバス（GainNode）に流し、個別に ON/OFF できる。
// BGM はさらにバスのゲインで音量を調整する。

export type SeName =
  | "place" // 爆弾設置
  | "boom" // 爆発
  | "pickup" // アイテム取得
  | "skull" // ドクロ（罠）
  | "punch" // ボムパンチ
  | "die" // 死亡
  | "win" // 勝利ジングル
  | "beep" // カウントダウン
  | "beepHigh"; // カウントダウン終了（開始）

type BgmTrack = "waiting" | "battle" | "invincible";

/** MIDI ノート番号 → 周波数 */
function midi(m: number): number {
  return 440 * Math.pow(2, (m - 69) / 12);
}

// ループパターン（null = 休符）。1ステップ = 8分音符、32ステップ = 4小節。
// A マイナー基調で、小節ごとにコードが動くことで単調さを避ける
type Perc = "k" | "h" | "s" | null; // kick / hihat / snare

const BATTLE_STEP_SEC = 0.19; // ≈158bpm
// 構成: A（4小節）→ A'（同じ進行でメロディを1オクターブ上の応答に）→
// ターンアラウンド（2小節の駆け上がり）→ 頭へ。
// ループの継ぎ目を「決めフレーズ→解決」にすることで繰り返し感を薄める
const BATTLE_BASS: Array<number | null> = [
  // A: Am → G → F → E
  45, null, 45, 57, 45, null, 52, null,
  43, null, 43, 55, 43, null, 50, null,
  41, null, 41, 53, 41, null, 48, null,
  40, null, 40, 52, 43, null, 47, null,
  // A': 同じ進行
  45, null, 45, 57, 45, null, 52, null,
  43, null, 43, 55, 43, null, 50, null,
  41, null, 41, 53, 41, null, 48, null,
  40, null, 40, 52, 43, null, 47, null,
  // ターンアラウンド: Dm → E ペダル（8分刻みで畳みかける）
  38, null, 38, 50, 38, null, 45, null,
  40, 40, 40, 40, 40, 40, 47, 47,
];
const BATTLE_LEAD: Array<number | null> = [
  // A
  69, null, 72, 74, 76, null, 74, 72, // 上昇して折り返す
  74, null, 72, 71, 67, null, 71, 72, // G の周りを漂う
  77, null, 76, 74, 72, null, 69, null, // F から下降
  64, null, 68, 71, 76, null, 74, 71, // E（ハーモニックマイナー）
  // A': オクターブ上からの応答
  81, null, 79, 77, 76, null, 77, 79,
  79, null, 77, 76, 74, null, 76, 77,
  77, null, 76, 74, 72, null, 74, 76,
  76, null, 74, 71, 68, null, 71, 74,
  // ターンアラウンド: A マイナーを一気に駆け上がり、頂点 A5 から
  // G#（導音）で吊って頭の A に解決する
  69, 71, 72, 74, 76, 77, 79, 80,
  81, null, null, 76, 80, null, null, null,
];
const PERC_STD: Perc[] = ["k", "h", "s", "h", "k", "h", "s", "h"];
const PERC_FILL: Perc[] = ["k", "h", "s", "h", "k", "s", "s", "s"];
const PERC_ROLL: Perc[] = ["k", "s", "s", "s", "k", "s", "s", "s"]; // スネアロール
const BATTLE_PERC: Perc[] = [
  ...PERC_STD, ...PERC_STD, ...PERC_STD, ...PERC_FILL,
  ...PERC_STD, ...PERC_STD, ...PERC_STD, ...PERC_FILL,
  ...PERC_STD, ...PERC_ROLL,
];

const WAITING_STEP_SEC = 0.3; // ゆったりしたアルペジオ
// 構成: Am → C → G → Em の分散和音 4小節 + 締めのカデンツ 2小節（F → E）で頭へ
const WAITING_BASS: Array<number | null> = [
  33, null, null, null, 40, null, null, null, // A1 + 5度
  36, null, null, null, 43, null, null, null, // C2
  31, null, null, null, 38, null, null, null, // G1
  28, null, null, null, 35, null, null, null, // E1
  29, null, null, null, 36, null, null, null, // F1
  28, null, null, null, 35, null, null, null, // E1
];
const WAITING_LEAD: Array<number | null> = [
  57, 60, 64, null, 60, 64, 69, null, // Am
  60, 64, 67, null, 64, 67, 72, null, // C
  55, 59, 62, null, 59, 62, 67, null, // G
  52, 55, 59, null, 55, 59, 64, null, // Em
  // カデンツ: アルペジオをやめて歌うようなフレーズで締める
  72, null, 71, 69, 65, null, 67, 69,
  71, null, 68, null, 64, null, null, null, // B → G#（導音）→ E で頭の Am へ
];
const WAITING_PERC: Perc[] = new Array<Perc>(WAITING_LEAD.length).fill(null);

// 無敵 BGM: 対戦曲より速く、全音音階の駆け上がりで浮遊感を出す。
// 短い 2 小節ループにして「早く終わる前に暴れろ」という感じにする
const INVINCIBLE_STEP_SEC = 0.105; // ≈286bpm 相当の16分
const INVINCIBLE_BASS: Array<number | null> = [
  // 半音ずつ上がるクロマチックなペダル。落ち着かせない
  45, 45, 46, 46, 47, 47, 48, 48,
  49, 49, 50, 50, 51, 51, 52, 52,
];
const INVINCIBLE_LEAD: Array<number | null> = [
  // 全音音階（ホールトーン）の上行 → 頂点から一気に落として頭へ
  69, 71, 73, 75, 77, 79, 81, 83,
  85, 83, 81, 79, 77, 75, 73, 71,
];
const INVINCIBLE_PERC: Perc[] = [
  "k", "h", "h", "h", "k", "h", "h", "h",
  "k", "h", "h", "h", "k", "s", "s", "s",
];

interface TrackDef {
  stepSec: number;
  bass: Array<number | null>;
  lead: Array<number | null>;
  perc: Perc[];
  bassGain: number;
  leadGain: number;
}

// トラック定義。既存2曲の値は元の三項演算子と同一（音を変えないこと）
const TRACKS: Record<BgmTrack, TrackDef> = {
  waiting: {
    stepSec: WAITING_STEP_SEC,
    bass: WAITING_BASS,
    lead: WAITING_LEAD,
    perc: WAITING_PERC,
    bassGain: 0.1,
    leadGain: 0.035,
  },
  battle: {
    stepSec: BATTLE_STEP_SEC,
    bass: BATTLE_BASS,
    lead: BATTLE_LEAD,
    perc: BATTLE_PERC,
    bassGain: 0.14,
    leadGain: 0.05,
  },
  invincible: {
    stepSec: INVINCIBLE_STEP_SEC,
    bass: INVINCIBLE_BASS,
    lead: INVINCIBLE_LEAD,
    perc: INVINCIBLE_PERC,
    bassGain: 0.13,
    leadGain: 0.06,
  },
};

const MASTER_GAIN = 0.3;
const KEY_BGM = "bm-bgm"; // "1" | "0"
const KEY_SE = "bm-se"; // "1" | "0"
const KEY_BGM_VOL = "bm-bgm-vol"; // 0〜100 の整数
const KEY_LEGACY_MUTE = "bm-mute"; // 旧: 全体ミュート（"1" でミュート）

/** ON/OFF 設定を読む。未保存なら旧ミュート設定を引き継ぐ */
function loadFlag(key: string): boolean {
  const v = localStorage.getItem(key);
  if (v !== null) return v === "1";
  return localStorage.getItem(KEY_LEGACY_MUTE) !== "1";
}

/** BGM 音量（0〜1）を読む。未保存・不正値は最大（従来と同じ音量） */
function loadVolume(): number {
  const raw = localStorage.getItem(KEY_BGM_VOL);
  const v = raw === null ? NaN : Number(raw);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 100)) : 1;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgmBus: GainNode | null = null;
  private seBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private bgmOn: boolean;
  private seOn: boolean;
  private bgmVol: number; // 0〜1（スライダー位置）

  private desiredBgm: BgmTrack | null = null;
  private playingBgm: BgmTrack | null = null;
  private bgmTimer: number | null = null;
  private nextNoteTime = 0;
  private stepIndex = 0;
  private timers: number[] = [];

  constructor() {
    this.bgmOn = loadFlag(KEY_BGM);
    this.seOn = loadFlag(KEY_SE);
    this.bgmVol = loadVolume();
    // 自動再生制限の解除。running になるまで何度でも試みる
    const unlock = (): void => this.wake();
    window.addEventListener("pointerdown", unlock);
    window.addEventListener("keydown", unlock);
  }

  get bgmEnabled(): boolean {
    return this.bgmOn;
  }

  get seEnabled(): boolean {
    return this.seOn;
  }

  /** BGM 音量（0〜1） */
  get bgmVolume(): number {
    return this.bgmVol;
  }

  setBgmEnabled(on: boolean): void {
    this.bgmOn = on;
    localStorage.setItem(KEY_BGM, on ? "1" : "0");
    this.applyGains(true);
    // 設定操作（クリック）自体がユーザー操作なので、ここで起動・再開まで済ませる
    this.wake();
  }

  setSeEnabled(on: boolean): void {
    this.seOn = on;
    localStorage.setItem(KEY_SE, on ? "1" : "0");
    this.applyGains(true);
    this.wake();
  }

  /** BGM 音量を 0〜1 で設定する。再生中の曲は止めずに音量だけ変える */
  setBgmVolume(vol: number): void {
    this.bgmVol = Math.min(1, Math.max(0, vol));
    localStorage.setItem(KEY_BGM_VOL, String(Math.round(this.bgmVol * 100)));
    this.applyGains(false);
  }

  /** BGM を切り替える（null で停止）。context 未起動なら起動後に反映される */
  setBgm(track: BgmTrack | null): void {
    this.clearTimers();
    this.desiredBgm = track;
    this.applyBgm();
  }

  /**
   * 試合開始の演出: カウントダウン中は1秒ごとにビープ、
   * 終わりに高音ビープを鳴らして対戦 BGM を始める
   */
  matchStart(countdownMs: number): void {
    this.setBgm(null);
    for (let ms = 0; ms < countdownMs - 500; ms += 1000) {
      this.timers.push(
        window.setTimeout(() => this.playSe("beep"), ms),
      );
    }
    this.timers.push(
      window.setTimeout(() => {
        this.playSe("beepHigh");
        this.setBgm("battle");
      }, countdownMs),
    );
  }

  playSe(name: SeName): void {
    if (!this.seOn) return;
    const ctx = this.ensureCtx();
    if (ctx.state !== "running") return; // 未解錠のまま溜めると解錠時に一斉再生されてしまう
    switch (name) {
      case "place":
        this.blip("square", 320, 180, 0.08, 0.22);
        break;
      case "boom": {
        // 「ドーン!」の3層構成:
        // 高域のクラック（破裂の瞬間）→ 長い轟き（尾を引くノイズ）→ サブベースの胴鳴り
        this.noise(0.12, 6500, 1500, 0.7);
        this.noise(1.1, 800, 60, 0.9);
        this.blip("sine", 150, 32, 0.9, 0.9);
        this.blip("triangle", 95, 30, 0.5, 0.5, 0.02);
        break;
      }
      case "pickup":
        this.blip("square", 660, 660, 0.06, 0.16);
        this.blip("square", 990, 990, 0.1, 0.16, 0.07);
        break;
      case "skull":
        this.blip("sawtooth", 420, 110, 0.35, 0.2);
        break;
      case "punch":
        // 振り抜きのスウィープ
        this.blip("square", 160, 760, 0.12, 0.22);
        break;
      case "die":
        this.blip("square", 440, 440, 0.09, 0.2);
        this.blip("square", 330, 330, 0.09, 0.2, 0.1);
        this.blip("square", 220, 110, 0.25, 0.2, 0.2);
        break;
      case "win":
        this.blip("square", midi(69), midi(69), 0.1, 0.18);
        this.blip("square", midi(73), midi(73), 0.1, 0.18, 0.12);
        this.blip("square", midi(76), midi(76), 0.1, 0.18, 0.24);
        this.blip("square", midi(81), midi(81), 0.3, 0.2, 0.36);
        break;
      case "beep":
        this.blip("square", 440, 440, 0.08, 0.15);
        break;
      case "beepHigh":
        this.blip("square", 880, 880, 0.22, 0.18);
        break;
    }
  }

  // ===== 内部 =====

  private ensureCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.master.gain.value = MASTER_GAIN;
    this.bgmBus = this.ctx.createGain();
    this.bgmBus.gain.value = this.bgmGain();
    this.bgmBus.connect(this.master);
    this.seBus = this.ctx.createGain();
    this.seBus.gain.value = this.seOn ? 1 : 0;
    this.seBus.connect(this.master);
    // 爆発などの大きな音が重なっても割れないよう、最終段で軽く潰す
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18;
    comp.knee.value = 12;
    comp.ratio.value = 6;
    comp.attack.value = 0.002;
    comp.release.value = 0.15;
    this.master.connect(comp).connect(this.ctx.destination);
    return this.ctx;
  }

  /** AudioContext を起動（必要なら再開）して BGM の状態を合わせる。両方 OFF なら起動しない */
  private wake(): void {
    if (!this.bgmOn && !this.seOn) {
      this.applyBgm();
      return;
    }
    const ctx = this.ensureCtx();
    if (ctx.state === "suspended") {
      void ctx.resume().then(() => this.applyBgm());
    } else {
      this.applyBgm();
    }
  }

  /** BGM バスのゲイン。スライダーは二乗カーブにして聴感上なめらかに変化させる */
  private bgmGain(): number {
    return this.bgmOn ? this.bgmVol * this.bgmVol : 0;
  }

  /**
   * 設定をバスのゲインへ反映する。
   * immediate = true は ON/OFF 用（鳴っている音の尻尾ごと即座に消す/戻す）、
   * false は音量スライダー用（ジッパーノイズを避けて短く追従させる）
   */
  private applyGains(immediate: boolean): void {
    const ctx = this.ctx;
    if (!ctx || !this.bgmBus || !this.seBus) return;
    const now = ctx.currentTime;
    this.bgmBus.gain.cancelScheduledValues(now);
    if (immediate) this.bgmBus.gain.setValueAtTime(this.bgmGain(), now);
    else this.bgmBus.gain.setTargetAtTime(this.bgmGain(), now, 0.015);
    this.seBus.gain.cancelScheduledValues(now);
    this.seBus.gain.setValueAtTime(this.seOn ? 1 : 0, now);
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /** 単音: 周波数 f0 → f1 へスウィープしつつ短いエンベロープで減衰。dest 省略時は SE バスへ出す */
  private blip(
    type: OscillatorType,
    f0: number,
    f1: number,
    dur: number,
    vol: number,
    delay = 0,
    dest: AudioNode = this.seBus!,
  ): void {
    const ctx = this.ctx!;
    const t = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(gain).connect(dest);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }

  /** ホワイトノイズをローパスで丸めたバースト（爆発・ドラム用） */
  private noise(
    dur: number,
    cutoffStart: number,
    cutoffEnd: number,
    vol: number,
    delay = 0,
    dest: AudioNode = this.seBus!,
  ): void {
    const ctx = this.ctx!;
    if (!this.noiseBuf) {
      const len = ctx.sampleRate * 2; // 2秒ぶん使い回す
      this.noiseBuf = ctx.createBuffer(1, len, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(cutoffStart, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(30, cutoffEnd), t + dur);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(filter).connect(gain).connect(dest);
    src.start(t);
    src.stop(t + dur);
  }

  /** BGM 用パーカッション1発 */
  private drum(kind: Exclude<Perc, null>, delay: number): void {
    const bus = this.bgmBus!;
    switch (kind) {
      case "k": // キック: サイン波の急降下
        this.blip("sine", 130, 40, 0.12, 0.35, delay, bus);
        break;
      case "h": // ハイハット: ごく短い高域ノイズ
        this.noise(0.03, 9000, 6000, 0.06, delay, bus);
        break;
      case "s": // スネア: 中域ノイズ + 短いトーン
        this.noise(0.09, 3200, 1200, 0.16, delay, bus);
        this.blip("triangle", 210, 170, 0.06, 0.1, delay, bus);
        break;
    }
  }

  /** desiredBgm と実際の再生状態を一致させる */
  private applyBgm(): void {
    const want = this.bgmOn ? this.desiredBgm : null;
    const ctx = this.ctx;
    if (want === null || !ctx || ctx.state !== "running") {
      this.stopBgm();
      return;
    }
    if (this.playingBgm === want) return;
    this.stopBgm();
    this.playingBgm = want;
    this.stepIndex = 0;
    this.nextNoteTime = ctx.currentTime + 0.05;
    // 先読みスケジューラ: 100ms ごとに 200ms 先までのノートを予約する
    this.bgmTimer = window.setInterval(() => this.scheduleAhead(), 100);
  }

  private stopBgm(): void {
    if (this.bgmTimer !== null) {
      clearInterval(this.bgmTimer);
      this.bgmTimer = null;
    }
    this.playingBgm = null;
  }

  private scheduleAhead(): void {
    const ctx = this.ctx;
    if (!ctx || this.playingBgm === null) return;
    const { stepSec, bass, lead, perc, bassGain, leadGain } = TRACKS[this.playingBgm];
    while (this.nextNoteTime < ctx.currentTime + 0.2) {
      const i = this.stepIndex;
      const delay = this.nextNoteTime - ctx.currentTime;
      const b = bass[i];
      const l = lead[i];
      const d = perc[i];
      if (b !== null && b !== undefined) {
        this.blip("triangle", midi(b), midi(b), stepSec * 0.9, bassGain, delay, this.bgmBus!);
      }
      if (l !== null && l !== undefined) {
        this.blip("square", midi(l), midi(l), stepSec * 0.6, leadGain, delay, this.bgmBus!);
      }
      if (d !== null && d !== undefined) this.drum(d, delay);
      this.nextNoteTime += stepSec;
      this.stepIndex = (i + 1) % bass.length;
    }
  }
}
