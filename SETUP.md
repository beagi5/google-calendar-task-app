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
