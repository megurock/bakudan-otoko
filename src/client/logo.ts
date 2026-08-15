// タイトルロゴ: ドット絵の爆弾 SVG + レトロシャドウのロゴタイプ。
// ロビーと遊び方ページで共用する。

// sprites.ts と同じ流儀のピクセルマップ。
// k=本体 h=ハイライト f=導火線 o=火花の芯 a/b=交互に点滅する火花

const BOMB_MAP = [
  "................",
  ".........bab....",
  ".........aoa....",
  ".........fab....",
  "........f.......",
  "......kkkkk.....",
  ".....kkkkkkk....",
  "....khhkkkkkk...",
  "....khkkkkkkk...",
  "...kkkkkkkkkkk..",
  "...kkkkkkkkkkk..",
  "....kkkkkkkkk...",
  "....kkkkkkkkk...",
  ".....kkkkkkk....",
  "......kkkkk.....",
  "................",
];

const BOMB_COLORS: Record<string, string> = {
  k: "#2b2b3c",
  h: "#767692",
  f: "#a08a5a",
  o: "#ff9f1a",
  a: "#ffe14d",
  b: "#ffe14d",
};

function bombSvg(): string {
  const cells: Record<string, string[]> = { base: [], a: [], b: [] };
  BOMB_MAP.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const c = row[x]!;
      if (c === ".") continue;
      const rect = `<rect x="${x}" y="${y}" width="1" height="1" fill="${BOMB_COLORS[c]}"/>`;
      cells[c === "a" || c === "b" ? c : "base"]!.push(rect);
    }
  });
  return (
    `<svg class="lobby-bomb" viewBox="0 0 16 16" shape-rendering="crispEdges"` +
    ` role="img" aria-label="爆弾" xmlns="http://www.w3.org/2000/svg">` +
    `<g>${cells.base!.join("")}</g>` +
    `<g class="spark-a">${cells.a!.join("")}</g>` +
    `<g class="spark-b">${cells.b!.join("")}</g>` +
    `</svg>`
  );
}

/** 爆弾 + 眉ラベル + タイトルロゴ。eyebrow でページごとの文脈を出す */
export function logoHtml(eyebrow: string): string {
  return `
    <span class="lobby-bomb-wrap">${bombSvg()}</span>
    <p class="lobby-eyebrow">${eyebrow}</p>
    <h1 class="lobby-title">爆弾男</h1>
  `;
}
