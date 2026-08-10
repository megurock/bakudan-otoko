// ゲーム全体の定数。サーバー/クライアントで共有される。
// shared 配下は環境非依存・決定論（Math.random / Date.now / 浮動小数点 禁止）。

export const TICK_RATE = 20;
export const TICK_MS = 50;

// マップ寸法（外周壁込み）。奇数×奇数で古典的な格子柱レイアウトが成立する
export const MAP_W = 17;
export const MAP_H = 15;

// 固定小数点: 1タイル = 256 units（2の冪）
export const SUB = 256;
export const HALF_TILE = SUB / 2;

// プレイヤーのヒットボックス半幅 = 0.375 タイル（寛容め）
export const PLAYER_HALF = 96;

// 移動速度 (units/tick)。BASE=32 → 2.5 タイル/秒 @20tick
export const BASE_SPEED = 32;
export const SPEED_INC = 8;
export const SPEED_MAX = 64;

// 爆弾
export const FUSE_TICKS = 50; // 2.5 秒
export const BLAST_TICKS = 10; // 爆風持続 0.5 秒
export const FIRE_MAX = 8;
export const BOMB_CAP_MAX = 8;

// コーナースライド: タイル中心からのズレがこれ以下なら通路へ吸い込む
export const CORNER_SLIDE_MAX = 112;

// ソフトブロック配置率・アイテムドロップ率（%）
export const SOFT_FILL_PCT = 75;
export const DROP_PCT = 30;

// ドクロデバフの持続時間と、その間に落とされる能力値
export const SKULL_TICKS = 10 * TICK_RATE; // 10 秒
export const SKULL_FIRE = 1;
export const SKULL_BOMB_CAP = 1;
export const SKULL_SPEED = 24; // BASE_SPEED(32) より遅い

// 壁すり抜け（レア）: 1マップに確定でこの範囲の個数だけ隠す。
// 通常のドロップ抽選とは別枠なので「1ゲームに1〜2回」が保証される
export const WALLPASS_MIN_COUNT = 1;
export const WALLPASS_MAX_COUNT = 2;

// フェーズ時間
// 全員 Ready から実際の開始までの猶予（ms）。
// この間に Ready を外せば中止できる。入室待ちの相手がいるときの押し間違いを救う
export const START_GRACE_MS = 5000;

export const COUNTDOWN_TICKS = 3 * TICK_RATE;
export const MATCH_MAX_TICKS = 180 * TICK_RATE; // 3分で引き分け
export const FINISHED_RESET_MS = 8000;

export const MAX_PLAYERS = 6;

// 何勝先取（シリーズ）。選べる値と既定値
export const WIN_TARGET_OPTIONS = [1, 2, 3, 5] as const;
export const DEFAULT_WIN_TARGET = 1;
// 次の試合が自動で始まるまでの間（ms）。勝敗を見せてから次へ
export const NEXT_ROUND_DELAY_MS = 5000;

// スポーン地点（タイル座標）: 四隅 + 上下辺中央
export const SPAWNS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [15, 13],
  [15, 1],
  [1, 13],
  [8, 1],
  [8, 13],
];
