import type { Env } from "./env";

export interface RoomInfo {
  id: string;
  name: string;
  players: number;
  status: "waiting" | "playing";
  updatedAt: number;
}

const STALE_MS = 5 * 60_000; // 更新が途絶えたルームの掃除
const EMPTY_STALE_MS = 90_000; // 0人のまま放置されたルームの掃除
const ROOM_CODE_CHARS = "abcdefghjkmnpqrstuvwxyz23456789"; // 紛らわしい文字を除外

/**
 * ルーム台帳の Durable Object（シングルトン）。
 * RoomDO からのイベント報告で更新される（ポーリング/タイマーなし = Hibernation 維持）。
 * 掃除は GET リクエスト処理時に遅延実行する。
 */
export class LobbyDO {
  private readonly ctx: DurableObjectState;
  private readonly env: Env;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        players INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'waiting',
        updated_at INTEGER NOT NULL
      )
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // ===== 公開 API（Worker から転送） =====
    if (url.pathname === "/api/rooms" && request.method === "GET") {
      this.cleanup();
      return Response.json({ rooms: this.listRooms() });
    }
    if (url.pathname === "/api/rooms" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { name?: string };
      const name = String(body.name ?? "").slice(0, 20) || "無名のルーム";
      const id = this.generateCode();
      this.ctx.storage.sql.exec(
        "INSERT INTO rooms (id, name, players, status, updated_at) VALUES (?, ?, 0, 'waiting', ?)",
        id,
        name,
        Date.now(),
      );
      return Response.json({ id, name });
    }

    // ===== RoomDO からの内部報告 =====
    if (url.pathname === "/report" && request.method === "POST") {
      const info = (await request.json()) as {
        id: string;
        players: number;
        status: "waiting" | "playing";
      };
      // 存在しない場合は名前=ID で登録（直接URL参加のルーム）
      this.ctx.storage.sql.exec(
        `INSERT INTO rooms (id, name, players, status, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET players = excluded.players, status = excluded.status, updated_at = excluded.updated_at`,
        info.id,
        info.id,
        info.players,
        info.status,
        Date.now(),
      );
      return new Response("ok");
    }
    if (url.pathname === "/remove" && request.method === "POST") {
      const { id } = (await request.json()) as { id: string };
      this.ctx.storage.sql.exec("DELETE FROM rooms WHERE id = ?", id);
      return new Response("ok");
    }

    return new Response("Not found", { status: 404 });
  }

  private listRooms(): RoomInfo[] {
    const rows = this.ctx.storage.sql
      .exec("SELECT id, name, players, status, updated_at FROM rooms ORDER BY updated_at DESC LIMIT 50")
      .toArray();
    return rows.map((r) => ({
      id: String(r.id),
      name: String(r.name),
      players: Number(r.players),
      status: r.status === "playing" ? "playing" : "waiting",
      updatedAt: Number(r.updated_at),
    }));
  }

  private cleanup(): void {
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM rooms WHERE updated_at < ? OR (players = 0 AND updated_at < ?)",
      now - STALE_MS,
      now - EMPTY_STALE_MS,
    );
  }

  private generateCode(): string {
    let code = "";
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    for (const b of bytes) code += ROOM_CODE_CHARS[b % ROOM_CODE_CHARS.length];
    return code;
  }
}
