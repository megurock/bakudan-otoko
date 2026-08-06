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

// フェーズ時間
export const COUNTDOWN_TICKS = 3 * TICK_RATE;
export const MATCH_MAX_TICKS = 180 * TICK_RATE; // 3分で引き分け
export const FINISHED_RESET_MS = 8000;

export const MAX_PLAYERS = 6;

// スポーン地点（タイル座標）: 四隅 + 上下辺中央
export const SPAWNS: ReadonlyArray<readonly [number, number]> = [
  [1, 1],
  [15, 13],
  [15, 1],
  [1, 13],
  [8, 1],
  [8, 13],
];
