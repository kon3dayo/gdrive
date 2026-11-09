/**
 * Drive Box - メインアプリ
 */
import {
  initAuth, isConfigured, signIn, signOut, clearToken,
  hasValidToken, getTokenInfo, setRemoteToken,
} from './auth.js';
import * as drive from './drive.js';
import { FOLDER_MIME, AuthError } from './drive.js';
import { pickFiles } from './picker.js';
import {
  generatePairCode, formatPairCode, normalizePairCode,
  sendTokenToCode, waitForToken, encodeManualKey, decodeManualKey, renderQrSvg,
} from './remote.js';

// ------------------------------------------------------------
// DOM ヘルパー
// ------------------------------------------------------------
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const el = {
  login: $('#login-screen'),
  loginBtn: $('#login-btn'),
  loginMsg: $('#login-message'),
  app: $('#app'),
  files: $('#files'),
  fileArea: $('#file-area'),
  empty: $('#empty'),
  emptyText: $('#empty-text'),
  loading: $('#loading'),
  sentinel: $('#sentinel'),
  breadcrumb: $('#breadcrumb'),
  sort: $('#sort-select'),
  viewBtn: $('#view-btn'),
  contextMenu: $('#context-menu'),
  newDropdown: $('#new-dropdown'),
  userDropdown: $('#user-dropdown'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
  searchInput: $('#search-input'),
  searchClear: $('#search-clear'),
  dropOverlay: $('#drop-overlay'),
  dropText: $('#drop-text'),
  uploads: $('#uploads'),
  uploadsList: $('#uploads-list'),
  uploadsTitle: $('#uploads-title'),
  toasts: $('#toasts'),
  fileInput: $('#file-input'),
  folderInput: $('#folder-input'),
  preview: $('#preview-modal'),
  previewContent: $('#preview-content'),
};

// ------------------------------------------------------------
// 状態
// ------------------------------------------------------------
const state = {
  route: { type: 'root' },
  files: [],
  nextPageToken: null,
  loading: false,
  loadSeq: 0,
  rootId: null,
  folderCache: new Map(), // id -> { id, name, parents }
  menuFile: null,
  previewFile: null,
  previewUrl: null,
  view: localStorage.getItem('drivebox.view') || 'list',
};

// ------------------------------------------------------------
// フォーマット
// ------------------------------------------------------------
function formatSize(bytes) {
  if (bytes === undefined || bytes === null || bytes === '') return '—';
  let n = Number(bytes);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }
  if (d.getFullYear() === now.getFullYear()) {
    return d.toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' });
  }
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: '2-digit', day: '2-digit' });
}

const isFolder = (f) => f.mimeType === FOLDER_MIME;
const isGoogleDoc = (f) => f.mimeType.startsWith('application/vnd.google-apps.') && !isFolder(f);

function fileIcon(f) {
  const m = f.mimeType || '';
  const map = [
    [() => isFolder(f), 'folder', 'var(--icon-folder)'],
    [() => m.startsWith('image/'), 'image', '#d93025'],
    [() => m === 'application/pdf', 'picture_as_pdf', '#d93025'],
    [() => m.startsWith('video/'), 'movie', '#d93025'],
    [() => m.startsWith('audio/'), 'music_note', '#9334e6'],
    [() => m.includes('google-apps.document') || m.includes('wordprocessing') || m === 'application/msword', 'description', '#4285f4'],
    [() => m.includes('google-apps.spreadsheet') || m.includes('spreadsheet') || m.includes('excel') || m === 'text/csv', 'table_chart', '#0f9d58'],
    [() => m.includes('google-apps.presentation') || m.includes('presentation') || m.includes('powerpoint'), 'slideshow', '#f4b400'],
    [() => m.includes('google-apps.form'), 'list_alt', '#7248b9'],
    [() => m.includes('zip') || m.includes('compressed') || m.includes('tar') || m.includes('rar') || m.includes('7z'), 'folder_zip', '#5f6368'],
    [() => m.startsWith('text/') || m.includes('json') || m.includes('javascript') || m.includes('xml'), 'article', '#5f6368'],
  ];
  const hit = map.find(([test]) => test());
  return hit ? { name: hit[1], color: hit[2] } : { name: 'draft', color: '#5f6368' };
}

const iconHtml = (f, cls = '') => {
  const ic = fileIcon(f);
  return `<span class="ms file-icon ${cls}" style="color:${ic.color}" aria-hidden="true">${ic.name}</span>`;
};

// ------------------------------------------------------------
// トースト
// ------------------------------------------------------------
function toast(message, { type = 'info', action, timeout = 4000 } = {}) {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.innerHTML = `<span>${escapeHtml(message)}</span>`;
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.onclick = () => { action.onClick(); t.remove(); };
    t.appendChild(b);
  }
  el.toasts.appendChild(t);
  requestAnimationFrame(() => t.classList.add('show'));
  setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => t.remove(), 300);
  }, timeout);
}

function handleError(err, context = '') {
  console.error(context, err);
  if (err instanceof AuthError) {
    clearToken();
    showLogin('ログインの有効期限が切れました。もう一度ログインしてください。');
    return;
  }
  if (err?.name === 'AbortError') return;
  let msg = err?.message || String(err);
  if (err?.status === 404) msg = 'ファイルが見つからないか、アクセス権がありません';
  if (err?.status === 403 && /insufficient|scope|permission/i.test(msg)) msg = 'このファイルにアクセスする権限がありません';
  toast(context ? `${context}: ${msg}` : msg, { type: 'error', timeout: 6000 });
}

// ------------------------------------------------------------
// ダイアログ
// ------------------------------------------------------------
function promptDialog({ title, value = '', okLabel = 'OK', selectUntilDot = false }) {
  const dlg = $('#prompt-modal');
  const input = $('#prompt-input');
  $('#prompt-title').textContent = title;
  $('#prompt-ok').textContent = okLabel;
  input.value = value;
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok' ? input.value.trim() : null);
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
    input.focus();
    const dot = value.lastIndexOf('.');
    if (selectUntilDot && dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  });
}

