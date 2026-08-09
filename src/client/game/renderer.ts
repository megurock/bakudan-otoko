import { BLAST_TICKS, MAP_H, MAP_W, SUB, TICK_MS } from "../../shared/constants";
import type { RosterEntry, Snap } from "../../shared/protocol";
import { Tile } from "../../shared/types";
import type { InterpPlayer } from "./interpolation";
import { getSprites, SLOT_THEMES, SPRITE_PX } from "./sprites";

export const TILE_PX = 48;
const PX_SCALE = TILE_PX / SPRITE_PX; // 16px アート → 3倍
export const WORLD_SCALE = TILE_PX / SUB;

const BLAST_MS = BLAST_TICKS * TICK_MS;

interface DieEffect {
  type: "die";
  slot: number;
  x: number;
  y: number;
  start: number;
}
interface CrumbleEffect {
  type: "crumble";
  cx: number;
  cy: number;
  start: number;
}
type Effect = DieEffect | CrumbleEffect;

export interface DrawView {
  grid: Uint8Array | null;
  snap: Snap | null;
  players: InterpPlayer[];
  roster: RosterEntry[];
  mySlot: number;
  winnerSlot: number | null;
  championSlot: number | null;
  winTarget: number;
  wins: number[];
  countdownEndTick: number;
}

