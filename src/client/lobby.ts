// ロビー画面: ルーム一覧（ポーリング）・作成・参加

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
  app.innerHTML = `
    <h1 style="margin:8px 0">💣 BakudanOtoko</h1>
    <div style="margin:16px 0">
      <label>プレイヤー名:
        <input id="nameInput" maxlength="12" value="${escapeHtml(savedName)}"
          placeholder="なまえ" style="padding:6px;font-family:inherit;width:10em" />
      </label>
    </div>
    <div style="margin:16px 0;padding:12px;border:1px solid #444;border-radius:8px">
      <label>新しいルーム:
        <input id="roomNameInput" maxlength="20" placeholder="ルーム名"
          style="padding:6px;font-family:inherit;width:14em" />
      </label>
      <button id="createBtn" style="padding:6px 20px;margin-left:8px">作成して参加</button>
    </div>
    <h2 style="font-size:1.1em">ルーム一覧 <span id="pollState" style="color:#666;font-weight:normal"></span></h2>
    <div id="roomList" style="min-height:4em">読み込み中…</div>
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
      roomList.innerHTML = `<p style="color:#888">ルームがありません。作成してください。</p>`;
      return;
    }
    roomList.innerHTML = rooms
      .map((r) => {
        const full = r.players >= MAX_PLAYERS;
        const joinable = r.status === "waiting" && !full;
        const stateLabel =
          r.status === "playing" ? "対戦中" : full ? "満員" : `${r.players}/${MAX_PLAYERS}人`;
        return `
        <div style="display:flex;align-items:center;gap:12px;padding:8px;border-bottom:1px solid #333">
          <span style="flex:1">${escapeHtml(r.name)} <span style="color:#666">(${r.id})</span></span>
          <span style="color:${r.status === "playing" ? "#e67e22" : "#2ecc71"}">${stateLabel}</span>
          <button data-room="${r.id}" ${joinable ? "" : "disabled"}
            style="padding:4px 16px">参加</button>
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