function confirmDialog({ title, text, okLabel = 'OK', danger = false }) {
  const dlg = $('#confirm-modal');
  $('#confirm-title').textContent = title;
  $('#confirm-text').textContent = text;
  const ok = $('#confirm-ok');
  ok.textContent = okLabel;
  ok.classList.toggle('btn-danger', danger);
  return new Promise((resolve) => {
    const onClose = () => {
      dlg.removeEventListener('close', onClose);
      resolve(dlg.returnValue === 'ok');
    };
    dlg.addEventListener('close', onClose);
    dlg.returnValue = '';
    dlg.showModal();
  });
}

$('#prompt-form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!$('#prompt-input').value.trim()) return;
  $('#prompt-modal').close('ok');
});
$('#confirm-ok').addEventListener('click', (e) => {
  e.preventDefault();
  $('#confirm-modal').close('ok');
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => b.closest('dialog').close('cancel')));
// 背景クリックで閉じる
$$('dialog.modal').forEach((d) => d.addEventListener('click', (e) => { if (e.target === d) d.close('cancel'); }));

// ------------------------------------------------------------
// ログイン / ログアウト / 遠隔ログイン（ペアリング）
// ------------------------------------------------------------
let pendingPairCode = null;
let receiveAbort = null;
const PINNED_KEY = 'drivebox.pinnedFolders';

function getPinnedFolders() {
  try {
    const arr = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
    return Array.isArray(arr) ? arr.filter((x) => x && x.id && x.name) : [];
  } catch {
    return [];
  }
}

function addPinnedFolders(folders) {
  if (!Array.isArray(folders) || !folders.length) return;
  const list = getPinnedFolders();
  for (const f of folders) {
    if (f && f.id && f.name && !list.some((x) => x.id === f.id)) {
      list.push({ id: f.id, name: f.name });
    }
  }
  localStorage.setItem(PINNED_KEY, JSON.stringify(list));
  renderPinnedFolders();
}

function removePinnedFolder(id) {
  const list = getPinnedFolders().filter((x) => x.id !== id);
  localStorage.setItem(PINNED_KEY, JSON.stringify(list));
  renderPinnedFolders();
}

function renderPinnedFolders() {
  const sec = $('#pinned-section');
  const listEl = $('#pinned-list');
  if (!sec || !listEl) return;
  const list = getPinnedFolders();
  sec.hidden = list.length === 0;
  const curFolderId = state.route.type === 'folder' ? state.route.id : null;
  listEl.innerHTML = list.map((f) => `
    <div class="pinned-item ${curFolderId === f.id ? 'active' : ''}">
      <a href="#/folder/${encodeURIComponent(f.id)}" class="pinned-link" title="${escapeHtml(f.name)}">
        <span class="ms">folder</span>
        <span>${escapeHtml(f.name)}</span>
      </a>
      <button type="button" class="icon-btn pinned-remove" data-remove-pin="${escapeHtml(f.id)}" title="一覧から外す">
        <span class="ms">close</span>
      </button>
    </div>
  `).join('');
}

$('#pinned-list')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-remove-pin]');
  if (btn) {
    e.preventDefault();
    e.stopPropagation();
    removePinnedFolder(btn.dataset.removePin);
  }
});

function getTokenWithPinned() {
  const info = getTokenInfo();
  return info ? { ...info, pinned: getPinnedFolders() } : null;
}

