# オンライン・ボンバーマン クローン開発 技術調査レポート

調査日: 2026-08-06
調査方法: ディープリサーチ・ワークフロー（5角度の並列Web検索 → 21ソース取得 → 104クレーム抽出 → 上位25クレームを3票の敵対的検証にかけ全件確認済み）

## 要件（前提）

- CPU モードは不要。人間同士のリアルタイム同時対戦
- 同時最大接続数はできれば 6 人、無理なら 4 人でも可
- 無料で使えるインフラ（Cloudflare が候補）
- 基本認証（Basic 認証）をつける

## 結論（要旨）

- **ネットワーク設計**: 「権威サーバー + クライアント側予測 + エンティティ補間 + （必要なら）ラグ補償」というクライアント・サーバー方式が実績ある構成であり、4〜6人のグリッドベース対戦に十分適用できる。ロックステップは1人の高遅延プレイヤーが全員を遅くするため不向き。
- **インフラ**: Cloudflare Durable Objects は 2025年4月以降 Workers 無料プランで利用可能。WebSocket Hibernation により待機中コストがゼロになり、受信 WebSocket メッセージは 20:1 でリクエスト換算されるため、小規模リアルタイムゲームの無料運用に適合する。Cloudflare 自身がマルチプレイヤーゲームを公式ユースケースとして挙げている。**「1ルーム = 1 Durable Object」構成が本件に最適**。
- **Basic 認証**: Cloudflare Workers の公式サンプル実装がそのまま使える。
- **参考OSS**: Bomberland（TypeScript / MIT、ゲームエンジンのソース込み）が検証済みの最有力。ほかに BombRMan（C# / 権威サーバー / 4人対戦）、DmytroVasin/bomber（Phaser + Socket.io / 3人対戦）が構造の参考になる。

---

## 1. ボンバーマンのゲームメカニクスと実装の仕組み

> このセクションの出典はチュートリアル・OSSリポジトリ・実装事例記事（一次資料に準ずるがコミュニティ由来）。数値はあくまで各実装の例。

### 1.1 マップ表現（グリッド）

- マップは 1×1 のタイルグリッドで表現するのが定石。BombRMan の例では **15×13 グリッド**をタイル種別の数字文字列（2=壁、0=床）で表現し、タイルサイズ 32px で読み込む。
- ブロックは3種類の挙動で整理できる:
  - **ハードブロック（破壊不可）**: 爆風を遮断する
  - **ソフトブロック（破壊可能）**: 爆風を遮断した上で破壊され、ランダムにパワーアップを出現させる
  - **床**: 爆風が通過する
- プレイヤー座標はタイル座標に加えて固定小数点座標（BombRMan では 100倍精度の ExactX/ExactY）を併用し、タイル間の滑らかな移動を実現する。
- 初期配置はマップの4隅（BombRMan: (1,1) / (13,1) / (1,11) / (13,11)）。6人対戦にする場合は辺の中央などスポーン地点の追加設計が必要。

### 1.2 爆弾・爆風・連鎖爆発

- 爆弾は設置時にプレイヤー座標をタイル位置にスナップさせて置く（座標の整数丸め）。
- 爆風は爆弾中心から**上下左右4方向へ直線的にタイル単位で伝播**し、range パラメータ分進む。空きタイルなら爆風を生成し、ブロックに当たった時点でその方向の伝播を打ち切る（壁越え防止）。
- **連鎖爆発（誘爆）**: 爆風が未起爆の爆弾に触れたら、その爆弾を即座に起爆する。ECS 実装の事例では「爆発マスの下にあるエンティティへメッセージを送り、BombSystem がそれを受けて起爆する」メッセージ駆動で実装。
- 爆発は「単一エンティティ」ではなく「**グリッド1マスにつき1爆発エンティティ**」としてモデル化すると、伝播・遮蔽・持続時間の管理が単純になる（各爆発が Range・伝播方向・残存時間を持ち、伝播先の子爆発は Range が1減る）。
- 導火線はカウントダウン方式（例: 設置から3秒後に起爆、毎フレーム FuseCountdown を減算し 0 で爆発エンティティに置換）。
- 歴史的な設計として、オリジナルの8/16bit版は爆弾・爆風・パワーアップを**すべてタイルとして表現**し、爆風は伝播アニメーションなしに定義サイズで瞬時に発生していた（gamedev.net 記事コメント欄の指摘）。グリッド完結の設計はサーバー側シミュレーションを軽くできるため、本件のようにサーバー計算資源が限られる場合は特に有効。

