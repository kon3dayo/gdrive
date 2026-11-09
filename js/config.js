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
  // OAuth 2.0 クライアント ID
  CLIENT_ID: '677359419581-45ftik3pfee8d19ovj65ejnj75m11ch8.apps.googleusercontent.com',

  // API キー（Google Picker 用）
  API_KEY: 'AIzaSyDLRLj7xOZPgHiRhJJTApyf4USFkMUPL0s',

  // プロジェクト番号（CLIENT_ID の先頭の数字と同じ）
  APP_ID: '677359419581',
};

// アプリが要求する権限（変更不要）
// drive.file = このアプリで作成したファイル / ユーザーが Picker で選んだファイルのみにアクセス
export const SCOPES = 'https://www.googleapis.com/auth/drive.file';