function extractPairCodeFromHash() {
  const m = location.hash.match(/^#\/?pair=(\d{6})$/);
  return m ? m[1] : null;
}

function updatePairBanner() {
  const banner = $('#pair-banner');
  const remoteBtn = $('#remote-login-btn');
  const label = $('#login-btn-label');
  if (pendingPairCode) {
    banner.hidden = false;
    $('#pair-banner-code-text').textContent = formatPairCode(pendingPairCode);
    $('#pair-banner-done').hidden = true;
    $('#pair-banner-desc').textContent = '下のボタンで Google にログインすると、別PCの画面が自動的にログインされます（別PCにパスワードを入力する必要はありません）。';
    el.loginBtn.hidden = false;
    remoteBtn.hidden = true;
    label.textContent = 'Google でログインして別PCを承認';
  } else {
    banner.hidden = true;
    el.loginBtn.hidden = false;
    remoteBtn.hidden = false;
    label.textContent = 'Google でログイン';
  }
}

function showLogin(message = '') {
  el.app.hidden = true;
  el.login.hidden = false;
  el.loginMsg.textContent = message;
  updatePairBanner();
  closeAllMenus();
  $$('dialog[open]').forEach((d) => d.close());
}

async function startApp() {
  el.login.hidden = true;
  el.app.hidden = false;
  applyView();
  renderPinnedFolders();

  try {
    const [{ user }, root] = await Promise.all([
      drive.about(),
      drive.getFile('root', 'id').catch(() => null),
    ]);
    state.rootId = root?.id || null;
    $('#user-name').textContent = user.displayName || '';
    $('#user-email').textContent = user.emailAddress || '';
    $('#avatar-initial').textContent = (user.displayName || user.emailAddress || '?').charAt(0).toUpperCase();
    if (user.photoLink) {
      const img = $('#avatar-img');
      img.src = user.photoLink;
      img.hidden = false;
      img.onerror = () => { img.hidden = true; };
    }
  } catch (err) {
    handleError(err, 'ユーザー情報の取得');
    if (err instanceof AuthError) return;
  }
  route();
}

el.loginBtn.addEventListener('click', async () => {
  el.loginMsg.textContent = '';
  try {
    await signIn();
    // スマホでQRコードを読み取ってログインした場合は、そのまま別PCへトークンを暗号化送信
    if (pendingPairCode) {
      const code = pendingPairCode;
      await sendTokenToCode(code, getTokenWithPinned());
      $('#pair-banner-desc').textContent = `✅ コード ${formatPairCode(code)} の別PCへログイン許可を送信しました！別PCの画面が自動で切り替わります。`;
      $('#pair-banner-done').hidden = false;
      el.loginBtn.hidden = true;
      return;
    }
    await startApp();
  } catch (err) {
    el.loginMsg.textContent = err.message;
  }
});

$('#pair-revoke-btn').addEventListener('click', () => {
  pendingPairCode = null;
  history.replaceState(null, '', location.pathname);
  signOut();
  showLogin('別PCのセッションを強制終了（トークン無効化）しました');
});

$('#pair-continue-btn').addEventListener('click', async () => {
  pendingPairCode = null;
  history.replaceState(null, '', '#/');
  await startApp();
});

function doLogout(msg = 'ログアウトしました') {
  signOut();
  state.files = [];
  state.folderCache.clear();
  el.files.innerHTML = '';
  $('#avatar-img').hidden = true;
  showLogin(msg);
}

$('#logout-btn').addEventListener('click', () => doLogout());

// ----- 別PC側（遠隔ログインを受ける側） -----
async function startReceivePairing() {
  receiveAbort?.abort();
  receiveAbort = new AbortController();
  const { signal } = receiveAbort;

  const code = generatePairCode();
  $('#remote-code-display').textContent = formatPairCode(code);
  $('#remote-wait-status').innerHTML = '<span class="dot-pulse"></span>承認を待っています…';

  const pairUrl = `${location.origin}${location.pathname}#pair=${code}`;
  const qrBox = $('#remote-qr');
  qrBox.innerHTML = '<div class="spinner"></div>';
  renderQrSvg(pairUrl)
    .then((svg) => { if (!signal.aborted) qrBox.innerHTML = svg; })
    .catch(() => { if (!signal.aborted) qrBox.innerHTML = '<span class="muted">QR読込失敗（右の6桁コードをお使いください）</span>'; });

  try {
    const tok = await waitForToken(code, { signal });
    setRemoteToken(tok);
    if (tok.pinned?.length) addPinnedFolders(tok.pinned);
    $('#remote-receive-modal').close();
    await startApp();
    toast('ログインしました');
  } catch (err) {
    if (err?.name !== 'AbortError') {
      $('#remote-wait-status').textContent = `待機エラー: ${err.message}`;
    }
  }
}

$('#remote-login-btn').addEventListener('click', () => {
  $('#remote-manual-input').value = '';
  $('#remote-receive-modal').showModal();
  startReceivePairing();
});

$('#remote-regenerate-btn').addEventListener('click', () => startReceivePairing());
$('#remote-receive-modal').addEventListener('close', () => receiveAbort?.abort());

$('#remote-manual-submit').addEventListener('click', async () => {
  try {
    const tok = decodeManualKey($('#remote-manual-input').value);
    setRemoteToken(tok);
    if (tok.pinned?.length) addPinnedFolders(tok.pinned);
    $('#remote-receive-modal').close();
    await startApp();
    toast('ログインしました');
  } catch (err) {
    toast(err.message, { type: 'error' });
  }
});

// ----- スマホ・メインPC側（別PCを遠隔ログインさせる側） -----
function openRemoteSendModal(prefillCode = '') {
  closeAllMenus();
  const info = getTokenWithPinned();
  if (!info) return;
  const input = $('#remote-send-code');
  input.value = prefillCode ? formatPairCode(prefillCode) : '';
  $('#remote-send-status').hidden = true;
  $('#remote-revoke-bar').hidden = true;
  $('#remote-manual-key').value = encodeManualKey(info);
  $('#remote-send-modal').showModal();
  input.focus();
}

$('#remote-send-btn').addEventListener('click', () => openRemoteSendModal());
$('#remote-send-menu-btn').addEventListener('click', () => openRemoteSendModal());

$('#remote-send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const statusEl = $('#remote-send-status');
  const submitBtn = $('#remote-send-submit');
  const code = normalizePairCode($('#remote-send-code').value);
  if (!code) {
    statusEl.hidden = false;
    statusEl.className = 'remote-send-status danger';
    statusEl.textContent = '6桁の数字コードを入力してください';
    return;
  }
  submitBtn.disabled = true;
  statusEl.hidden = false;
  statusEl.className = 'remote-send-status';
  statusEl.textContent = '暗号化して送信中…';
  try {
    await sendTokenToCode(code, getTokenWithPinned());
    statusEl.textContent = `✅ コード ${formatPairCode(code)} の別PCへログイン許可を送信しました！`;
    $('#remote-revoke-bar').hidden = false;
  } catch (err) {
    statusEl.className = 'remote-send-status danger';
    statusEl.textContent = err.message;
  } finally {
    submitBtn.disabled = false;
  }
});

$('#remote-revoke-all-btn').addEventListener('click', () => {
  $('#remote-send-modal').close();
  doLogout('別PCを含めすべてのセッションを無効化しました');
});

$('#remote-manual-copy').addEventListener('click', async () => {
  const input = $('#remote-manual-key');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('ログインキーをコピーしました。別PCで貼り付けてください');
});

// ------------------------------------------------------------
// ルーティング（URL ハッシュ）
// ------------------------------------------------------------
function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [type, ...rest] = h.split('/');
  const arg = decodeURIComponent(rest.join('/'));
  if (type === 'folder' && arg) return { type: 'folder', id: arg };
  if (type === 'shared') return { type: 'shared' };
  if (type === 'recent') return { type: 'recent' };
  if (type === 'search' && arg) return { type: 'search', query: arg };
  return { type: 'root' };
}

function route() {
  const pair = extractPairCodeFromHash();
  if (pair) {
    if (hasValidToken()) {
      history.replaceState(null, '', '#/');
      openRemoteSendModal(pair);
    } else {
      pendingPairCode = pair;
      showLogin('');
      return;
    }
  }
  if (!hasValidToken()) return;
  state.route = parseHash();
  $$('.nav-item').forEach((a) => a.classList.toggle('active', a.dataset.nav === state.route.type));
  renderPinnedFolders();
  if (state.route.type === 'search') {
    el.searchInput.value = state.route.query;
    el.searchClear.hidden = false;
  } else if (document.activeElement !== el.searchInput) {
    el.searchInput.value = '';
    el.searchClear.hidden = true;
  }
  closeDrawer();
  renderBreadcrumb();
  loadFiles();
}

