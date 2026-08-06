# 💣 Bomberman Online

Cloudflare Workers + Durable Objects で動くリアルタイム対戦ボンバーマン。
最大 **6人** 同時対戦・Basic 認証付き・無料枠で運用可能。

## 遊び方

- ロビーでプレイヤー名を入れてルームを作成 / 参加（ルーム URL の共有でも参加可能）
- 全員が **Ready** になると 3 秒カウントダウン後に開始
- 移動: 矢印キー / WASD ・ 爆弾: Space / Z
- ソフトブロックを壊すとパワーアップ（🔥爆風範囲 / 💣同時設置数 / 👟移動速度）
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

```bash
npm install
npm run dev        # vite build --watch + wrangler dev (http://localhost:8787)
npm test           # vitest (shared ロジックの単体テスト 25件)
npm run typecheck  # server / client 両方の型チェック
```

ローカルの Basic 認証は `.dev.vars`（`BASIC_USER` / `BASIC_PASS`、デフォルト admin / devpassword）。

## デプロイ (workers.dev)

```bash
npx wrangler login              # 初回のみ（ブラウザ OAuth）
npm run deploy                  # ビルド + デプロイ
npx wrangler secret put BASIC_USER   # 認証ユーザー名を設定
npx wrangler secret put BASIC_PASS   # 認証パスワードを設定
npx wrangler tail               # 本番ログ確認
```

無料枠の注意: Durable Objects はリクエスト 10万/日・duration 13,000 GB-s/日（毎日 00:00 UTC リセット）。
試合中のみ tick が回る設計のため、常時 1〜2 試合程度なら無料枠に収まる想定。

## 技術調査

設計の根拠となった調査レポートは [docs/research-online-bomberman.md](docs/research-online-bomberman.md) を参照。
