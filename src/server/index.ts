import { requireBasicAuth, logoutResponse } from "./auth";
import type { Env } from "./env";

export { RoomDO } from "./room-do";
export { LobbyDO } from "./lobby-do";

const ROOM_ID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/logout") return logoutResponse();

    // 全パス（静的アセット・API・WebSocket アップグレード）に Basic 認証を適用
    const denied = await requireBasicAuth(request, env);
    if (denied) return denied;

    // ロビー API（スプリント4で本実装）
    if (url.pathname === "/api/rooms") {
      const lobby = env.LOBBY_DO.get(env.LOBBY_DO.idFromName("global"));
      return lobby.fetch(request);
    }

    // WebSocket → ルーム DO へ転送
    const wsMatch = url.pathname.match(/^\/ws\/room\/([^/]+)$/);
    if (wsMatch) {
      const roomId = wsMatch[1]!;
      if (!ROOM_ID_RE.test(roomId)) {
        return new Response("Invalid room id", { status: 400 });
      }
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const room = env.ROOM_DO.get(env.ROOM_DO.idFromName(roomId));
      // DO は自身の名前を知れないため、ルーム ID をヘッダーで伝える
      const forwarded = new Request(request);
      forwarded.headers.set("x-room-id", roomId);
      return room.fetch(forwarded);
    }

    // それ以外は静的アセット
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
