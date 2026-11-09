/**
 * 遠隔ログイン（別PC・共有PCへのペアリング＆トークン受け渡し）
 *
 * 仕組み:
 *  1. 別PC（ログインしたい側）が 6桁のワンタイムコードを生成して表示（QRコードも表示）
 *  2. スマホまたはメインPC（Googleログイン済み側）が QRコードを読むか 6桁コードを入力
 *  3. トークンをブラウザ内で 6桁コードから導出した鍵で AES-256-GCM 暗号化して中継チャネルへ送信
 *     （中継サーバーには暗号文とハッシュ化されたトピック名しか渡らないため中身は解読不可）
 *  4. ネットワーク制限等で中継が使えない場合に備え、「ログインキーの手動コピー＆ペースト」にも対応
 */
import { loadScript } from './auth.js';

const RELAY_BASE = 'https://ntfy.sh';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** 6桁のランダムな数字コードを生成 */
export function generatePairCode() {
  const arr = new Uint32Array(1);
  crypto.getRandomValues(arr);
  return String(100000 + (arr[0] % 900000));
}

export function formatPairCode(code) {
  const c = normalizePairCode(code);
  return c ? `${c.slice(0, 3)}-${c.slice(3)}` : code;
}

export function normalizePairCode(input) {
  const digits = String(input || '').replace(/\D/g, '');
  return digits.length === 6 ? digits : null;
}

function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 6桁コードから「中継トピック名」と「AES-256-GCM 暗号鍵」を導出 */
async function deriveChannel(code) {
  const normalized = normalizePairCode(code);
  if (!normalized) throw new Error('6桁のコードを入力してください');

  // トピック名（コードそのものが中継サーバーに知られないよう SHA-256 ハッシュ化）
  const topicDigest = await crypto.subtle.digest('SHA-256', enc.encode(`drivebox-pair-topic-v1:${normalized}`));
  const topicHex = [...new Uint8Array(topicDigest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const topic = `dbx-${topicHex.slice(0, 24)}`;

  // 暗号鍵（PBKDF2 -> AES-256-GCM）
  const baseKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(`drivebox-pair-key-v1:${normalized}`),
    'PBKDF2',
    false,
    ['deriveKey'],
  );
  const aesKey = await crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: enc.encode('drivebox-pair-salt-v1'),
      iterations: 100_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  return { topic, aesKey };
}

async function encryptToken(aesKey, tokenInfo) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = enc.encode(JSON.stringify({
    access_token: tokenInfo.access_token,
    expires_at: tokenInfo.expires_at,
    ts: Date.now(),
  }));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plain));
  const combined = new Uint8Array(iv.length + cipher.length);
  combined.set(iv, 0);
  combined.set(cipher, iv.length);
  return `E1.${toBase64Url(combined)}`;
}

async function decryptToken(aesKey, message) {
  if (typeof message !== 'string' || !message.startsWith('E1.')) return null;
  try {
    const combined = fromBase64Url(message.slice(3));
    if (combined.length < 28) return null;
    const iv = combined.slice(0, 12);
    const cipher = combined.slice(12);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, cipher);
    const data = JSON.parse(dec.decode(plain));
    // 10分以上前の古いメッセージは無視
    if (!data.access_token || !data.expires_at || Math.abs(Date.now() - Number(data.ts || 0)) > 10 * 60_000) {
      return null;
    }
    return { access_token: data.access_token, expires_at: Number(data.expires_at) };
  } catch {
    return null;
  }
}

/**
 * スマホ / メインPC側：6桁コード宛に暗号化したトークンを送信
 */
export async function sendTokenToCode(code, tokenInfo) {
  const { topic, aesKey } = await deriveChannel(code);
  const payload = await encryptToken(aesKey, tokenInfo);
  const res = await fetch(`${RELAY_BASE}/${topic}`, {
    method: 'POST',
    body: payload,
  });
  if (!res.ok) {
    throw new Error(`送信に失敗しました (${res.status})。手動ログインキーをお試しください。`);
  }
}

/**
 * 別PC側：6桁コード宛にトークンが届くのを待機
 */
export async function waitForToken(code, { signal } = {}) {
  const { topic, aesKey } = await deriveChannel(code);

  return new Promise((resolve, reject) => {
    let settled = false;
    let es = null;
    let pollTimer = null;

    const cleanup = () => {
      settled = true;
      try { es?.close(); } catch { /* ignore */ }
      clearInterval(pollTimer);
    };

    signal?.addEventListener('abort', () => {
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    });

    const handleRawLine = async (line) => {
      if (settled || !line) return;
      try {
        const evt = JSON.parse(line);
        if (evt.event !== 'message' || !evt.message) return;
        const tok = await decryptToken(aesKey, evt.message);
        if (tok && !settled) {
          cleanup();
          resolve(tok);
        }
      } catch { /* ignore */ }
    };

    // 1. Server-Sent Events でリアルタイム受信
    try {
      es = new EventSource(`${RELAY_BASE}/${topic}/sse?since=5m`);
      es.onmessage = (e) => handleRawLine(e.data);
    } catch { /* 폴백のみ使用 */ }

    // 2. プロキシ等で SSE がブロックされる環境向けに 3 秒おきにポーリングも併用
    const poll = async () => {
      if (settled) return;
      try {
        const res = await fetch(`${RELAY_BASE}/${topic}/json?poll=1&since=5m`, { signal });
        if (!res.ok) return;
        const text = await res.text();
        for (const line of text.split('\n')) {
          await handleRawLine(line.trim());
        }
      } catch { /* ignore */ }
    };
    poll();
    pollTimer = setInterval(poll, 3000);
  });
}

/**
 * 手動コピー＆ペースト用のログインキー（中継サーバー不要のフォールバック）
 */
export function encodeManualKey(tokenInfo) {
  const payload = JSON.stringify({
    a: tokenInfo.access_token,
    e: tokenInfo.expires_at,
  });
  return `DBX1.${toBase64Url(enc.encode(payload))}`;
}

export function decodeManualKey(str) {
  const trimmed = String(str || '').trim();
  if (!trimmed.startsWith('DBX1.')) throw new Error('有効なログインキーではありません');
  try {
    const data = JSON.parse(dec.decode(fromBase64Url(trimmed.slice(5))));
    if (!data.a || !data.e) throw new Error();
    return { access_token: data.a, expires_at: Number(data.e) };
  } catch {
    throw new Error('ログインキーの形式が正しくありません');
  }
}

/** QRコードの SVG をブラウザ内で生成（外部にURLを送信しない） */
export async function renderQrSvg(url) {
  await loadScript('https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js');
  const qr = window.qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  return qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
}