window.addEventListener('hashchange', route);

/** 現在の表示場所のアップロード先フォルダ */
function currentParentId() {
  return state.route.type === 'folder' ? state.route.id : 'root';
}

function canUploadHere() {
  if (state.route.type !== 'folder') return true;
  const f = state.folderCache.get(state.route.id);
  return f?.capabilities?.canAddChildren !== false;
}

// ------------------------------------------------------------
// パンくずリスト
// ------------------------------------------------------------
async function folderChain(id) {
  const chain = [];
  let cur = id;
  for (let i = 0; i < 25 && cur; i++) {
    if (cur === state.rootId) break;
    let f = state.folderCache.get(cur);
    if (!f) {
      try {
        f = await drive.getFile(cur, 'id,name,parents,capabilities(canAddChildren)');
        state.folderCache.set(cur, f);
      } catch {
        chain.unshift({ id: null, name: '…' });
        return { chain, reachedRoot: false };
      }
    }
    chain.unshift(f);
    cur = f.parents?.[0];
  }
  return { chain, reachedRoot: !!state.rootId && cur === state.rootId };
}

let crumbSeq = 0;
async function renderBreadcrumb() {
  const r = state.route;
  const crumb = (label, href) => href
    ? `<a href="${href}" class="crumb">${escapeHtml(label)}</a>`
    : `<span class="crumb current">${escapeHtml(label)}</span>`;
  const sep = '<span class="ms crumb-sep">chevron_right</span>';

  if (r.type === 'root') el.breadcrumb.innerHTML = crumb('マイドライブ');
  else if (r.type === 'shared') el.breadcrumb.innerHTML = crumb('共有アイテム');
  else if (r.type === 'recent') el.breadcrumb.innerHTML = crumb('最近のファイル');
  else if (r.type === 'search') el.breadcrumb.innerHTML = crumb(`「${r.query}」の検索結果`);
  else {
    el.breadcrumb.innerHTML = crumb('マイドライブ', '#/') + sep + '<span class="crumb current">…</span>';
    const seq = ++crumbSeq;
    const { chain, reachedRoot } = await folderChain(r.id);
    if (seq !== crumbSeq) return;
    const parts = [];
    if (reachedRoot || !chain.length || chain[0].id !== null) parts.push(crumb('マイドライブ', '#/'));
    chain.forEach((f, i) => {
      const last = i === chain.length - 1;
      parts.push(f.id && !last ? crumb(f.name, `#/folder/${encodeURIComponent(f.id)}`) : crumb(f.name));
    });
    el.breadcrumb.innerHTML = parts.join(sep);
  }
}

// ------------------------------------------------------------
// ファイル一覧
// ------------------------------------------------------------
function listParams() {
  const r = state.route;
  const sort = el.sort.value;
  const orderBy = sort === 'name' ? 'folder,name' : `folder,${sort}`;
  if (r.type === 'root') return { folderId: 'root', orderBy };
  if (r.type === 'folder') return { folderId: r.id, orderBy };
  if (r.type === 'shared') return { sharedWithMe: true, orderBy };
  if (r.type === 'search') return { search: r.query, orderBy };
  return { orderBy: sort === 'name' ? 'modifiedTime desc' : sort };
}

async function loadFiles({ append = false, silent = false } = {}) {
  const seq = append ? state.loadSeq : ++state.loadSeq;
  if (!append) {
    state.nextPageToken = null;
    if (!silent) {
      state.files = [];
      el.files.innerHTML = '';
      el.empty.hidden = true;
    }
  }
  state.loading = true;
  if (!silent) el.loading.hidden = false;
  try {
    const res = await drive.listFiles({ ...listParams(), pageToken: append ? state.nextPageToken : undefined });
    if (seq !== state.loadSeq) return;
    state.files = append ? state.files.concat(res.files) : res.files;
    state.nextPageToken = res.nextPageToken || null;
    res.files.filter(isFolder).forEach((f) => state.folderCache.set(f.id, { ...state.folderCache.get(f.id), ...f }));
    renderFiles();
  } catch (err) {
    if (seq !== state.loadSeq) return;
    handleError(err, 'ファイル一覧の取得');
  } finally {
    if (seq === state.loadSeq) {
      state.loading = false;
      el.loading.hidden = true;
    }
  }
}

function renderFiles() {
  const frag = document.createDocumentFragment();
  for (const f of state.files) frag.appendChild(fileElement(f));
  el.files.replaceChildren(frag);

  const empty = state.files.length === 0;
  el.empty.hidden = !empty;
  if (empty) {
    const r = state.route;
    el.emptyText.innerHTML = r.type === 'search'
      ? '一致するファイルはありません'
      : r.type === 'recent'
        ? 'アクセス可能なファイルはまだありません<br />アップロードするか「Drive から既存ファイルを追加」で選択してください'
        : 'ファイルをここにドロップ<br />または「新規」ボタンからアップロード';
  }
}

function fileElement(f) {
  const div = document.createElement('div');
  div.className = 'file';
  div.dataset.id = f.id;
  if (isFolder(f)) div.dataset.folder = '';
  div.tabIndex = 0;
  div.setAttribute('role', 'listitem');
  const thumb = f.thumbnailLink && !isFolder(f)
    ? `<img class="thumb-img" src="${escapeHtml(f.thumbnailLink)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`
    : '';
  div.innerHTML = `
    <div class="thumb">${thumb}${iconHtml(f, 'thumb-icon')}</div>
    <div class="col-name">
      ${iconHtml(f)}
      <span class="name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
      ${f.shared ? '<span class="ms shared-badge" title="共有中">group</span>' : ''}
    </div>
    <span class="col-date">${formatDate(f.modifiedTime)}</span>
    <span class="col-size">${isFolder(f) ? '—' : formatSize(f.size)}</span>
    <button class="icon-btn more-btn col-actions" aria-label="${escapeHtml(f.name)} のメニュー"><span class="ms">more_vert</span></button>
  `;
  const img = div.querySelector('.thumb-img');
  if (img) {
    img.addEventListener('load', () => div.classList.add('has-thumb'));
    img.addEventListener('error', () => img.remove());
  }
  return div;
}

