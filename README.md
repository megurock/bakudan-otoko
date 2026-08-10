# 💣 BakudanOtoko（爆弾男）

Cloudflare Workers + Durable Objects で動くリアルタイム対戦ゲーム。
最大 **6人** 同時対戦・Basic 認証付き・無料枠で運用可能。

> Bomberman® にインスパイアされた非公式のファンメイドクローンです。
> コード・グラフィックはすべてオリジナル。Bomberman は KONAMI の登録商標であり、本プロジェクトとは無関係です。

## 遊び方

アプリ内に遊び方ページがあります（ロビーの「📖 遊び方をみる」/ `?help`）。

- ロビーでプレイヤー名を入れてルームを作成 / 参加（ルーム URL の共有でも参加可能）
- 待機中に**勝敗形式**を選択（1本勝負 / 2・3・5本先取）。全員に共有される
  - 先取を選ぶと決着まで同じメンバーで繰り返し、次戦は 5 秒後に自動開始
  - 先取数に到達した人が 👑 優勝。引き分けは加算されない
- 全員が **Ready** になると 5 秒の開始猶予 → 3 秒カウントダウン後に開始
  - 猶予中は **Cancel** で中止できる。新しい人が入室した場合も自動で中止されるので、
    まだ来ていない相手を締め出さずに済む
- 移動: 矢印キー / WASD ・ 爆弾: Space / Z
- ソフトブロックを壊すとアイテムが出る
  - 🔥 火力アップ / 💣 爆弾アップ / 👟 スピードアップ
  - ➡️ 貫通爆弾（希少）: 爆風がソフトブロックで止まらず火力ぶん突き抜ける
  - 💀 ドクロ（罠・希少）: 10 秒間だけ火力・爆弾数・速度が最低値に落ちる
  - 👻 壁すり抜け（レア）: ブロックの中を通り抜けられる。1 回きりで、抜けきると効力が切れる
- 最後まで生き残ったプレイヤーの勝ち（3分で引き分け）

## アーキテクチャ

```
ブラウザ (Canvas 2D / ドット絵はコード生成)
  │ Basic 認証（全パス + WebSocket アップグレード）
  ▼
Cloudflare Worker (src/server/index.ts)
  ├─ 静的アセット配信 (Vite ビルド, run_worker_first で認証を通す)
  ├─ /api/rooms → LobbyDO (シングルトン, SQLite ルーム台帳)
  └─ /ws/room/:id → RoomDO (1ルーム = 1 DO)
        ├─ WebSocket Hibernation (待機中はコストゼロ)
        ├─ 試合中のみ setTimeout チェーンで 20 tick/s の権威シミュレーション
        └─ alarm は 30 秒ウォッチドッグのみ（リクエスト課金節約）

src/shared/ … サーバー/クライアント共有の決定論ゲームロジック
  （整数固定小数点・乱数はマップ生成時のみ → クライアント側予測と完全一致）
```

- **ネットコード**: 権威サーバー + クライアント側予測（自キャラのみ）+ エンティティ補間（他プレイヤー、100ms 遅延）
- **入力**: キー変化時のみ送信（受信 WS メッセージ 20:1 課金を活かし無料枠内に収まる設計）

## 開発

Node と pnpm のバージョンは `mise.toml` で固定しています。[mise](https://mise.jdx.dev/) を入れていれば
リポジトリに入るだけで揃います（未導入なら Node 24 / pnpm 11 を手動で用意してください）。

```bash
mise install       # mise.toml のとおり Node / pnpm を用意
pnpm install
pnpm dev           # vite build --watch + wrangler dev (http://localhost:8787)
pnpm test          # vitest (shared ロジックの単体テスト)
pnpm typecheck     # server / client 両方の型チェック
```

mise のタスクからも実行できます（`mise run dev` / `mise run check` など）。

ローカルの Basic 認証は `.dev.vars`（`BASIC_USER` / `BASIC_PASS`、デフォルト admin / devpassword）。

## デプロイ (workers.dev)

```bash
pnpm wrangler login             # 初回のみ（ブラウザ OAuth）
pnpm deploy                     # ビルド + デプロイ
pnpm wrangler secret put BASIC_USER   # 認証ユーザー名を設定
pnpm wrangler secret put BASIC_PASS   # 認証パスワードを設定
pnpm wrangler tail               # 本番ログ確認
```

無料枠の注意: Durable Objects はリクエスト 10万/日・duration 13,000 GB-s/日（毎日 00:00 UTC リセット）。
試合中のみ tick が回る設計のため、常時 1〜2 試合程度なら無料枠に収まる想定。

## 技術調査

設計の根拠となった調査レポートは [docs/research-online-bomberman.md](docs/research-online-bomberman.md) を参照。