### 1.3 パワーアップ

- 典型的な系統: 爆風範囲アップ（Fire）、同時設置可能爆弾数アップ（Bomb）、移動速度アップ（Speed）。
- 実装はプレイヤーの属性セット（MaxSpeed / PermittedSimultaneousBombs / BombRange 等）を書き換える方式。効果は排他的でなく合成される。
- ドロップはソフトブロック破壊時に確率で出現（DmytroVasin/bomber は 50% 固定）。
- 爆弾は**設置時点のプレイヤー能力をコピーして保持**する（設置後にパワーアップを取っても既設爆弾には影響しない）実装例がある。本家の挙動と同一かは未確認。

### 1.4 当たり判定

- ハイブリッド構成が一般的: プレイヤー移動はグリッドより細かい粒度なので連続座標での衝突判定、爆弾設置などグリッド依存ロジックは「このマスに何があるか」の単純なグリッド問い合わせ。
- オリジナル版のようにプレイヤーが常に最大2タイルをまたぐ前提なら、その2タイルだけ調べれば衝突判定が済む。
- 爆風のプレイヤー当たり判定はタイル単位（プレイヤーのいるマスが爆風マスかどうか）で成立する。

### 1.5 ゲームループ

- サーバー側は固定 tick のループ（BombRMan は 60 FPS 固定の専用スレッド）。ただし後述の通り、ボンバーマン級では 20〜30 tick/s でも成立する見込みで、無料枠の duration 予算節約に直結する。
- クライアント駆動ループ（requestAnimationFrame 依存）はバックグラウンドタブで停止する問題があるため、**進行の権威はサーバー tick に置く**べき（DmytroVasin/bomber はタブ切替でゲームが止まる）。

---

## 2. リアルタイム対戦のネットワークアーキテクチャ

> 主要出典: Valve「Source Multiplayer Networking」(一次資料、全クレーム3-0で検証済み)、Gabriel Gambetta「Fast-Paced Multiplayer」、SnapNet のネットコード解説。

### 2.1 権威サーバー方式を採用すべき（ロックステップとの比較）

- **権威サーバー方式**: サーバーがワールドシミュレーション・ゲームルール・入力処理の権威を持ち、クライアント同士は直接通信しない。クライアントは入力のみを送り、サーバーが状態を計算して配信する。チート耐性と状態一貫性の面で標準的な選択。
- **ロックステップ方式**: 入力のみを全員に送り、全員の入力が揃ってからシミュレーションを進める。帯域は少ないが、
  - 入力遅延がレイテンシに正比例して構造的に発生し、**最も遅いプレイヤーが全員の遅延を決める**
  - 完全な決定論が必要（浮動小数点差・乱数でデシンクする）
  - 人数が増えるとスケールしない（8人マッチでは約57%のプレイヤーが1人の高遅延者による顕著な入力遅延を経験するという試算あり）
- → **最大6人・ブラウザ・チート耐性を考えると権威サーバー一択**。クライアント権威（BomberJS のような位置をそのまま中継する方式）はチート・不整合に無防備なので避ける。

### 2.2 tick rate 設計

- サーバーは「tick」と呼ばれる離散時間ステップでゲームを進行する。Source エンジンのデフォルトは 15ms（約66.67 tick/s）で、tick を上げると精度が向上する代わりに CPU・帯域コストが増える（tickrate 100 は 66 の約1.5倍の CPU 負荷）。
- ボンバーマンはグリッドベースで FPS ほどの精度が不要なため、**20〜30 tick/s** で成立する見込み（※これは本調査の推論であり実測裏付けはない。プロトタイプで確認すべき）。低 tick 化は Durable Objects の duration 消費節約にも直結する。

### 2.3 エンティティ補間（他プレイヤーの滑らかな描画）

- クライアントは描画時刻を意図的に過去へずらし（Source のデフォルトは 100ms、スナップショット受信約20回/秒）、直近2つのスナップショット間を補間して描画する。1パケット欠落しても2つの有効なスナップショットが常にあるため滑らかさを維持できる。
- 補間期間は `max(cl_interp, cl_interp_ratio / cl_updaterate)` で決まる（Source の式）。低 tick サーバーでも他プレイヤーの移動を滑らかに見せる基本手法として、そのまま応用できる。

### 2.4 クライアント側予測（自キャラのゼロ遅延化）