const findFile = (id) => state.files.find((f) => f.id === id);

el.files.addEventListener('click', (e) => {
  const item = e.target.closest('.file');
  if (!item) return;
  const f = findFile(item.dataset.id);
  if (!f) return;
  if (e.target.closest('.more-btn')) {
    e.stopPropagation();
    const r = e.target.closest('.more-btn').getBoundingClientRect();
    openContextMenu(f, r.right, r.bottom, { alignRight: true });
    return;
  }
  openFile(f);
});

el.files.addEventListener('contextmenu', (e) => {
  const item = e.target.closest('.file');
  if (!item) return;
  e.preventDefault();
  openContextMenu(findFile(item.dataset.id), e.clientX, e.clientY);
});

el.files.addEventListener('keydown', (e) => {
  const item = e.target.closest('.file');
  if (!item) return;
  const f = findFile(item.dataset.id);
  if (e.key === 'Enter') openFile(f);
  else if (e.key === 'Delete') doTrash(f);
  else if (e.key === 'F2') doRename(f);
  else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault();
    const r = item.getBoundingClientRect();
    openContextMenu(f, r.left + 40, r.bottom);
  }
});

function openFile(f) {
  if (isFolder(f)) location.hash = `#/folder/${encodeURIComponent(f.id)}`;
  else openPreview(f);
}

// 無限スクロール
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && state.nextPageToken && !state.loading && hasValidToken()) {
    loadFiles({ append: true });
  }
}, { rootMargin: '300px' }).observe(el.sentinel);

// 並び替え・表示切替・更新
el.sort.value = localStorage.getItem('drivebox.sort') || 'name';
el.sort.addEventListener('change', () => {
  localStorage.setItem('drivebox.sort', el.sort.value);
  loadFiles();
});
$('#refresh-btn').addEventListener('click', () => loadFiles());

function applyView() {
  el.fileArea.classList.toggle('grid', state.view === 'grid');
  el.viewBtn.querySelector('.ms').textContent = state.view === 'grid' ? 'view_list' : 'grid_view';
  el.viewBtn.title = state.view === 'grid' ? 'リスト表示' : 'グリッド表示';
}
el.viewBtn.addEventListener('click', () => {
  state.view = state.view === 'grid' ? 'list' : 'grid';
  localStorage.setItem('drivebox.view', state.view);
  applyView();
});

// ------------------------------------------------------------
// メニュー
// ------------------------------------------------------------
function positionMenu(menu, x, y, { alignRight = false } = {}) {
  menu.hidden = false;
  const { width, height } = menu.getBoundingClientRect();
  if (alignRight) x -= width;
  const left = Math.max(8, Math.min(x, window.innerWidth - width - 8));
  const top = y + height > window.innerHeight - 8 ? Math.max(8, y - height) : y;
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
}

function closeAllMenus() {
  el.contextMenu.hidden = true;
  el.newDropdown.hidden = true;
  el.userDropdown.hidden = true;
}

function openContextMenu(f, x, y, opts) {
  closeAllMenus();
  state.menuFile = f;
  const folder = isFolder(f);
  const caps = f.capabilities || {};
  const show = {
    open: true,
    download: !folder && caps.canDownload !== false,
    rename: caps.canRename !== false,
    share: caps.canShare !== false,
    drive: !!f.webViewLink,
    trash: caps.canTrash !== false,
  };
  $$('[data-act]', el.contextMenu).forEach((b) => { b.hidden = !show[b.dataset.act]; });
  const openBtn = $('[data-act="open"]', el.contextMenu);
  openBtn.innerHTML = folder ? '<span class="ms">folder_open</span>開く' : '<span class="ms">visibility</span>プレビュー';
  positionMenu(el.contextMenu, x, y, opts);
  $('.dropdown-item:not([hidden])', el.contextMenu)?.focus({ preventScroll: true });
}

el.contextMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const f = state.menuFile;
  closeAllMenus();
  runAction(btn.dataset.act, f);
});

function runAction(act, f) {
  switch (act) {
    case 'open': return openFile(f);
    case 'download': return doDownload(f);
    case 'rename': return doRename(f);
    case 'share': return doShare(f);
    case 'drive': return window.open(f.webViewLink, '_blank', 'noopener');
    case 'trash': return doTrash(f);
    default: return undefined;
  }
}

// 新規メニュー
document.body.appendChild(el.newDropdown); // サイドバーの transform の影響を受けないよう body 直下へ
function openNewMenu(anchor, alignBottom = false) {
  const wasOpen = !el.newDropdown.hidden;
  closeAllMenus();
  if (wasOpen) return;
  const r = anchor.getBoundingClientRect();
  if (alignBottom) {
    el.newDropdown.hidden = false;
    const { width, height } = el.newDropdown.getBoundingClientRect();
    positionMenu(el.newDropdown, r.right - width, r.top - height - 8);
  } else {
    positionMenu(el.newDropdown, r.left, r.bottom + 4);
  }
}
$('#new-btn').addEventListener('click', (e) => { e.stopPropagation(); openNewMenu(e.currentTarget); });
$('#fab').addEventListener('click', (e) => { e.stopPropagation(); openNewMenu(e.currentTarget, true); });

el.newDropdown.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  closeAllMenus();
  closeDrawer();
  switch (btn.dataset.action) {
    case 'new-folder': return doNewFolder();
    case 'upload-file': return el.fileInput.click();
    case 'upload-folder': return el.folderInput.click();
    case 'pick': return doPick();
    default: return undefined;
  }
});

// ユーザーメニュー
$('#avatar-btn').addEventListener('click', (e) => {
  e.stopPropagation();
  const open = el.userDropdown.hidden;
  closeAllMenus();
  el.userDropdown.hidden = !open;
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.dropdown')) closeAllMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeAllMenus(); closeDrawer(); }
});
window.addEventListener('resize', closeAllMenus);
el.fileArea.addEventListener('scroll', closeAllMenus, { passive: true });

