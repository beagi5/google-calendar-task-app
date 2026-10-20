# セットアップ手順(新しいPCでの再構築用)

## 前提

- Node.js(v18以上推奨。動作確認はv24)
- git

## 1. clone・依存関係インストール

```
git clone https://github.com/beagi5/google-calendar-task-app.git
cd google-calendar-task-app
npm install
cd server
npm install
cd ..
```

## 2. `server/.env` を作成

gitには含まれていない(秘密情報のため)。`server/.env` を新規作成し、以下を記入:

```
GOOGLE_CLIENT_ID=<Google Cloud ConsoleのOAuthクライアントID>
GOOGLE_CLIENT_SECRET=<同クライアントシークレット>
SESSION_SECRET=<ランダムな文字列>
NODE_ENV=development
FRONTEND_URL=http://localhost:3000
COOKIE_SECURE=false
GOOGLE_CALLBACK_URL=http://localhost:3001/auth/google/callback
```

OAuthクライアントの場所: Google Cloud Console(プロジェクト番号 `217216459456`)→「APIとサービス」→「認証情報」→ **「Task Manager Pro」という名前のウェブアプリケーション型クライアント**(デスクトップ型のクライアントも同プロジェクトに残っているが、そちらは使わない。理由は下記「ハマりどころ」参照)。

### 任意: Claude 用の書き込み口（`/api/claude/`）

Google ログインの代わりにトークンで読み書きする API。**2つとも設定したときだけ有効**（片方でも無ければ 503 を返す）。

```
CLAUDE_API_TOKEN=<十分に長いランダムな文字列。例: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))">
CLAUDE_API_USER_ID=<自分の Google のユーザーID。tasks.json の各行の userId と同じ値>
```

- 呼び出しは `Authorization: Bearer <トークン>` を付ける。トークンはこのファイル以外に書かない（git・ログ・チャットに出さない）
- **日本語を含む JSON は、UTF-8 のファイルか標準入力で送る**（`curl --data-binary @file.json` など）。Git 付属の curl は引数の日本語を Shift-JIS で送るため、化けた文字（U+FFFD）を含む本文は 400 で断る
- 書き込みは15分に50回まで（`/api` 共通の制限）。まとめて作るときは `POST /api/claude/tasks/bulk`（1〜200件）
- Google カレンダーには触らない。カレンダーとつながった行の完了・期日の変更と削除は 409（画面から行う）

テスト用に `TASKS_FILE=<パス>` で保存先を変えられる（未設定なら `server/data/tasks.json`）。サーバーのテストは `cd server && npm test`。

### 任意: Notion の「やること」を画面に出す（`/api/yarukoto`）

画面の上のほう（メインの列。「今日は〇〇の日」の帯とカテゴリのボタンの下）の「やること」カードが、Notion のデータベース「やること」の「1時間」の行を読み、行のチェックで「済」を書き戻す。**最初の2つを設定したときだけ有効**（片方でも無ければ `/api/yarukoto` は 503 を返し、カードに「Notion の鍵が未設定です」と出る。ほかの画面は今までどおり動く）。

```
NOTION_TOKEN=<Notion のトークン>
NOTION_YARUKOTO_DATA_SOURCE_ID=<「やること」データベースの data source ID>
NOTION_API_BASE=https://api.notion.com
NOTION_VERSION=2026-03-11
```

- 鍵（トークン）の作り方: Notion の内部コネクション（Internal connection）。Capabilities は Read content と Update content。「やること」のデータベースだけに接続する。公式: https://developers.notion.com/guides/get-started/internal-connections
- `NOTION_API_BASE`（テスト用に向け先を変える）と `NOTION_VERSION` は任意。書かなければ上に書いた値になる。前後の空白は無視される
- トークンはこのファイル以外に書かない（git・ログ・チャットに出さない）。サーバーの中だけで使い、ブラウザには渡さない
- 読むのは 種類=1時間 の行のうち、未済（どの週でも）と、予定週が今週の月曜以降の済と、今日（サーバーの時計で0時以降）に最終更新された済（後で・先週の行を今日済ませたものを、画面が「今日の目標」に数えるため）。読んだ一覧は15秒だけサーバーのメモリに覚え、その間の再読み込みでは Notion を呼ばない。画面からできるのは「済」の切り替えだけ（行の作成、名前や週の編集はしない）
- Notion に書き込めるのは、直近1時間のうちに一覧に出た行だけ（済にして一覧から外れた行も、1時間は未済に戻せる）。それ以外の id は 404。`/api` 共通の回数制限（15分に50回）がかかる

## 3. ビルド・起動確認

```
npm run build
node server/index.js
```

`http://localhost:3001/` を開いてログインできれば成功。

## 4. PM2で常駐化 + Windows起動時の自動復帰

```
npm install -g pm2
npm install -g pm2-windows-startup
pm2 start ecosystem.config.js
pm2 save
pm2-startup install
```

## 5. Tailscaleでスマホからもアクセスできるようにする

1. このPCとスマホの両方にTailscaleをインストールし、**同じアカウント**でログイン
2. このPCで `tailscale status` を実行し、MagicDNSホスト名を確認(例: `desktop-xxxx.tailXXXX.ts.net`)
3. Google Cloud Consoleの「Task Manager Pro」(ウェブアプリケーション型)クライアントを開き、「承認済みのリダイレクトURI」に以下を**追加**(既存のlocalhost用は残す):
   ```
   http://<2で確認したホスト名>:3001/auth/google/callback
   ```
4. `server/.env` の `GOOGLE_CALLBACK_URL` を新しいホスト名のURLに書き換え
5. `pm2 restart calendar-task-app`
6. スマホのブラウザで `http://<ホスト名>:3001/` を開いて確認(**Tailscaleアプリがスマホ側で接続中である必要がある**)

## ハマりどころ(実際に踏んだ罠)

- **OAuthクライアントは必ず「ウェブ アプリケーション」タイプで作成すること。** 「デスクトップ」タイプだと、Googleの仕様上ループバックIP(`127.0.0.1`)以外のリダイレクトURIを一切受け付けない。Tailscaleのホスト名は登録できず、リダイレクトURI追加のUI自体がまともに機能しない。
- **helmetのCSPで `upgradeInsecureRequests` を無効化しておくこと**(`server/index.js`の該当箇所に `upgradeInsecureRequests: null` を設定済み)。これが有効だと、`localhost`以外のホスト名/IPでアクセスした際に、ブラウザが静的アセット(JS/CSS/画像)だけを勝手にHTTPSへ自動アップグレードしようとして全滅する(`ERR_SSL_PROTOCOL_ERROR`、画面が真っ白になる)。`localhost`は例外的にブラウザに「安全」とみなされるため、ローカルでのテストでは症状が出ず気づきにくい。
- **HSTSも無効化しておくこと**(`hsts: false` を設定済み)。同様に、平文HTTPで運用する前提のアプリで有効にすると、後からTailscale等の別ホスト名でアクセスした際にブラウザがHTTPS接続を強制し、接続できなくなる。
- `server/data/tasks.json` は個人のタスクデータで、gitには含まれない(`server/.gitignore`で`data/`を除外)。新しい環境ではタスク0件の空の状態から始まる。
