# Drive Box

Google Drive と連携して、ブラウザからファイルのアップロード・ダウンロード・共有ができるウェブアプリです。
サーバー不要の静的サイトなので、GitHub Pages でそのまま公開できます。

**公開 URL（設定後）:** https://kon3dayo.github.io/gdrive/

## 機能

- 📁 ファイル一覧の表示・フォルダ移動（パンくずリスト、リスト / グリッド表示、並び替え）
- ⬆️ アップロード（ドラッグ＆ドロップ、複数ファイル、フォルダごと、進捗表示・キャンセル）
- ⬇️ ダウンロード（Google ドキュメント等は Office 形式に変換）
- ✏️ 名前変更・🗑️ ゴミ箱へ移動・📂 フォルダ作成
- 🔍 ファイル名検索
- 👁️ プレビュー（画像・PDF・動画・音声・テキスト・Google ドキュメント）
- 🔗 共有リンクの発行・解除（リンクを知っている全員が閲覧可）
- ➕ Google Picker で Drive の既存ファイルを追加
- 🌙 ダークモード、📱 スマホ対応

## セキュリティとプライバシー

- 権限は `drive.file` スコープのみ。**このアプリで作成したファイル**と**ユーザーが選択したファイル**にしかアクセスしません
- 通信はブラウザ ⇔ Google API の直接通信のみで、第三者のサーバーは経由しません
- アクセストークンはタブを閉じると破棄されます（sessionStorage）

## セットアップ

👉 **[docs/SETUP.md](docs/SETUP.md)** に、Google Cloud の設定から GitHub Pages での公開までの手順をまとめています。

概要:

1. GitHub Pages を有効化（Settings → Pages → `main` / root）
2. Google Cloud で Drive API と Picker API を有効化
3. OAuth クライアント ID と API キーを作成
4. [`js/config.js`](js/config.js) に値を記入して push

## ファイル構成

```
.
├── index.html          # 画面
├── css/style.css       # スタイル（ライト / ダーク、レスポンシブ）
├── js/
│   ├── config.js       # ★ Google Cloud の設定値をここに記入
│   ├── app.js          # UI・画面制御
│   ├── auth.js         # Google ログイン（Google Identity Services）
│   ├── drive.js        # Google Drive API ラッパー
│   └── picker.js       # Google Picker
├── assets/favicon.svg
├── docs/SETUP.md       # セットアップ & 公開ガイド
└── .nojekyll
```

## ローカル開発

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

## ライセンス

[MIT](LICENSE)