// モバイル用ドロワー
function closeDrawer() {
  el.sidebar.classList.remove('open');
  el.scrim.hidden = true;
}
$('#menu-btn').addEventListener('click', () => {
  el.sidebar.classList.add('open');
  el.scrim.hidden = false;
});
el.scrim.addEventListener('click', closeDrawer);

// ------------------------------------------------------------
// 検索
// ------------------------------------------------------------
$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const q = el.searchInput.value.trim();
  location.hash = q ? `#/search/${encodeURIComponent(q)}` : '#/';
  el.searchInput.blur();
});
el.searchInput.addEventListener('input', () => { el.searchClear.hidden = !el.searchInput.value; });
el.searchClear.addEventListener('click', () => {
  el.searchInput.value = '';
  el.searchClear.hidden = true;
  if (state.route.type === 'search') location.hash = '#/';
});

// ------------------------------------------------------------
// テーマ
// ------------------------------------------------------------
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function effectiveTheme() {
  return document.documentElement.dataset.theme || (darkQuery.matches ? 'dark' : 'light');
}
function updateThemeIcon() {
  $('#theme-btn .ms').textContent = effectiveTheme() === 'dark' ? 'light_mode' : 'dark_mode';
}
$('#theme-btn').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  updateThemeIcon();
});
darkQuery.addEventListener('change', updateThemeIcon);
updateThemeIcon();

// ------------------------------------------------------------
// アクション: フォルダ作成 / 名前変更 / 削除 / 共有 / Picker
// ------------------------------------------------------------
async function doNewFolder() {
  if (!canUploadHere()) return toast('このフォルダには追加できません', { type: 'error' });
  const name = await promptDialog({ title: '新しいフォルダ', value: '無題のフォルダ', okLabel: '作成' });
  if (!name) return;
  try {
    const f = await drive.createFolder(name, currentParentId());
    toast(`フォルダ「${f.name}」を作成しました`);
    loadFiles({ silent: true });
  } catch (err) { handleError(err, 'フォルダの作成'); }
}

async function doRename(f) {
  if (f.capabilities?.canRename === false) return;
  const name = await promptDialog({ title: '名前を変更', value: f.name, okLabel: '変更', selectUntilDot: !isFolder(f) });
  if (!name || name === f.name) return;
  try {
    const updated = await drive.renameFile(f.id, name);
    Object.assign(f, updated);
    state.folderCache.delete(f.id);
    renderFiles();
    if (state.previewFile?.id === f.id) $('#preview-name').textContent = f.name;
    toast('名前を変更しました');
  } catch (err) { handleError(err, '名前の変更'); }
}

async function doTrash(f) {
  if (f.capabilities?.canTrash === false) return;
  const ok = await confirmDialog({
    title: 'ゴミ箱に移動',
    text: `「${f.name}」をゴミ箱に移動しますか？（Google Drive のゴミ箱から 30 日以内なら復元できます）`,
    okLabel: 'ゴミ箱に移動',
    danger: true,
  });
  if (!ok) return;
  try {
    await drive.trashFile(f.id);
    state.files = state.files.filter((x) => x.id !== f.id);
    renderFiles();
    if (state.previewFile?.id === f.id) el.preview.close();
    toast(`「${f.name}」をゴミ箱に移動しました`);
  } catch (err) { handleError(err, '削除'); }
}

let shareFile = null;
async function doShare(f) {
  if (f.capabilities?.canShare === false) return toast('このファイルは共有できません', { type: 'error' });
  if (!f.shared) {
    const ok = await confirmDialog({
      title: '共有リンクを発行',
      text: `「${f.name}」を「リンクを知っている全員が閲覧可」に設定します。よろしいですか？`,
      okLabel: '発行する',
    });
    if (!ok) return;
  }
  try {
    const updated = await drive.shareAnyone(f.id);
    Object.assign(f, updated);
    renderFiles();
    shareFile = f;
    $('#share-input').value = f.webViewLink;
    $('#share-modal').showModal();
    $('#share-input').select();
  } catch (err) { handleError(err, '共有リンクの発行'); }
}

$('#share-copy').addEventListener('click', async () => {
  const input = $('#share-input');
  try {
    await navigator.clipboard.writeText(input.value);
  } catch {
    input.select();
    document.execCommand('copy');
  }
  toast('リンクをコピーしました');
});

$('#share-revoke').addEventListener('click', async () => {
  const f = shareFile;
  if (!f) return;
  try {
    await drive.unshareAnyone(f.id);
    const updated = await drive.getFile(f.id);
    Object.assign(f, updated);
    renderFiles();
    $('#share-modal').close();
    toast('リンクによる共有を解除しました');
  } catch (err) { handleError(err, '共有の解除'); }
});

async function doPick() {
  try {
    const picked = await pickFiles();
    if (!picked.length) return;
    const folders = picked.filter((x) => x.mimeType === FOLDER_MIME);
    if (folders.length) {
      addPinnedFolders(folders);
      toast(`フォルダ「${folders[0].name}」（傘下すべて）を追加しました`);
      location.hash = `#/folder/${encodeURIComponent(folders[0].id)}`;
      return;
    }
    toast(`${picked.length} 件を選択しました`);
    const file = await drive.getFile(picked[0].id);
    openPreview(file);
  } catch (err) { handleError(err, 'フォルダ・ファイルの選択'); }
}

// ------------------------------------------------------------
// ダウンロード
// ------------------------------------------------------------
const EXPORTS = {
  'application/vnd.google-apps.document': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'docx'],
  'application/vnd.google-apps.spreadsheet': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'xlsx'],
  'application/vnd.google-apps.presentation': ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'pptx'],
  'application/vnd.google-apps.drawing': ['image/png', 'png'],
};

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

async function doDownload(f) {
  toast(`「${f.name}」をダウンロードしています…`, { timeout: 2500 });
  try {
    if (isGoogleDoc(f)) {
      const [mime, ext] = EXPORTS[f.mimeType] || ['application/pdf', 'pdf'];
      const blob = await drive.exportBlob(f.id, mime);
      saveBlob(blob, `${f.name}.${ext}`);
    } else {
      const blob = await drive.downloadBlob(f.id);
      saveBlob(blob, f.name);
    }
  } catch (err) { handleError(err, 'ダウンロード'); }
}

