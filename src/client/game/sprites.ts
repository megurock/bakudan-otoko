// ドット絵スプライトのコード生成。
// 文字列ピクセルマップ + パレット → Canvas に1回焼き込んでキャッシュする。

export const SPRITE_PX = 16;

// slot 別カラー（primary / shade）: 白・黒・赤・青・緑・黄
export const SLOT_THEMES = [
  { primary: "#f2f2f2", shade: "#b8b8c8", label: "#ffffff" },
  { primary: "#4a4a5a", shade: "#2e2e3a", label: "#9d9dbb" },
  { primary: "#e74c3c", shade: "#a83226", label: "#ff8f84" },
  { primary: "#3f8ce8", shade: "#2a5fa8", label: "#8fc1ff" },
  { primary: "#2ecc71", shade: "#1e8a4c", label: "#7dedaf" },
  { primary: "#f1c40f", shade: "#b3910a", label: "#ffe375" },
] as const;

const SKIN = "#ffd9b3";
const BLACK = "#1a1a1a";
const GLOVE = "#d94f6b";

// ===== ピクセルマップ =====
// 記号: p=primary s=shade f=肌 e=目 k=黒 g=手足アクセント .=透明

const PLAYER_DOWN_0 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kpffffffpk...",
  "...kpfeffefpk...",
  "...kpffffffpk...",
  "....kffffffk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kgpppppppgk..",
  "....kpppppppk...",
  ".....kppppk.....",
  "....kssk.kssk...",
  "....kkk...kkk...",
];

const PLAYER_DOWN_1 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kpffffffpk...",
  "...kpfeffefpk...",
  "...kpffffffpk...",
  "....kffffffk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "..kgpppppppgk...",
  "...kpppppppk....",
  ".....kppppk.....",
  "...kssk.kssk....",
  "...kkk...kkk....",
];

const PLAYER_UP_0 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "....kssssssk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kgpppppppgk..",
  "....kpppppppk...",
  ".....kppppk.....",
  "....kssk.kssk...",
  "....kkk...kkk...",
];

const PLAYER_UP_1 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kppppppppk...",
  "....kssssssk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "..kgpppppppgk...",
  "...kpppppppk....",
  ".....kppppk.....",
  "...kssk.kssk....",
  "...kkk...kkk....",
];

// 右向き（左は水平ミラー）
const PLAYER_RIGHT_0 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kpppfffffk...",
  "...kpppfeffek...",
  "...kpppfffffk...",
  "....kpsffffk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "....kpppppppgk..",
  "....kppppppk....",
  ".....kppppk.....",
  ".....kssksk.....",
  ".....kkk.kk.....",
];

const PLAYER_RIGHT_1 = [
  "................",
  ".....kkkkkk.....",
  "....kppppppk....",
  "...kppppppppk...",
  "...kppppppppk...",
  "...kpppfffffk...",
  "...kpppfeffek...",
  "...kpppfffffk...",
  "....kpsffffk....",
  ".....kkkkkk.....",
  "....kppppppk....",
  "....kpppppppgk..",
  "....kppppppk....",
  ".....kppppk.....",
  "....ksk..ksk....",
  "....kk....kk....",
];

const BOMB_0 = [
  "........gg......",
  ".......g........",
  "......kk........",
  ".....kkkkkk.....",
  "....kkkkkkkk....",
  "...kkhhkkkkkk...",
  "...khhkkkkkkk...",
  "...khkkkkkkkk...",
  "...kkkkkkkkkk...",
  "...kkkkkkkkkk...",
  "...kkkkkkkkkk...",
  "....kkkkkkkk....",
  ".....kkkkkk.....",
  "................",
  "................",
  "................",
];

const BOMB_1 = [
  "........gg......",
  ".......gg.......",
  "......kk........",
  ".....kkkkkk.....",
  "....kkkkkkkk....",
  "...kkhhkkkkkk...",
  "..kkhhkkkkkkkk..",
  "..kkhkkkkkkkkk..",
  "..kkkkkkkkkkkk..",
  "..kkkkkkkkkkkk..",
  "..kkkkkkkkkkkk..",
  "...kkkkkkkkkk...",
  "....kkkkkkkk....",
  ".....kkkkkk.....",
  "................",
  "................",
];

const ITEM_FIRE = [
  "................",
  ".......r........",
  "......rr........",
  "......rrr.......",
  ".....rrrr.......",
  ".....rrrrr..r...",
  "....rrorrrr.rr..",
  "....rooorrrrrr..",
  "...rroooorrrrr..",
  "...roooyoorrrr..",
  "...rooyyyoorrr..",
  "...rooyyyyoorr..",
  "....royyyyor....",
  "....rooyyoor....",
  ".....rooorr.....",
  "......rrrr......",
];

