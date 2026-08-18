export const enum Tile {
  Floor = 0,
  Hard = 1,
  Soft = 2,
}

export const enum Dir {
  Up = 0,
  Down = 1,
  Left = 2,
  Right = 3,
}

export const enum Powerup {
  Fire = 0,
  Bomb = 1,
  Speed = 2,
  /** 貫通爆弾: 爆風がソフトブロックで止まらず、レンジ分まっすぐ突き抜ける */
  Pierce = 3,
  /** ドクロ: 一定時間 fire/bombCap/speed が最低値に落ちるデバフ（罠） */
  Skull = 4,
  /** 壁すり抜け: 1チャージにつき1回、ブロックの中を通り抜けられる（レア） */
  WallPass = 5,
  /** パンチグローブ: 隣接する爆弾を向いている方向へ飛ばせる（レア・永続） */
  Punch = 6,
}

// 入力の 5bit ビットマスク
export const enum Key {
  Up = 1,
  Down = 2,
  Left = 4,
  Right = 8,
  Bomb = 16,
}

export type Phase = "waiting" | "countdown" | "playing" | "finished";

export interface Player {
  slot: number; // 0..5（処理順 = slot 昇順。決定論の要）
  x: number; // 中心座標（固定小数点 units）
  y: number;
  dir: Dir;
  alive: boolean;
  connected: boolean;
  speed: number; // units/tick
  fire: number; // 爆風レンジ
  bombCap: number; // 同時設置数
  bombsActive: number;
  pierce: boolean; // 貫通爆弾を持っているか
  punch: boolean; // パンチグローブを持っているか
  skullTicks: number; // ドクロデバフの残り tick（0=なし）
  wallPass: number; // 壁すり抜けの残りチャージ（壁から抜け出た瞬間に1消費）
  inSoftWall: boolean; // 中心タイルがソフトブロック内か（チャージ消費のエッジ検出用）
  keys: number; // 現在押下中ビットマスク
  prevKeys: number; // 爆弾ボタンのエッジ検出用
}

export interface Bomb {
  id: number;
  cx: number; // タイル座標。パンチ発動時に着地タイルへ即時確定する（着地マスの予約を兼ねる）
  cy: number;
  ownerSlot: number;
  fuse: number; // 残り tick
  range: number; // 設置時点の owner.fire をコピー
  pierce: boolean; // 設置時点の owner.pierce をコピー
  passableBy: number; // 設置時にこのマスへ重なっていたプレイヤーのビットマスク
  flyTicks: number; // パンチ飛翔の残り tick（0=接地）。飛翔中は当たり判定・誘爆の対象外
  flyFromCx: number; // 飛翔の発射元タイル（描画用。接地中は cx/cy と同値）
  flyFromCy: number;
  flyDir: Dir; // 飛翔方向（描画用。ラップすると from→cx の直線では向きが分からない）
  flyDist: number; // 飛翔の総マス数（ラップ跨ぎ込みのホップ数。0=接地）
}

// 「1マス = 1爆風エンティティ」
export interface Blast {
  cx: number;
  cy: number;
  dir: Dir; // 描画用（腕の向き）
  shape: 0 | 1 | 2; // 0=中心 1=腕 2=先端
  ticks: number; // 残り tick
}

export interface Item {
  cx: number;
  cy: number;
  kind: Powerup;
  revealTick: number; // このtickまで非表示・取得不可
}

// 1 tick 中に発生した演出イベント（transient、毎tickクリア）
export type GameEvent =
  | ["boom", number, number] // cx, cy
  | ["die", number] // slot
  | ["pickup", number, number] // slot, kind
  | ["place", number] // slot
  | ["punch", number]; // slot

export interface GameState {
  tick: number;
  phase: Phase;
  phaseEndsTick: number; // countdown 終了 tick
  seed: number; // PRNG 状態（消費のたび更新）
  nextId: number;
  grid: Uint8Array; // MAP_W * MAP_H
  hiddenItems: Uint8Array; // 0=なし, kind+1
  players: Player[];
  bombs: Bomb[];
  blasts: Blast[];
  items: Item[];
  winnerSlot: number | null; // -1=引き分け, null=未決着
  // transient（毎 tick クリア。スナップショット構築用）
  events: GameEvent[];
  gridDiffs: Array<[number, number, number]>; // cx, cy, tile
}

export type InputMap = ReadonlyArray<number>; // slot → keys ビットマスク