// ------------------------------------------------------------
// プレビュー
// ------------------------------------------------------------
const PREVIEW_LIMIT = 100 * 1024 * 1024; // 100MB
const TEXT_LIMIT = 2 * 1024 * 1024; // 2MB

function previewKind(f) {
  const m = f.mimeType;
  if (m.startsWith('image/') && m !== 'image/heic' && m !== 'image/heif') return 'image';
  if (m === 'application/pdf') return 'pdf';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('text/') || /json|javascript|xml|x-sh|x-yaml|x-python/.test(m)) return 'text';
  if (isGoogleDoc(f) && !m.includes('form') && !m.includes('folder') && !m.includes('shortcut') && !m.includes('site') && !m.includes('map')) return 'gdoc';
  return null;
}

async function openPreview(f) {
  state.previewFile = f;
  $('#preview-name').textContent = f.name;
  $('#preview-icon').replaceWith(Object.assign(document.createElement('span'), {
    id: 'preview-icon', className: 'ms file-icon', textContent: fileIcon(f).name,
    style: `color:${fileIcon(f).color}`,
  }));
  $('#preview-download').hidden = f.capabilities?.canDownload === false;
  $('#preview-share').hidden = f.capabilities?.canShare === false;
  $('#preview-drive').hidden = !f.webViewLink;
  el.previewContent.innerHTML = '<div class="spinner"></div>';
  el.preview.showModal();

  const kind = previewKind(f);
  const size = Number(f.size || 0);
  const fallback = (msg) => {
    el.previewContent.innerHTML = `
      <div class="preview-fallback">
        ${iconHtml(f, 'big')}
        <p>${escapeHtml(msg)}</p>
        <div class="row">
          ${f.capabilities?.canDownload !== false ? '<button class="btn btn-primary" data-pv="download"><span class="ms">download</span>ダウンロード</button>' : ''}
          ${f.webViewLink ? '<button class="btn btn-outline" data-pv="drive"><span class="ms">open_in_new</span>Drive で開く</button>' : ''}
        </div>
      </div>`;
  };

  if (!kind) return fallback('このファイル形式はプレビューできません');
  if (kind !== 'gdoc' && size > PREVIEW_LIMIT) return fallback('ファイルが大きすぎるためプレビューできません');

  try {
    const blob = kind === 'gdoc'
      ? await drive.exportBlob(f.id, 'application/pdf')
      : await drive.downloadBlob(f.id);
    if (state.previewFile !== f || !el.preview.open) return;
    revokePreviewUrl();

    if (kind === 'text') {
      const text = size > TEXT_LIMIT ? (await blob.slice(0, TEXT_LIMIT).text()) + '\n…（以下省略）' : await blob.text();
      const pre = document.createElement('pre');
      pre.className = 'preview-text';
      pre.textContent = text;
      el.previewContent.replaceChildren(pre);
      return;
    }

    const typed = kind === 'gdoc' || kind === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob;
    state.previewUrl = URL.createObjectURL(typed);
    const url = state.previewUrl;
    if (kind === 'image') {
      el.previewContent.innerHTML = `<img class="preview-image" src="${url}" alt="${escapeHtml(f.name)}" />`;
    } else if (kind === 'video') {
      el.previewContent.innerHTML = `<video class="preview-media" src="${url}" controls autoplay playsinline></video>`;
    } else if (kind === 'audio') {
      el.previewContent.innerHTML = `<div class="preview-audio">${iconHtml(f, 'big')}<audio src="${url}" controls autoplay></audio></div>`;
    } else {
      el.previewContent.innerHTML = `
        <iframe class="preview-pdf" src="${url}" title="${escapeHtml(f.name)}"></iframe>
        <a class="btn btn-outline pdf-newtab" href="${url}" target="_blank" rel="noopener"><span class="ms">open_in_new</span>新しいタブで開く</a>`;
    }
  } catch (err) {
    if (err instanceof AuthError) return handleError(err);
    fallback(`プレビューを読み込めませんでした（${err.message}）`);
  }
}

function revokePreviewUrl() {
  if (state.previewUrl) URL.revokeObjectURL(state.previewUrl);
  state.previewUrl = null;
}

el.preview.addEventListener('close', () => {
  el.previewContent.innerHTML = '';
  revokePreviewUrl();
  state.previewFile = null;
});
el.previewContent.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pv]');
  if (b && state.previewFile) runAction(b.dataset.pv, state.previewFile);
});
$('#preview-download').addEventListener('click', () => state.previewFile && doDownload(state.previewFile));
$('#preview-share').addEventListener('click', () => state.previewFile && doShare(state.previewFile));
$('#preview-drive').addEventListener('click', () => state.previewFile && runAction('drive', state.previewFile));

// ------------------------------------------------------------
// アップロード
// ------------------------------------------------------------
const MAX_PARALLEL = 3;
const queue = [];
let active = 0;
let refreshTimer = null;
const uploadStats = { total: 0, done: 0, failed: 0 };

/**
 * @param {Array<{file: File, relPath?: string}>} items relPath はフォルダアップロード時の相対パス（例: "dir/sub/a.txt"）
 */
