/**
 * Google Drive API v3 の薄いラッパー（fetch ベース）
 */
import { getToken } from './auth.js';

const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

export const FOLDER_MIME = 'application/vnd.google-apps.folder';

const FILE_FIELDS = [
  'id', 'name', 'mimeType', 'size', 'modifiedTime', 'iconLink', 'thumbnailLink',
  'webViewLink', 'parents', 'shared',
  'capabilities(canDelete,canRename,canTrash,canShare,canDownload,canAddChildren)',
].join(',');

export class AuthError extends Error {}

async function request(url, options = {}) {
  const token = getToken();
  if (!token) throw new AuthError('ログインの有効期限が切れました');
  const res = await fetch(url, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
  });
  if (res.status === 401) throw new AuthError('ログインの有効期限が切れました');
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const body = await res.json();
      msg = body.error?.message || msg;
    } catch { /* ignore */ }
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  return res;
}

const json = async (url, options) => {
  const res = await request(url, options);
  return res.status === 204 ? null : res.json();
};

const qs = (params) => new URLSearchParams(
  Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''),
).toString();

/** Drive の検索クエリ用に文字列をエスケープ */
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

export function about() {
  return json(`${API}/about?fields=user(displayName,emailAddress,photoLink)`);
}

/**
 * ファイル一覧
 * @param {{folderId?: string, search?: string, orderBy?: string, pageToken?: string}} opts
 *  - folderId 指定: そのフォルダ直下
 *  - search 指定: 名前で検索
 *  - どちらもなし: アプリがアクセスできる全ファイル
 */
export function listFiles({ folderId, search, sharedWithMe, onlyFolders, orderBy = 'folder,name', pageToken } = {}) {
  const q = ['trashed = false'];
  if (folderId) q.push(`'${esc(folderId)}' in parents`);
  if (sharedWithMe) q.push('sharedWithMe = true');
  if (onlyFolders) q.push(`mimeType = '${FOLDER_MIME}'`);
  if (search) q.push(`name contains '${esc(search)}'`);
  return json(`${API}/files?${qs({
    q: q.join(' and '),
    orderBy,
    pageSize: 100,
    pageToken,
    fields: `nextPageToken,files(${FILE_FIELDS})`,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  })}`);
}

export function getFile(id, fields = FILE_FIELDS) {
  return json(`${API}/files/${encodeURIComponent(id)}?${qs({ fields, supportsAllDrives: true })}`);
}

export function createFolder(name, parentId) {
  return json(`${API}/files?${qs({ fields: FILE_FIELDS, supportsAllDrives: true })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: parentId ? [parentId] : undefined }),
  });
}

export function renameFile(id, name) {
  return json(`${API}/files/${encodeURIComponent(id)}?${qs({ fields: FILE_FIELDS, supportsAllDrives: true })}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

export function trashFile(id) {
  return json(`${API}/files/${encodeURIComponent(id)}?${qs({ fields: 'id', supportsAllDrives: true })}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ trashed: true }),
  });
}

/** ファイル本体を Blob で取得 */
export async function downloadBlob(id) {
  const res = await request(`${API}/files/${encodeURIComponent(id)}?alt=media&supportsAllDrives=true`);
  return res.blob();
}

/** Google ドキュメント等を別形式に変換して取得 */
export async function exportBlob(id, mimeType) {
  const res = await request(`${API}/files/${encodeURIComponent(id)}/export?${qs({ mimeType })}`);
  return res.blob();
}

/** 「リンクを知っている全員が閲覧可」にする */
export async function shareAnyone(id) {
  await json(`${API}/files/${encodeURIComponent(id)}/permissions?${qs({ supportsAllDrives: true })}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'anyone', role: 'reader' }),
  });
  return getFile(id);
}

/** 「リンクを知っている全員」の権限を削除 */
export async function unshareAnyone(id) {
  await json(`${API}/files/${encodeURIComponent(id)}/permissions/anyoneWithLink?${qs({ supportsAllDrives: true })}`, {
    method: 'DELETE',
  });
}

/**
 * レジュマブルアップロード（大きなファイルにも対応・進捗表示可）
 * @returns {{promise: Promise<object>, abort: () => void}}
 */
export function uploadFile(file, parentId, onProgress) {
  let xhr = null;
  let aborted = false;
  const promise = (async () => {
    const token = getToken();
    if (!token) throw new AuthError('ログインの有効期限が切れました');
    const init = await fetch(`${UPLOAD_API}/files?${qs({ uploadType: 'resumable', fields: FILE_FIELDS, supportsAllDrives: true })}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': file.type || 'application/octet-stream',
        'X-Upload-Content-Length': String(file.size),
      },
      body: JSON.stringify({ name: file.name, parents: parentId ? [parentId] : undefined }),
    });
    if (init.status === 401) throw new AuthError('ログインの有効期限が切れました');
    if (!init.ok) {
      const body = await init.json().catch(() => ({}));
      throw new Error(body.error?.message || `アップロード開始に失敗しました (${init.status})`);
    }
    const location = init.headers.get('Location');
    if (!location) throw new Error('アップロード URL を取得できませんでした');
    if (aborted) throw new DOMException('Aborted', 'AbortError');

    return new Promise((resolve, reject) => {
      xhr = new XMLHttpRequest();
      xhr.open('PUT', location);
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve(JSON.parse(xhr.responseText));
        else reject(new Error(`アップロードに失敗しました (${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error('ネットワークエラーが発生しました'));
      xhr.onabort = () => reject(new DOMException('Aborted', 'AbortError'));
      xhr.send(file);
    });
  })();
  return {
    promise,
    abort: () => { aborted = true; xhr?.abort(); },
  };
}
