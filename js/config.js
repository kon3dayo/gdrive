/**
 * Google Cloud の設定値
 * -----------------------------------------------------------
 * 取得方法は docs/SETUP.md を参照してください。
 *
 * ※ これらの値はブラウザに配信されるため「公開情報」です。
 *   - CLIENT_ID は公開しても問題ありません（承認済みオリジンで保護されます）
 *   - API_KEY は必ず「HTTP リファラー制限」と「API 制限」をかけてください
 */
export const CONFIG = {
  // OAuth 2.0 クライアント ID（例: 1234567890-abcdefg.apps.googleusercontent.com）
  CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',

  // API キー（Google Picker 用）
  API_KEY: 'YOUR_API_KEY',

  // プロジェクト番号（数字のみ。Google Picker でファイルへのアクセス権を付与するのに必要）
  APP_ID: 'YOUR_PROJECT_NUMBER',
};

// アプリが要求する権限（変更不要）
// drive.file = このアプリで作成したファイル / ユーザーが Picker で選んだファイルのみにアクセス
export const SCOPES = 'https://www.googleapis.com/auth/drive.file';