- クライアントは**サーバーと全く同じコード・ルール**で自分の入力結果を先行計算し、自キャラを即座に動かす。後でサーバーのスナップショットと照合し、差異があればサーバーを最終権威として位置を補正する（補正は滑らかに適用）。
- 予測できるのはローカルプレイヤー自身のみ。他プレイヤーの入力は予測不可能。
- この手法は「**移動・当たり判定ロジックをサーバー/クライアントで共有コード化する**」設計動機になる。TypeScript でロジックを共有パッケージにするのが自然（BomberJS も common/bomber.js を両側で共有するアイソモーフィック設計）。

### 2.5 ラグ補償（サーバー側ヒット判定）

- サーバーが全プレイヤーの位置履歴を1秒間保持し、コマンド実行時刻を「現在のサーバー時刻 − パケット遅延 − クライアント補間遅延」で推定して、他プレイヤーをその時点の位置に巻き戻して当たり判定を行う。
- ヒット判定をクライアントに任せないのは、中間者攻撃で「hit」メッセージを注入するチートプロキシを防げないため。**爆風の当たり判定は必ずサーバー側で行う**。
- なお爆風はタイル単位・爆発は瞬間イベントなので、FPS のような精密なラグ補償は必須ではない可能性が高い。まずは「サーバー tick 時点のタイル占有で判定」から始めるのが現実的。

---

## 3. インフラ: Cloudflare Workers + Durable Objects（推奨）

> 出典はすべて Cloudflare 公式ドキュメント（2026-08-06 時点のライブページで逐語検証済み）。料金・無料枠は変わりやすいため実装着手時に再確認のこと。

### 3.1 無料枠の内容

| 項目 | 無料プランの条件 |
|---|---|
| 利用可否 | 2025年4月7日以降、Workers 無料プランで利用可能 |
| ストレージバックエンド | **SQLite バックエンドの DO のみ**（KV バックエンドは有料限定、2026年7月以降新規作成不可） |
| リクエスト | **100,000 件/日**（毎日 00:00 UTC リセット、超過はエラーで失敗） |
| 実行時間（duration） | **13,000 GB-秒/日** |
| ストレージ | アカウントあたり 5GB |
| DO クラス数 | 最大 100 |

- 上限超過時はその日のうち新規操作がエラーになる点に注意（ゲームが突然落ちる形になる）。

### 3.2 WebSocket まわりの課金と Hibernation

- **受信 WebSocket メッセージは 20:1 でリクエスト換算**（受信100メッセージ = 5リクエスト。送信とプロトコル ping は無課金）。試算: 6人が毎秒10メッセージ送り続けても実効3リクエスト/秒 ≒ 約13,000リクエスト/日相当で、10万/日の枠に余裕で収まる。新規 WebSocket 接続自体は1リクエスト。
- **WebSocket Hibernation**: アイドルでハイバネーション可能な DO には duration 課金が一切発生しない。ただし **alarm や setInterval（tick ループ）が動いている間はハイバネートしない**ため、節約が効くのは「試合中」ではなく「待機中のロビー / 空きルーム」。
  - → 設計指針: **試合中だけ tick ループ（alarm）を回し、待機中は完全にイベント駆動にする**。
- 無料枠が試合時間に対して足りるかは同時試合数に依存する（未実測）。目安として、128MB の DO が1日中アクティブでも 0.125GB × 86,400s = 10,800 GB-s で 13,000 GB-s/日に収まるため、**常時1〜2試合程度なら理論上無料枠内**。

### 3.3 容量・制限の適合性

- 1つの DO インスタンスは WebSocket サーバーとして**数千クライアント**を接続でき、`this.ctx.getWebSockets()` で全接続を取得できる。
- 1インスタンスのソフトリミットは毎秒1,000リクエスト。6人ルームのトラフィック（高く見積もって数百メッセージ/秒）は余裕で収まる。
- CPU 時間はデフォルト30秒だが、HTTP リクエストや WebSocket メッセージ受信ごとにリセットされるため、メッセージ駆動サーバーとして継続稼働できる。
- Cloudflare 自身が「チャットルームやマルチプレイヤーゲームの参加者間の調整点」を DO の公式ユースケースとして明示している。

### 3.4 実装上の注意（Hibernation API）

Web 標準 API とは異なる専用メソッドを使う必要がある:

- 接続受け入れ: `server.accept()` ではなく **`this.ctx.acceptWebSocket(server)`**
- メッセージ処理: `addEventListener` ではなく DO クラスの **`webSocketMessage()` / `webSocketClose()`** ハンドラーメソッド
- 標準の addEventListener 方式では hibernation は機能しない

### 3.5 代替インフラとの比較（参考・一部未検証）

