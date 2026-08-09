// 遊び方画面。実際のゲームで使うスプライトをそのまま並べるので、
// 説明の見た目と本編の見た目が必ず一致する。

import { SKULL_TICKS, TICK_RATE } from "../shared/constants";
import { getSprites } from "./game/sprites";
import { Powerup } from "../shared/types";

interface ItemDoc {
  kind: Powerup;
  name: string;
  desc: string;
}

const ITEM_DOCS: ItemDoc[] = [
  {
    kind: Powerup.Fire,
    name: "火力アップ",
    desc: "爆風が1マス長くなる。重ねるほど遠くまで届く。",
  },
  {
    kind: Powerup.Bomb,
    name: "爆弾アップ",
    desc: "同時に置ける爆弾が1個増える。",
  },
  {
    kind: Powerup.Speed,
    name: "スピードアップ",
    desc: "移動速度が上がる。逃げ足が速くなるぶん、止まりにくくもなる。",
  },
  {
    kind: Powerup.Pierce,
    name: "貫通爆弾",
    desc: "爆風がブロックで止まらず、火力のぶんだけ突き抜ける。ただし固い壁は貫通できない。",
  },
  {
    kind: Powerup.Skull,
    name: "ドクロ（罠）",
    desc: `取ると${SKULL_TICKS / TICK_RATE}秒間、火力・爆弾数・速度が最低まで落ちる。見た目で判断して避けよう。`,
  },
];

/** 16x16 のスプライトを指定倍率で拡大した img 要素を作る */
function spriteImg(canvas: HTMLCanvasElement, scale: number): HTMLImageElement {
  const img = document.createElement("img");
  img.src = canvas.toDataURL();
  img.width = 16 * scale;
  img.height = 16 * scale;
  img.style.imageRendering = "pixelated";
  img.style.verticalAlign = "middle";
  return img;
}

export function renderHelp(app: HTMLElement): void {
  app.innerHTML = `
    <h1 style="margin:8px 0">💣 BakudanOtoko — 遊び方</h1>
    <p style="margin:0 0 20px"><a href="./" style="color:#6af">← ロビーへ戻る</a></p>

    <section style="margin-bottom:24px">
      <h2 style="font-size:1.15em;border-bottom:1px solid #444;padding-bottom:4px">ルール</h2>
      <p style="line-height:1.7">
        最大6人で戦う対戦ゲームです。爆弾を置いてブロックを壊し、相手を爆風に巻き込みましょう。
        <strong>最後の1人になれば勝ち</strong>です。3分たっても決着がつかない場合は引き分けになります。
      </p>
      <p style="line-height:1.7;color:#e67e22">
        自分の爆風でも死にます。置いたらすぐ逃げてください。
      </p>
    </section>

    <section style="margin-bottom:24px">
      <h2 style="font-size:1.15em;border-bottom:1px solid #444;padding-bottom:4px">操作</h2>
      <table style="border-collapse:collapse;line-height:1.8">
        <tr>
          <td style="padding-right:24px;color:#aaa">移動</td>
          <td><kbd>↑</kbd> <kbd>↓</kbd> <kbd>←</kbd> <kbd>→</kbd> または <kbd>W</kbd> <kbd>A</kbd> <kbd>S</kbd> <kbd>D</kbd></td>
        </tr>
        <tr>
          <td style="padding-right:24px;color:#aaa">爆弾を置く</td>
          <td><kbd>Space</kbd> または <kbd>Z</kbd></td>
        </tr>
      </table>
      <p style="color:#888;margin-top:12px;line-height:1.7">
        置いた直後の爆弾は、自分が乗っている間だけすり抜けられます。一度離れると通れなくなります。
      </p>
    </section>

    <section style="margin-bottom:24px">
      <h2 style="font-size:1.15em;border-bottom:1px solid #444;padding-bottom:4px">アイテム</h2>
      <p style="color:#888;line-height:1.7">
        ブロックを壊すと出てくることがあります。爆風に当たると消えてしまうので注意。
      </p>
      <div id="itemList" style="margin-top:12px"></div>
    </section>

    <section style="margin-bottom:24px">
      <h2 style="font-size:1.15em;border-bottom:1px solid #444;padding-bottom:4px">フィールド</h2>
      <div id="tileList" style="margin-top:12px"></div>
    </section>

    <section style="margin-bottom:24px">
      <h2 style="font-size:1.15em;border-bottom:1px solid #444;padding-bottom:4px">ゲームの始め方</h2>
      <ol style="line-height:1.9;padding-left:20px">
        <li>ロビーでルームを作るか、一覧から参加します。</li>
        <li>対戦相手が集まるまで待ちます（2人以上で開始できます）。</li>
        <li>全員が <strong>Ready</strong> を押すと、5秒のカウントダウンのあと試合が始まります。</li>
        <li>まだ来ていない人がいるときは、カウントダウン中に <strong>Cancel</strong> を押せば中止できます。</li>
      </ol>
      <p style="color:#888;line-height:1.7">
        カウントダウン中に新しい人が入室した場合は、自動で中止されます。あわてて Ready を押しても、
        あとから来た人を締め出すことはありません。
      </p>
    </section>

    <p style="margin:24px 0"><a href="./" style="color:#6af">← ロビーへ戻る</a></p>
  `;

  const sprites = getSprites();

  // アイテム一覧（実物のスプライトを表示）
  const itemList = document.getElementById("itemList")!;
  for (const doc of ITEM_DOCS) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #2a2a3e";
    const icon = spriteImg(sprites.items[doc.kind]!, 2.5);
    const text = document.createElement("div");
    text.innerHTML =
      `<strong>${doc.name}</strong><br>` +
      `<span style="color:#aaa;font-size:13px;line-height:1.6">${doc.desc}</span>`;
    row.append(icon, text);
    itemList.append(row);
  }

  // フィールドのタイル説明
  const tileList = document.getElementById("tileList")!;
  const tiles: Array<[HTMLCanvasElement, string, string]> = [
    [sprites.hard, "固い壁", "壊せません。爆風もここで止まります。"],
    [sprites.soft, "ブロック", "爆風で壊せます。アイテムが隠れていることがあります。"],
    [sprites.floor, "床", "自由に移動できます。"],
  ];
  for (const [canvas, name, desc] of tiles) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:14px;padding:10px 0;border-bottom:1px solid #2a2a3e";
    const icon = spriteImg(canvas, 2.5);
    const text = document.createElement("div");
    text.innerHTML =
      `<strong>${name}</strong><br>` +
      `<span style="color:#aaa;font-size:13px;line-height:1.6">${desc}</span>`;
    row.append(icon, text);
    tileList.append(row);
  }
}