export class Renderer {
  private readonly canvas: HTMLCanvasElement;
  private readonly g: CanvasRenderingContext2D;
  private readonly bg: HTMLCanvasElement;
  private effects: Effect[] = [];
  private blastSeen = new Map<string, number>(); // "cx,cy" → 初見時刻
  private deadSeen = new Set<number>();

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    canvas.width = MAP_W * TILE_PX;
    canvas.height = MAP_H * TILE_PX;
    this.g = canvas.getContext("2d")!;
    this.g.imageSmoothingEnabled = false;
    this.bg = document.createElement("canvas");
    this.bg.width = canvas.width;
    this.bg.height = canvas.height;
  }

  /** グリッド確定時に静的背景（床 + ハードブロック）を焼き込む */
  rebuildBackground(grid: Uint8Array): void {
    const sprites = getSprites();
    const g = this.bg.getContext("2d")!;
    g.imageSmoothingEnabled = false;
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        const t = grid[cy * MAP_W + cx];
        g.drawImage(
          t === Tile.Hard ? sprites.hard : sprites.floor,
          cx * TILE_PX,
          cy * TILE_PX,
          TILE_PX,
          TILE_PX,
        );
      }
    }
  }

  resetMatchState(): void {
    this.effects = [];
    this.blastSeen.clear();
    this.deadSeen.clear();
  }

  /** スナップショート受信時に演出イベントを取り込む */
  ingest(snap: Snap): void {
    const now = performance.now();
    if (snap.g) {
      for (const [cx, cy, tile] of snap.g) {
        if (tile === Tile.Floor) this.effects.push({ type: "crumble", cx, cy, start: now });
      }
    }
    if (snap.e) {
      for (const ev of snap.e) {
        if (ev[0] === "die") {
          const slot = ev[1];
          if (this.deadSeen.has(slot)) continue;
          this.deadSeen.add(slot);
          const p = snap.p.find((q) => q[0] === slot);
          if (p) this.effects.push({ type: "die", slot, x: p[1], y: p[2], start: now });
        }
      }
    }
  }

  draw(view: DrawView): void {
    const { g } = this;
    const now = performance.now();

    // 背景
    if (view.grid) {
      g.drawImage(this.bg, 0, 0);
    } else {
      g.fillStyle = "#1f1f2e";
      g.fillRect(0, 0, this.canvas.width, this.canvas.height);
      this.drawTitle();
      return;
    }

    const sprites = getSprites();
    const grid = view.grid;
    const snap = view.snap;

    // ソフトブロック
    for (let cy = 0; cy < MAP_H; cy++) {
      for (let cx = 0; cx < MAP_W; cx++) {
        if (grid[cy * MAP_W + cx] === Tile.Soft) {
          g.drawImage(sprites.soft, cx * TILE_PX, cy * TILE_PX, TILE_PX, TILE_PX);
        }
      }
    }

    if (snap) {
      this.drawItems(snap, now);
      this.drawBombs(snap, now);
      this.drawBlasts(snap, now);
    }
    this.drawEffects(now);
    this.drawPlayers(view, now);
    this.drawOverlays(view);
  }

  private drawItems(snap: Snap, now: number): void {
    const sprites = getSprites();
    const bob = Math.sin(now / 200) * 3;
    for (const [cx, cy, kind] of snap.u) {
      const sprite = sprites.items[kind];
      if (!sprite) continue;
      this.g.drawImage(
        sprite,
        cx * TILE_PX + (TILE_PX - SPRITE_PX * PX_SCALE) / 2,
        cy * TILE_PX + bob,
        SPRITE_PX * PX_SCALE,
        SPRITE_PX * PX_SCALE,
      );
    }
  }

  private drawBombs(snap: Snap, now: number): void {
    const sprites = getSprites();
    for (const [, cx, cy, fuse] of snap.b) {
      // 脈動: 残り時間が短いほど速く
      const rate = fuse < 20 ? 90 : 180;
      const frame = Math.floor(now / rate) % 2;
      const sprite = sprites.bomb[frame]!;
      this.g.drawImage(sprite, cx * TILE_PX, cy * TILE_PX, TILE_PX, TILE_PX);
    }
  }

  private drawBlasts(snap: Snap, now: number): void {
    const { g } = this;
    const liveKeys = new Set<string>();
    for (const [cx, cy] of snap.f) liveKeys.add(`${cx},${cy}`);
    // 消えた爆風の初見記録を掃除
    for (const key of [...this.blastSeen.keys()]) {
      if (!liveKeys.has(key)) this.blastSeen.delete(key);
    }

    for (const [cx, cy, dir, shape] of snap.f) {
      const key = `${cx},${cy}`;
      let seen = this.blastSeen.get(key);
      if (seen === undefined) {
        seen = now;
        this.blastSeen.set(key, now);
      }
      const age = Math.min(1, (now - seen) / BLAST_MS);
      // 成長 → 全開 → 減衰
      const size = age < 0.15 ? age / 0.15 : age > 0.75 ? 1 - ((age - 0.75) / 0.25) * 0.5 : 1;
      const x = cx * TILE_PX + TILE_PX / 2;
      const y = cy * TILE_PX + TILE_PX / 2;
      const horizontal = dir === 2 || dir === 3;

      const layer = (color: string, scale: number): void => {
        g.fillStyle = color;
        const w =
          shape === 0
            ? TILE_PX * scale
            : horizontal
              ? TILE_PX
              : TILE_PX * scale * 0.8;
        const h =
          shape === 0
            ? TILE_PX * scale
            : horizontal
              ? TILE_PX * scale * 0.8
              : TILE_PX;
        g.fillRect(x - (w / 2) * size, y - (h / 2) * size, w * size, h * size);
      };
      layer("#ff5f1a", 1.0);
      layer("#ffc72e", 0.7);
      layer("#fff8d0", 0.38);
    }
  }

  private drawEffects(now: number): void {
    const { g } = this;
    this.effects = this.effects.filter((fx) => {
      const age = now - fx.start;
      if (fx.type === "crumble") {
        if (age > 400) return false;
        const t = age / 400;
        // ソフトブロックの破片が四方へ散る
        g.fillStyle = `rgba(181, 101, 29, ${1 - t})`;
        const cx = fx.cx * TILE_PX + TILE_PX / 2;
        const cy = fx.cy * TILE_PX + TILE_PX / 2;
        const d = t * TILE_PX * 0.6;
        const s = 8 * (1 - t) + 2;
        const corners: ReadonlyArray<readonly [number, number]> = [
          [-1, -1],
          [1, -1],
          [-1, 1],
          [1, 1],
        ];
        for (const [ox, oy] of corners) {
          g.fillRect(cx + ox * d - s / 2, cy + oy * d - t * TILE_PX * 0.3 - s / 2, s, s);
        }
        return true;
      }
      // die: 白フラッシュ + 回転縮小
      if (age > 800) return false;
      const t = age / 800;
      const px = fx.x * WORLD_SCALE;
      const py = fx.y * WORLD_SCALE;
      const sprites = getSprites();
      const sprite = sprites.players[fx.slot]?.[1]?.[0];
      if (sprite) {
        g.save();
        g.translate(px, py);
        g.rotate(t * Math.PI * 4);
        g.globalAlpha = 1 - t;
        const size = SPRITE_PX * PX_SCALE * (1 - t * 0.6);
        g.drawImage(sprite, -size / 2, -size / 2, size, size);
        g.restore();
        g.globalAlpha = 1;
      }
      if (t < 0.3) {
        g.fillStyle = `rgba(255,255,255,${(0.3 - t) * 2})`;
        g.beginPath();
        g.arc(px, py, TILE_PX * (0.5 + t * 2), 0, Math.PI * 2);
        g.fill();
      }
      return true;
    });
  }

  private drawPlayers(view: DrawView, now: number): void {
    const { g } = this;
    const sprites = getSprites();
    const sorted = [...view.players].sort((a, b) => a.y - b.y);
    for (const p of sorted) {
      if (!p.alive) continue;
      const px = p.x * WORLD_SCALE;
      const py = p.y * WORLD_SCALE;
      // 歩行フレームは移動距離ベース（歩幅と同期）
      const frame = ((p.x + p.y) >> 6) & 1;
      const sprite = sprites.players[p.slot]?.[p.dir]?.[frame];
      if (!sprite) continue;

      // 影
      g.fillStyle = "rgba(0,0,0,0.3)";
      g.beginPath();
      g.ellipse(px, py + 18, 14, 5, 0, 0, Math.PI * 2);
      g.fill();

      const size = SPRITE_PX * PX_SCALE;
      // 切断中は半透明
      if (!p.connected) g.globalAlpha = 0.4;
      g.drawImage(sprite, px - size / 2, py - size / 2 - 6, size, size);
      g.globalAlpha = 1;

      // 名前
      const entry = view.roster.find((r) => r.slot === p.slot);
      if (entry) {
        g.font = "bold 11px monospace";
        g.textAlign = "center";
        g.fillStyle = "rgba(0,0,0,0.5)";
        g.fillText(entry.name, px + 1, py - 29);
        g.fillStyle = SLOT_THEMES[p.slot]?.label ?? "#fff";
        g.fillText(entry.name, px, py - 30);
      }
    }
  }

  private drawOverlays(view: DrawView): void {
    const { g, canvas } = this;
    const snap = view.snap;
    g.textAlign = "center";

    // 死亡後の観戦表示
    if (snap && snap.ph === "playing" && view.winnerSlot === null) {
      const mine = snap.p.find((p) => p[0] === view.mySlot);
      if (mine && (mine[4] & 1) === 0) {
        g.fillStyle = "rgba(0,0,0,0.55)";
        g.fillRect(0, 8, canvas.width, 36);
        g.fillStyle = "#ffb0b0";
        g.font = "bold 18px monospace";
        g.fillText("💀 倒れました…観戦中", canvas.width / 2, 33);
      }
    }

    if (snap && snap.ph === "countdown") {
      const remain = Math.ceil((view.countdownEndTick - snap.k) * TICK_MS / 1000);
      g.fillStyle = "rgba(0,0,0,0.45)";
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.fillStyle = "#fff";
      g.font = "bold 96px monospace";
      g.fillText(remain > 0 ? String(remain) : "GO!", canvas.width / 2, canvas.height / 2 + 32);
    }

    if (view.winnerSlot !== null) {
      const champion = view.championSlot ?? null;
      g.fillStyle = "rgba(0,0,0,0.65)";
      g.fillRect(0, canvas.height / 2 - 70, canvas.width, 140);
      g.font = "bold 44px monospace";

      if (view.winnerSlot === -1) {
        g.fillStyle = "#fff";
        g.fillText("引き分け", canvas.width / 2, canvas.height / 2 + 14);
      } else {
        const name =
          view.roster.find((r) => r.slot === view.winnerSlot)?.name ?? `P${view.winnerSlot}`;
        g.fillStyle = SLOT_THEMES[view.winnerSlot]?.primary ?? "#fff";
        // シリーズ優勝ならその旨を大きく出す
        const label = champion === view.winnerSlot ? `${name} 優勝! 👑` : `${name} の勝ち!`;
        g.fillText(label, canvas.width / 2, canvas.height / 2 + 14);
      }

      // シリーズ続行中はスコアと次戦予告を添える
      if (champion === null && view.winTarget > 1) {
        g.font = "18px monospace";
        g.fillStyle = "#ddd";
        const score = view.roster
          .map((r) => `${r.name} ${view.wins[r.slot] ?? 0}`)
          .join("  ");
        g.fillText(`${score}  （${view.winTarget}本先取）`, canvas.width / 2, canvas.height / 2 + 50);
      }
    }
  }

  private drawTitle(): void {
    const { g, canvas } = this;
    g.fillStyle = "#888";
    g.font = "20px monospace";
    g.textAlign = "center";
    g.fillText("待機中…", canvas.width / 2, canvas.height / 2);
  }
}