| サービス | 無料運用の可否 | 備考 |
|---|---|---|
| **Cloudflare Workers + DO** | ◎ 検証済みで適合 | 本命 |
| Fly.io | △ | $5未満の請求は免除されることが多く小規模VMは実質無料になるが、新規ユーザーの正式な無料枠は廃止・クレカ必須。マシンが非アクティブ時に停止しコールドスタートあり（※二次情報、未検証） |
| Railway | ✕ | 恒久無料枠なし。一度きりの$5トライアルのみで、枯渇するとアプリ停止（※二次情報、未検証） |
| Deno Deploy | ? | 公式ドキュメントに無料枠の具体数値（リクエスト/CPU/WebSocket制限）の記載がなく、判断材料不足（検証済み） |

→ **要件「無料」を満たす検証済みの選択肢は Cloudflare のみ**。代替は追加調査が必要。

---

## 4. Basic 認証の実装（Cloudflare Workers）

公式サンプル（https://developers.cloudflare.com/workers/examples/basic-auth/ 、検証済み）のパターンがそのまま使える:

1. `Authorization` ヘッダーを split し、`Buffer.from(encoded, "base64").toString()` でデコード、最初のコロンで `username:password` に分解
2. パスワード比較は `TextEncoder` でバイト列化した上で **`crypto.subtle.timingSafeEqual()`**（Workers 固有の非標準 API）を使い、タイミング攻撃を防ぐ
3. 未認証には `401` + `WWW-Authenticate: Basic realm="...", charset="UTF-8"` を返してブラウザの資格情報ダイアログを出す。`/logout` ルートではこのヘッダーなしの 401 を返すと即時再プロンプトを回避できる

注意点:
- `timingSafeEqual` は Workers 固有 API のため、他ランタイムに移植する場合は代替実装が必要
- WebSocket のアップグレードリクエストにも同じ認証チェックを通すこと（Worker のフロントで一括して弾いてから DO へ転送する構成が素直）
- 資格情報は Wrangler の secret（`wrangler secret put`）で管理する

---

## 5. 参考にできるオープンソース実装