async function enqueueUploads(items, parentId = currentParentId()) {
  if (!items.length) return;
  if (!canUploadHere()) return toast('このフォルダにはアップロードできません', { type: 'error' });

  // フォルダ構造を作成
  const folderIds = new Map([['', parentId]]);
  const ensureFolder = async (path) => {
    if (folderIds.has(path)) return folderIds.get(path);
    const idx = path.lastIndexOf('/');
    const parentPath = idx === -1 ? '' : path.slice(0, idx);
    const name = idx === -1 ? path : path.slice(idx + 1);
    const promise = ensureFolder(parentPath).then((pid) => drive.createFolder(name, pid)).then((f) => f.id);
    folderIds.set(path, promise);
    return promise;
  };

  el.uploads.hidden = false;
  el.uploads.classList.remove('collapsed');
  for (const { file, relPath } of items) {
    const dir = relPath && relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';
    const li = document.createElement('li');
    li.className = 'upload-item';
    li.innerHTML = `
      ${iconHtml({ mimeType: file.type || '' })}
      <div class="upload-info">
        <span class="upload-name" title="${escapeHtml(relPath || file.name)}">${escapeHtml(file.name)}</span>
        <div class="progress"><div class="progress-bar"></div></div>
      </div>
      <span class="upload-status">待機中</span>
      <button class="icon-btn upload-cancel" aria-label="キャンセル"><span class="ms">close</span></button>`;
    el.uploadsList.prepend(li);
    const job = { file, dir, li, ensureFolder, cancelled: false, abort: null };
    li.querySelector('.upload-cancel').onclick = () => {
      job.cancelled = true;
      job.abort?.();
      setUploadStatus(job, 'キャンセル', 'cancelled');
    };
    queue.push(job);
    uploadStats.total++;
  }
  updateUploadsTitle();
  pumpQueue();
}

function setUploadStatus(job, text, cls) {
  job.li.querySelector('.upload-status').textContent = text;
  if (cls) job.li.classList.add(cls);
}

function updateUploadsTitle() {
  const { total, done, failed } = uploadStats;
  const remaining = total - done - failed;
  el.uploadsTitle.textContent = remaining > 0
    ? `${remaining} 件をアップロード中`
    : `${done} 件のアップロード完了${failed ? `（${failed} 件失敗）` : ''}`;
}

function pumpQueue() {
  while (active < MAX_PARALLEL && queue.length) {
    const job = queue.shift();
    if (job.cancelled) { uploadStats.failed++; updateUploadsTitle(); continue; }
    active++;
    runUpload(job).finally(() => {
      active--;
      updateUploadsTitle();
      pumpQueue();
    });
  }
}

async function runUpload(job) {
  const bar = job.li.querySelector('.progress-bar');
  try {
    setUploadStatus(job, '0%');
    const parentId = await job.ensureFolder(job.dir);
    if (job.cancelled) throw new DOMException('Aborted', 'AbortError');
    const { promise, abort } = drive.uploadFile(job.file, parentId, (p) => {
      bar.style.width = `${Math.round(p * 100)}%`;
      setUploadStatus(job, `${Math.round(p * 100)}%`);
    });
    job.abort = abort;
    await promise;
    bar.style.width = '100%';
    setUploadStatus(job, '完了', 'done');
    job.li.querySelector('.upload-cancel').remove();
    uploadStats.done++;
    scheduleRefresh();
  } catch (err) {
    uploadStats.failed++;
    if (err?.name === 'AbortError') {
      setUploadStatus(job, 'キャンセル', 'cancelled');
    } else {
      setUploadStatus(job, '失敗', 'failed');
      job.li.title = err.message;
      handleError(err, `「${job.file.name}」のアップロード`);
    }
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => loadFiles({ silent: true }), 600);
}

$('#uploads-toggle').addEventListener('click', () => {
  el.uploads.classList.toggle('collapsed');
});
$('#uploads-close').addEventListener('click', () => {
  if (active || queue.length) {
    el.uploads.classList.add('collapsed');
    return;
  }
  el.uploads.hidden = true;
  el.uploadsList.innerHTML = '';
  Object.assign(uploadStats, { total: 0, done: 0, failed: 0 });
});

el.fileInput.addEventListener('change', () => {
  enqueueUploads([...el.fileInput.files].map((file) => ({ file })));
  el.fileInput.value = '';
});
el.folderInput.addEventListener('change', () => {
  enqueueUploads([...el.folderInput.files].map((file) => ({ file, relPath: file.webkitRelativePath })));
  el.folderInput.value = '';
});

// ドラッグ＆ドロップ
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const mainEl = $('#main');

mainEl.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  const where = state.route.type === 'folder'
    ? (state.folderCache.get(state.route.id)?.name || 'このフォルダ')
    : 'マイドライブ';
  el.dropText.textContent = `「${where}」にアップロード`;
  el.dropOverlay.hidden = false;
});
mainEl.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
mainEl.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) el.dropOverlay.hidden = true;
});
mainEl.addEventListener('drop', async (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  el.dropOverlay.hidden = true;
  // webkitGetAsEntry は drop イベント中に同期的に呼ぶ必要がある
  const entries = [...e.dataTransfer.items]
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry?.())
    .filter(Boolean);
  try {
    const items = entries.length
      ? (await Promise.all(entries.map((en) => readEntry(en, '')))).flat()
      : [...e.dataTransfer.files].map((file) => ({ file }));
    enqueueUploads(items);
  } catch (err) { handleError(err, 'ファイルの読み込み'); }
});
// ページ外へのドロップでファイルが開かれてしまうのを防止
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

async function readEntry(entry, path) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ file, relPath: path ? `${path}/${file.name}` : '' }];
  }
  if (entry.isDirectory) {
    const dirPath = path ? `${path}/${entry.name}` : entry.name;
    const reader = entry.createReader();
    const children = [];
    let batch;
    do {
      batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      children.push(...batch);
    } while (batch.length);
    const nested = await Promise.all(children.map((c) => readEntry(c, dirPath)));
    return nested.flat();
  }
  return [];
}

// ------------------------------------------------------------
// 起動
// ------------------------------------------------------------
(async function boot() {
  pendingPairCode = extractPairCodeFromHash();
  if (!isConfigured()) {
    showLogin('');
    el.loginMsg.innerHTML = '⚙️ セットアップが必要です。<code>js/config.js</code> に Google Cloud の設定値を入力してください（手順は <code>docs/SETUP.md</code>）。';
    return;
  }
  try {
    await initAuth();
    el.loginBtn.disabled = false;
  } catch (err) {
    // 共有PC等で accounts.google.com がブロックされていても、遠隔ログインは利用可能にする
    if (hasValidToken()) {
      startApp();
      return;
    }
    showLogin(err.message);
    return;
  }
  if (hasValidToken()) startApp();
  else showLogin(!pendingPairCode && localStorage.getItem('drivebox.signedIn') ? 'もう一度ログインしてください' : '');
})();
