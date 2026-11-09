/**
 * 認証（Google Identity Services のトークンモデル）
 * サーバー不要で、ブラウザだけでアクセストークンを取得します。
 */
import { CONFIG, SCOPES } from './config.js';

const TOKEN_KEY = 'drivebox.token.v2';
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
  // トークンの有効期限内ならリロードや別タブでもログイン状態を維持
  try {
    const saved = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
    if (saved && saved.expires_at > Date.now() + 60_000) token = saved;
  } catch { /* ignore */ }

  await loadScript('https://accounts.google.com/gsi/client');
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.CLIENT_ID,
    scope: SCOPES,
    callback: () => {},
  });
}

function saveToken(access_token, expires_at) {
  token = {
    access_token,
    expires_at: Number(expires_at),
  };
  localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
  localStorage.setItem('drivebox.signedIn', '1');
}

/** ログインポップアップを表示してトークンを取得（ユーザー操作から呼ぶこと） */
export function signIn({ prompt = '' } = {}) {
  return new Promise((resolve, reject) => {
    tokenClient.callback = (resp) => {
      if (resp.error) return reject(new Error(resp.error_description || resp.error));
      if (!google.accounts.oauth2.hasGrantedAllScopes(resp, SCOPES)) {
        return reject(new Error('Google Drive へのアクセスが許可されませんでした。チェックボックスをオンにしてもう一度お試しください。'));
      }
      saveToken(resp.access_token, Date.now() + Number(resp.expires_in) * 1000);
      resolve(token.access_token);
    };
    tokenClient.error_callback = (err) => {
      reject(new Error(err.type === 'popup_closed' ? 'ログインがキャンセルされました' : (err.message || 'ログインに失敗しました')));
    };
    tokenClient.requestAccessToken({ prompt });
  });
}

/** 遠隔ログインで受け取ったトークンを通常のログインと同じ扱いで保存 */
export function setRemoteToken({ access_token, expires_at }) {
  if (!access_token || !expires_at || expires_at <= Date.now() + 30_000) {
    throw new Error('トークンの有効期限が切れています');
  }
  saveToken(access_token, expires_at);
}

/** 指定したアクセストークンを Google 側で無効化 */
export async function revokeToken(accessToken) {
  if (!accessToken) return;
  try {
    await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(accessToken)}`, {
      method: 'POST',
      headers: { 'Content-type': 'application/x-www-form-urlencoded' },
    });
  } catch {
    if (window.google?.accounts?.oauth2) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
  }
}

export function signOut() {
  if (token) revokeToken(token.access_token);
  clearToken();
  localStorage.removeItem('drivebox.signedIn');
}

export function clearToken() {
  token = null;
  localStorage.removeItem(TOKEN_KEY);
}

export function hasValidToken() {
  return !!token && token.expires_at > Date.now() + 30_000;
}

export function getToken() {
  return hasValidToken() ? token.access_token : null;
}

export function getTokenInfo() {
  return hasValidToken() ? { ...token } : null;
}