| リポジトリ | スタック | 人数 | 特徴 | 検証状態 |
|---|---|---|---|---|
| [CoderOneHQ/bomberland](https://github.com/CoderOneHQ/bomberland) | TypeScript | — | **ゲームエンジンのソース込み・MIT**。BombEntity / BlastEntity（爆風）/ BlastPowerupEntity / WoodBlockEntity / World / createWorldFromSeed（マップ生成）＋ユニットテストあり。ただしルールは改変版（2エージェント×3ユニット等）なので「忠実なクローン」ではなく参考実装 | ✅ 検証済み（3-0） |
| [davidfowl/BombRMan](https://github.com/davidfowl/BombRMan) | C# + JS (SignalR) | 4人 | **権威サーバー型の好例**。クライアントはキー入力のみ送信、サーバーが60FPS固定ループで状態計算・配信。15×13グリッド、固定小数点座標 | 抽出のみ（未検証） |
| [DmytroVasin/bomber](https://github.com/DmytroVasin/bomber) | Phaser + Node.js + Socket.io | 3人 | MIT。パワーアップ3系統・50%ドロップの実装例。タブ切替でゲーム停止する（クライアント駆動ループの反面教師） | 抽出のみ（未検証） |
| [dylanbeattie/BomberJS](https://github.com/dylanbeattie/BomberJS) | Node.js + WebSocket | 4人 | 2011年の未完成プロトタイプ。ロジック共有（アイソモーフィック）の構成例だが、爆弾・爆風ロジックが未実装でクライアント権威。実用性低 | 抽出のみ（未検証） |

チュートリアル系:
- [Kodeco: How To Make A Game Like Bomberman (Unity)](https://www.kodeco.com/244-how-to-make-a-game-like-bomberman-with-unity) — 爆風伝播・誘爆・当たり判定のコード付き解説
- [gamedev.net: Bomberman Mechanics in an ECS](https://www.gamedev.net/articles/programming/general-and-gameplay-programming/case-study-bomberman-mechanics-in-an-entity-component-system-r3159/) — ECS でのメカニクス整理（1マス1爆発エンティティ、メッセージ駆動誘爆）
- [Gabriel Gambetta: Fast-Paced Multiplayer](https://www.gabrielgambetta.com/client-server-game-architecture.html) — 予測・補間・照合のライブデモ付き定番シリーズ

---

## 6. 推奨アーキテクチャ（本調査からの設計案）

```
ブラウザ (6人)
  │  Basic認証 (公式サンプルのパターン)
  ▼
Cloudflare Worker (エッジ)
  ├─ 静的アセット配信 (クライアント: Canvas/PixiJS 等)
  ├─ Basic 認証チェック (timingSafeEqual)
  └─ /room/:id への WebSocket アップグレード
        ▼
Durable Object (1ルーム = 1 DO, SQLite バックエンド)
  ├─ this.ctx.acceptWebSocket() で Hibernation 対応の接続受け入れ
  ├─ webSocketMessage() で入力受信 (キー入力のみ)
  ├─ 試合中のみ alarm で tick ループ (20〜30 tick/s)
  │    └─ 権威シミュレーション: 移動・爆弾・爆風・誘爆・死亡判定
  ├─ スナップショット/差分を全接続へブロードキャスト (送信は無課金)
  └─ 待機中は tick を止めて Hibernation (duration 課金ゼロ)

共有パッケージ (TypeScript)
  └─ 移動・当たり判定ロジックをサーバー/クライアントで共有
      (クライアント側予測 + サーバー照合のため)
```

- **人数**: DO の容量的に6人は全く問題ない。制約はゲームデザイン側（マップサイズとスポーン地点）のみ。15×13 より広いマップ（例: 17×15）にして6箇所スポーンを取るのが現実的。
- **同期方式**: まずは「サーバーが毎 tick フルスナップショット（または差分）を送る + クライアントは補間表示、自キャラのみ予測」から始める。ボンバーマンは状態が小さい（グリッド + 数体のプレイヤー + 爆弾リスト）のでフルスナップショットでも帯域は軽い。

## 7. 留意点・未解決の論点

1. **ネットコードの数値は Source エンジン（FPS）由来**。66.67 tick/s や 100ms 補間はそのまま適用すべき値ではない。「20〜30 tick で足りる」は本調査の推論であり、プロトタイプで実測すべき。
2. **無料枠の数値は 2026-08-06 時点**。料金・無料枠は変更されやすいので実装着手時に公式ページを再確認。
3. **Hibernation の節約はアイドル時のみ**。tick ループ中は duration 課金が発生する。無料枠内に収まるかは同時試合数 × 試合時間に依存（未実測。目安は §3.2）。
4. **代替インフラ比較は不完全**。Fly.io / Railway は二次情報のみ、Deno Deploy は公式数値の不在を確認したにとどまる。
5. **クラシック・ボンバーマンの細部ルール**（連鎖爆発の同時判定、当たり判定の寛容さ、パワーアップテーブル、ソフトブロック配置アルゴリズム）は忠実な一次資料での裏付けが未了。Bomberland はルール改変版。
6. **グリッド移動とクライアント側予測の相性**（サーバー訂正時のワープの平滑化）は具体的な実装パターン未調査。プロトタイプでの検証課題。

## 8. 主要出典

**一次資料（検証済み）**
- Valve: Source Multiplayer Networking — https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking
- Cloudflare DO Pricing — https://developers.cloudflare.com/durable-objects/platform/pricing/
- Cloudflare DO 無料枠チェンジログ (2025-04-07) — https://developers.cloudflare.com/changelog/2025-04-07-durable-objects-free-tier/
- Cloudflare DO Limits — https://developers.cloudflare.com/durable-objects/platform/limits
- Cloudflare DO WebSockets ベストプラクティス — https://developers.cloudflare.com/durable-objects/best-practices/websockets
- Cloudflare Workers Basic Auth 公式サンプル — https://developers.cloudflare.com/workers/examples/basic-auth/
- Bomberland — https://github.com/CoderOneHQ/bomberland

**二次資料（参考）**
- Gabriel Gambetta: Fast-Paced Multiplayer — https://www.gabrielgambetta.com/client-server-game-architecture.html
- SnapNet: Netcode Architectures Part 1: Lockstep — https://www.snapnet.dev/blog/netcode-architectures-part-1-lockstep/
- Kodeco: Bomberman with Unity — https://www.kodeco.com/244-how-to-make-a-game-like-bomberman-with-unity
- gamedev.net: Bomberman Mechanics in an ECS — https://www.gamedev.net/articles/programming/general-and-gameplay-programming/case-study-bomberman-mechanics-in-an-entity-component-system-r3159/
- Ritza: Fly.io vs Railway — https://ritza.co/articles/gen-articles/cloud-hosting-providers/fly-io-vs-railway/
- Deno Deploy Pricing and Limits — https://docs.deno.com/deploy/pricing_and_limits/