const ITEM_BOMB = [
  "................",
  "........g.......",
  ".......g........",
  "......kk........",
  ".....kkkkkk.....",
  "....khhkkkkk....",
  "...khhkkkkkkk...",
  "...khkkkkkkkk...",
  "...kkkkkkkkkk...",
  "...kkkkkkkkkk...",
  "....kkkkkkkk....",
  ".....kkkkkk.....",
  "......kkkk......",
  "................",
  "....b......b....",
  "...bbb....bbb...",
];

const ITEM_SPEED = [
  "................",
  "................",
  "....bb..........",
  "....bbb.........",
  "....bbbb........",
  "....bbbbb.......",
  "....bbbbbb......",
  "....bbbbbbb.....",
  "....bbbbbbbb....",
  "....bbbbbbb.....",
  "....bbbbbb......",
  "....bbbbb..y....",
  "....bbbb..yy....",
  "....bbb..yyy....",
  "....bb..yyyy....",
  "................",
];

// 貫通爆弾: 縦に割れたブロック（茶）を、右向きの矢（赤）が貫いている
const ITEM_PIERCE = [
  "................",
  "................",
  ".bb.........bb..",
  ".bb.........bb..",
  ".bb......p..bb..",
  ".bb......pp.bb..",
  ".bb.......pppb..",
  ".ppppppppppppp..",
  ".ppppppppppppp..",
  ".bb.......pppb..",
  ".bb......pp.bb..",
  ".bb......p..bb..",
  ".bb.........bb..",
  ".bb.........bb..",
  "................",
  "................",
];

// 壁すり抜け（レア）: 半透明のオバケ。裾が波打つシルエット
const ITEM_WALLPASS = [
  "................",
  ".....gggggg.....",
  "....gggggggg....",
  "...gggggggggg...",
  "...ggkkggkkgg...",
  "...ggkkggkkgg...",
  "...gggggggggg...",
  "...ggggkkgggg...",
  "...gggggggggg...",
  "...gggggggggg...",
  "...gggggggggg...",
  "...gg.ggg.gg....",
  "...g...g...g....",
  "................",
  "................",
  "................",
];

// パンチグローブ（レア）: 右向きのボクシンググローブ。手首に白いカフ
const ITEM_PUNCH = [
  "................",
  "................",
  ".....ddddd......",
  "....dgggggd.....",
  "...dgggggggd....",
  "..wdggggggggd...",
  "..wgggggggggd...",
  "..wgggggggggd...",
  "..wdggggggggd...",
  "...dggdggggd....",
  "....ddgggggd....",
  "......dggggd....",
  ".......dddd.....",
  "................",
  "................",
  "................",
];

// ドクロ（罠アイテム）: 大きな眼窩と歯で「危険」と分かる形に
const ITEM_SKULL = [
  "................",
  "................",
  "....wwwwwwww....",
  "...wwwwwwwwww...",
  "..wwwwwwwwwwww..",
  "..wwkkkwwkkkww..",
  "..wwkkkwwkkkww..",
  "..wwwwwwwwwwww..",
  "...wwwwkkwwww...",
  "....wwwwwwww....",
  "....wwwwwwww....",
  ".....wkwkwkw....",
  ".....wkwkwkw....",
  "......wwww......",
  "................",
  "................",
];

const TILE_FLOOR_A = [
  "gggggggggggggggg",
  "gGggggggggggGggg",
  "gggggggggggggggg",
  "ggggggGggggggggg",
  "gggggggggggggggg",
  "gGgggggggggGgggg",
  "gggggggggggggggg",
  "ggggggggGggggggg",
  "gggGgggggggggggg",
  "gggggggggggggggg",
  "ggggggggggGggggg",
  "gggggGgggggggggg",
  "gggggggggggggggg",
  "gGggggggggggggGg",
  "gggggggGgggggggg",
  "gggggggggggggggg",
];

const TILE_HARD = [
  "hhhhhhhhhhhhhhhh",
  "hLLLLLLLLLLLLLLd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hLhhhhhhhhhhhhdd",
  "hddddddddddddddd",
  "dddddddddddddddd",
];

const TILE_SOFT = [
  "bbbbbbbbbbbbbbbb",
  "bBBBBBBBoBBBBBBd",
  "bBBBBBBBoBBBBBBd",
  "booooooooooooood",
  "bBBBoBBBBBBoBBBd",
  "bBBBoBBBBBBoBBBd",
  "booooooooooooood",
  "bBBBBBBoBBBBBBBd",
  "bBBBBBBoBBBBBBBd",
  "booooooooooooood",
  "bBBoBBBBBBBBoBBd",
  "bBBoBBBBBBBBoBBd",
  "booooooooooooood",
  "bBBBBBoBBBBBBBBd",
  "bBBBBBoBBBBBBBBd",
  "bddddddddddddddd",
];

