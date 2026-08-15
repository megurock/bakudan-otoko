// ロビー画面: ルーム一覧（ポーリング）・作成・参加

import { SLOT_THEMES } from "./game/sprites";
import { logoHtml } from "./logo";

interface RoomInfo {
  id: string;
  name: string;
  players: number;
  status: "waiting" | "playing";
}

const POLL_MS = 3000;
const MAX_PLAYERS = 6;

// ページ URL に Basic 認証の資格情報が埋め込まれていると相対パスの fetch が
// 失敗するため、credentials を含まない location.origin から絶対 URL を組み立てる
const API_ROOMS = `${location.origin}/api/rooms`;

export function renderLobby(app: HTMLElement): void {
  const savedName = localStorage.getItem("bm-name") ?? "";
  const slotChips = SLOT_THEMES.map(
    (t) => `<span class="slot-chip" style="background:${t.primary}"></span>`,
  ).join("");
  app.innerHTML = `
    <div class="lobby">
      <header class="lobby-hero">
        ${logoHtml("ONLINE BOMB BATTLE")}
        <p class="lobby-tag">最大6人でリアルタイム対戦。ルームを作って友だちを呼ぼう。
          <a href="?help">あそびかたを見る</a></p>
        <div class="lobby-slots" title="最大6人">${slotChips}</div>
      </header>

      <section class="lobby-panel">
        <p class="lobby-panel-label">▶ エントリー</p>
        <div class="lobby-row">
          <label for="nameInput">プレイヤー名:</label>
          <input id="nameInput" maxlength="12" value="${escapeHtml(savedName)}"
            placeholder="なまえ" style="width:10em" />
        </div>
      </section>

      <section class="lobby-panel">
        <p class="lobby-panel-label">▶ ルームを作る</p>
        <div class="lobby-row">
          <input id="roomNameInput" maxlength="20" placeholder="ルーム名" style="flex:1;min-width:10em" />
          <button id="createBtn" class="btn">作成して参加</button>
        </div>
      </section>

      <h2>▶ ルーム一覧 <span id="pollState" style="color:#666;letter-spacing:normal"></span></h2>
      <div id="roomList" style="min-height:4em">読み込み中…</div>

      <p class="lobby-foot">PUSH CREATE TO START</p>
    </div>
  `;

  const nameInput = document.getElementById("nameInput") as HTMLInputElement;
  const roomNameInput = document.getElementById("roomNameInput") as HTMLInputElement;
  const createBtn = document.getElementById("createBtn") as HTMLButtonElement;
  const roomList = document.getElementById("roomList")!;
  const pollState = document.getElementById("pollState")!;

  function playerName(): string {
    const name = nameInput.value.trim().slice(0, 12);
    if (name) localStorage.setItem("bm-name", name);
    return name || `P${Math.floor(Math.random() * 1000)}`;
  }

  function joinRoom(id: string): void {
    location.href = `?room=${encodeURIComponent(id)}&name=${encodeURIComponent(playerName())}`;
  }

  createBtn.addEventListener("click", async () => {
    createBtn.disabled = true;
    try {
      const res = await fetch(API_ROOMS, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: roomNameInput.value.trim() }),
      });
      const data = (await res.json()) as { id: string };
      joinRoom(data.id);
    } catch {
      createBtn.disabled = false;
      pollState.textContent = "(ルーム作成に失敗しました)";
    }
  });

  async function refresh(): Promise<void> {
    try {
      const res = await fetch(API_ROOMS);
      const data = (await res.json()) as { rooms: RoomInfo[] };
      renderRooms(data.rooms);
      pollState.textContent = "";
    } catch {
      pollState.textContent = "(取得失敗、再試行中…)";
    }
  }

  function renderRooms(rooms: RoomInfo[]): void {
    if (rooms.length === 0) {
      roomList.innerHTML = `<p class="room-empty">ルームはまだありません。最初のルームを作ってください。</p>`;
      return;
    }
    roomList.innerHTML = rooms
      .map((r) => {
        const full = r.players >= MAX_PLAYERS;
        const joinable = r.status === "waiting" && !full;
        const badge =
          r.status === "playing"
            ? `<span class="room-badge playing">対戦中</span>`
            : full
              ? `<span class="room-badge full">満員</span>`
              : `<span class="room-badge waiting">${r.players}/${MAX_PLAYERS}人</span>`;
        return `
        <div class="room-card">
          <span class="room-name">${escapeHtml(r.name)} <span class="room-id">(${r.id})</span></span>
          ${badge}
          <button data-room="${r.id}" class="btn btn-sm" ${joinable ? "" : "disabled"}>参加</button>
        </div>`;
      })
      .join("");
    for (const btn of roomList.querySelectorAll<HTMLButtonElement>("button[data-room]")) {
      btn.addEventListener("click", () => joinRoom(btn.dataset.room!));
    }
  }

  void refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  window.addEventListener("pagehide", () => clearInterval(timer));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
