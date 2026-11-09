/**
 * 認証（Google Identity Services のトークンモデル）
 * サーバー不要で、ブラウザだけでアクセストークンを取得します。
 */
import { CONFIG, SCOPES } from './config.js';

const TOKEN_KEY = 'drivebox.token';
let tokenClient = null;
let token = null; // { access_token, expires_at }

export function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`スクリプトの読み込みに失敗しました: ${src}`));
    document.head.appendChild(s);
  });
}

export function isConfigured() {
  return !Object.values(CONFIG).some((v) => !v || String(v).startsWith('YOUR_'));
}

export async function initAuth() {
  await loadScript('https://accounts.google.com/gsi/client');
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: () => {},
  });
  // 同じタブ内のリロードではログイン状態を維持（トークンの有効期限は約 1 時間）
  try {
    const saved = JSON.parse(sessionStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expires_at > Date.now() + 60_000) token = saved;
  } catch { /* ignore */ }
}

/** ログインポップアップを表示してトークンを取得（ユーザー操作から呼ぶこと） */
export function signIn({ prompt = '' } = {}) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPES)) {
        return reject(new Error('Google Drive へのアクセスが許可されませんでした。チェックボックスをオンにしてもう一度お試しください。'));
      }
      token = {
        access_token: resp.access_token,
        expires_at: Date.now() + Number(resp.expires_in) * 1000,
      };
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(token));
      localStorage.setItem('drivebox.signedIn', '1');
      resolve(token.access_token);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error(err.type === 'popup_closed' ? 'ログインがキャンセルされました' : (err.message || 'ログインに失敗しました')));
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

export function signOut() {
  if (token) google.accounts.oauth2.revoke(token.access_token, () => {});
  clearToken();
  localStorage.removeItem('drivebox.signedIn');
}

export function clearToken() {
  token = null;
  sessionStorage.removeItem(TOKEN_KEY);
}

export function hasValidToken() {
  return !!token && token.expires_at > Date.now() + 30_000;
}

export function getToken() {
  return hasValidToken() ? token.access_token : null;
}