// ===== ベイク =====

type Palette = Record<string, string>;

function bake(pixels: string[], palette: Palette): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = SPRITE_PX;
  c.height = SPRITE_PX;
  const g = c.getContext("2d")!;
  for (let y = 0; y < SPRITE_PX; y++) {
    const row = pixels[y] ?? "";
    for (let x = 0; x < SPRITE_PX; x++) {
      const ch = row[x];
      if (!ch || ch === ".") continue;
      const color = palette[ch];
      if (!color) continue;
      g.fillStyle = color;
      g.fillRect(x, y, 1, 1);
    }
  }
  return c;
}

function mirror(src: HTMLCanvasElement): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const g = c.getContext("2d")!;
  g.translate(src.width, 0);
  g.scale(-1, 1);
  g.drawImage(src, 0, 0);
  return c;
}

export interface SpriteSheet {
  // players[slot][dir][frame] — dir: 0=Up 1=Down 2=Left 3=Right
  players: HTMLCanvasElement[][][];
  bomb: HTMLCanvasElement[];
  items: HTMLCanvasElement[]; // kind順: Fire, Bomb, Speed
  floor: HTMLCanvasElement;
  hard: HTMLCanvasElement;
  soft: HTMLCanvasElement;
}

let cached: SpriteSheet | null = null;

export function getSprites(): SpriteSheet {
  if (cached) return cached;

  const players: HTMLCanvasElement[][][] = [];
  for (const theme of SLOT_THEMES) {
    const pal: Palette = {
      p: theme.primary,
      s: theme.shade,
      f: SKIN,
      e: BLACK,
      k: BLACK,
      g: GLOVE,
    };
    const down = [bake(PLAYER_DOWN_0, pal), bake(PLAYER_DOWN_1, pal)];
    const up = [bake(PLAYER_UP_0, pal), bake(PLAYER_UP_1, pal)];
    const right = [bake(PLAYER_RIGHT_0, pal), bake(PLAYER_RIGHT_1, pal)];
    const left = right.map(mirror);
    players.push([up, down, left, right]);
  }

  const bombPal: Palette = { k: "#1c1c24", h: "#5a5a6e", g: "#ff9f1a" };
  const itemFirePal: Palette = { r: "#e8342a", o: "#ff8c1a", y: "#ffe14d" };
  const itemBombPal: Palette = { ...bombPal, b: "#ffe14d" };
  const itemSpeedPal: Palette = { b: "#3f8ce8", y: "#ffe14d" };
  const itemPiercePal: Palette = { p: "#e8342a", b: "#7a4a1e" };
  const itemSkullPal: Palette = { w: "#f0f0f0", k: "#1a1a1a" };
  const itemWallPassPal: Palette = { g: "#9b7fe8", k: "#2a1a4a" };
  // プレイヤースプライトの手袋色（GLOVE）と揃えて「手」を連想させる
  const itemPunchPal: Palette = { g: GLOVE, d: "#7a1f33", w: "#f0f0f0" };
  const floorPal: Palette = { g: "#3a9e3a", G: "#349234" };
  const hardPal: Palette = { h: "#8a8a96", L: "#b4b4c0", d: "#5c5c66" };
  const softPal: Palette = { b: "#c47a3d", B: "#b5651d", o: "#8a4a12", d: "#6e3a0e" };

  const itemBg = (inner: HTMLCanvasElement): HTMLCanvasElement => {
    // アイテムは白フチの丸型パネルに載せる（視認性）
    const c = document.createElement("canvas");
    c.width = SPRITE_PX;
    c.height = SPRITE_PX;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f8f4e8";
    g.beginPath();
    g.arc(8, 8, 7.5, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = "#1a1a1a";
    g.lineWidth = 1;
    g.stroke();
    g.drawImage(inner, 0, 0);
    return c;
  };

  cached = {
    players,
    bomb: [bake(BOMB_0, bombPal), bake(BOMB_1, bombPal)],
    items: [
      itemBg(bake(ITEM_FIRE, itemFirePal)),
      itemBg(bake(ITEM_BOMB, itemBombPal)),
      itemBg(bake(ITEM_SPEED, itemSpeedPal)),
      itemBg(bake(ITEM_PIERCE, itemPiercePal)),
      itemBg(bake(ITEM_SKULL, itemSkullPal)),
      itemBg(bake(ITEM_WALLPASS, itemWallPassPal)),
      itemBg(bake(ITEM_PUNCH, itemPunchPal)),
    ],
    floor: bake(TILE_FLOOR_A, floorPal),
    hard: bake(TILE_HARD, hardPal),
    soft: bake(TILE_SOFT, softPal),
  };
  return cached;
}
