/**
 * 内蔵フォルダ・ファイル選択ダイアログ（API キー不要）
 *
 * Google Picker の外部ウィジェット（API キー必須で「API デベロッパー キーが無効です」が
 * 出やすい）を使わず、OAuth トークンだけで Drive のフォルダやファイルを直接選択できます。
 * フォルダを選択すると、その傘下のサブフォルダ・ファイルすべてにアクセスできます。
 */
import * as drive from './drive.js';
import { FOLDER_MIME } from './drive.js';

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

let dialogEl = null;

function ensureDialog() {
  if (dialogEl) return dialogEl;
  dialogEl = document.createElement('dialog');
  dialogEl.className = 'modal modal-wide picker-modal';
  dialogEl.innerHTML = `
    <div class="modal-body picker-body">
      <div class="picker-head">
        <h2>フォルダ・ファイルを選択</h2>
        <p class="muted">フォルダを選択すると、その傘下のすべてのファイル・サブフォルダにアクセスできます。</p>
      </div>
      <div class="picker-tabs">
        <button type="button" class="picker-tab active" data-tab="my">マイドライブ</button>
        <button type="button" class="picker-tab" data-tab="shared">共有アイテム</button>
        <input type="search" class="text-input picker-search" placeholder="名前で検索…" />
      </div>
      <div class="picker-nav" id="picker-nav"></div>
      <div class="picker-list" id="picker-list"></div>
      <div class="modal-actions picker-actions">
        <button type="button" class="btn btn-outline" id="picker-select-current">
          <span class="ms">folder_check</span>今開いているフォルダを選択
        </button>
        <div style="flex:1"></div>
        <button type="button" class="btn btn-text" id="picker-cancel">キャンセル</button>
        <button type="button" class="btn btn-primary" id="picker-ok" disabled>選択した項目を追加</button>
      </div>
    </div>
  `;
  document.body.appendChild(dialogEl);
  dialogEl.addEventListener('click', (e) => {
    if (e.target === dialogEl) dialogEl.close('cancel');
  });
  return dialogEl;
}

/**
 * @returns {Promise<Array<{id: string, name: string, mimeType: string}>>}
 */
export function pickFiles() {
  const dlg = ensureDialog();
  const listEl = dlg.querySelector('#picker-list');
  const navEl = dlg.querySelector('#picker-nav');
  const okBtn = dlg.querySelector('#picker-ok');
  const selectCurBtn = dlg.querySelector('#picker-select-current');
  const searchInput = dlg.querySelector('.picker-search');
  const tabs = [...dlg.querySelectorAll('.picker-tab')];

  let tab = 'my'; // 'my' | 'shared'
  let stack = [{ id: 'root', name: 'マイドライブ' }];
  let items = [];
  let selected = new Map(); // id -> item
  let result = [];

  function updateButtons() {
    okBtn.disabled = selected.size === 0;
    okBtn.textContent = selected.size > 0 ? `選択した項目を追加 (${selected.size})` : '選択した項目を追加';
    const cur = stack[stack.length - 1];
    selectCurBtn.hidden = !(tab === 'my' || stack.length > 1) || !!searchInput.value.trim();
    selectCurBtn.innerHTML = `<span class="ms">folder</span>「${escapeHtml(cur.name)}」傘下すべてを選択`;
  }

  function renderNav() {
    if (searchInput.value.trim()) {
      navEl.innerHTML = `<span class="muted">「${escapeHtml(searchInput.value.trim())}」の検索結果</span>`;
      return;
    }
    navEl.innerHTML = stack.map((f, i) => (
      i === stack.length - 1
        ? `<strong>${escapeHtml(f.name)}</strong>`
        : `<button type="button" class="picker-crumb" data-idx="${i}">${escapeHtml(f.name)}</button> / `
    )).join('');
  }

  async function load() {
    renderNav();
    updateButtons();
    listEl.innerHTML = '<div class="loading"><div class="spinner"></div></div>';
    try {
      const q = searchInput.value.trim();
      const cur = stack[stack.length - 1];
      let res;
      if (q) {
        res = await drive.listFiles({ search: q, orderBy: 'folder,name' });
      } else if (tab === 'shared' && stack.length === 1) {
        res = await drive.listFiles({ sharedWithMe: true, orderBy: 'folder,name' });
      } else {
        res = await drive.listFiles({ folderId: cur.id, orderBy: 'folder,name' });
      }
      items = res.files || [];
      renderList();
    } catch (err) {
      listEl.innerHTML = `<p class="danger" style="padding:16px">${escapeHtml(err.message)}</p>`;
    }
  }

  function renderList() {
    if (!items.length) {
      listEl.innerHTML = '<p class="muted" style="text-align:center;padding:32px">フォルダやファイルがありません</p>';
      return;
    }
    listEl.innerHTML = items.map((f) => {
      const isFolder = f.mimeType === FOLDER_MIME;
      const checked = selected.has(f.id) ? 'checked' : '';
      return `
        <div class="picker-row ${checked ? 'selected' : ''}" data-id="${escapeHtml(f.id)}">
          <input type="checkbox" class="picker-check" data-id="${escapeHtml(f.id)}" ${checked} />
          <span class="ms file-icon" style="color:${isFolder ? 'var(--icon-folder)' : '#4285f4'}">${isFolder ? 'folder' : 'draft'}</span>
          <span class="picker-name">${escapeHtml(f.name)}</span>
          ${isFolder ? '<button type="button" class="btn btn-text btn-sm picker-open">中身を見る →</button>' : ''}
        </div>
      `;
    }).join('');
  }

  return new Promise((resolve) => {
    const onTabClick = (e) => {
      const btn = e.target.closest('.picker-tab');
      if (!btn) return;
      tab = btn.dataset.tab;
      tabs.forEach((t) => t.classList.toggle('active', t === btn));
      searchInput.value = '';
      stack = [tab === 'my' ? { id: 'root', name: 'マイドライブ' } : { id: 'shared', name: '共有アイテム' }];
      load();
    };

    const onNavClick = (e) => {
      const btn = e.target.closest('.picker-crumb');
      if (!btn) return;
      stack = stack.slice(0, Number(btn.dataset.idx) + 1);
      load();
    };

    const onListClick = (e) => {
      const row = e.target.closest('.picker-row');
      if (!row) return;
      const item = items.find((x) => x.id === row.dataset.id);
      if (!item) return;

      if (e.target.closest('.picker-open')) {
        stack.push({ id: item.id, name: item.name });
        searchInput.value = '';
        load();
        return;
      }

      if (selected.has(item.id)) selected.delete(item.id);
      else selected.set(item.id, { id: item.id, name: item.name, mimeType: item.mimeType });
      renderList();
      updateButtons();
    };

    const onListDblClick = (e) => {
      const row = e.target.closest('.picker-row');
      if (!row) return;
      const item = items.find((x) => x.id === row.dataset.id);
      if (item && item.mimeType === FOLDER_MIME) {
        stack.push({ id: item.id, name: item.name });
        searchInput.value = '';
        load();
      }
    };

    let searchTimer = null;
    const onSearchInput = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(load, 250);
    };

    const onSelectCurrent = () => {
      const cur = stack[stack.length - 1];
      result = [{ id: cur.id, name: cur.name, mimeType: FOLDER_MIME }];
      dlg.close('ok');
    };

    const onOk = () => {
      result = [...selected.values()];
      dlg.close('ok');
    };

    const onCancel = () => dlg.close('cancel');

    const cleanup = () => {
      dlg.querySelector('.picker-tabs').removeEventListener('click', onTabClick);
      navEl.removeEventListener('click', onNavClick);
      listEl.removeEventListener('click', onListClick);
      listEl.removeEventListener('dblclick', onListDblClick);
      searchInput.removeEventListener('input', onSearchInput);
      selectCurBtn.removeEventListener('click', onSelectCurrent);
      okBtn.removeEventListener('click', onOk);
      dlg.querySelector('#picker-cancel').removeEventListener('click', onCancel);
      dlg.removeEventListener('close', onClose);
    };

    const onClose = () => {
      cleanup();
      resolve(dlg.returnValue === 'ok' ? result : []);
    };

    dlg.querySelector('.picker-tabs').addEventListener('click', onTabClick);
    navEl.addEventListener('click', onNavClick);
    listEl.addEventListener('click', onListClick);
    listEl.addEventListener('dblclick', onListDblClick);
    searchInput.addEventListener('input', onSearchInput);
    selectCurBtn.addEventListener('click', onSelectCurrent);
    okBtn.addEventListener('click', onOk);
    dlg.querySelector('#picker-cancel').addEventListener('click', onCancel);
    dlg.addEventListener('close', onClose);

    dlg.returnValue = '';
    searchInput.value = '';
    tabs.forEach((t) => t.classList.toggle('active', t.dataset.tab === 'my'));
    dlg.showModal();
    load();
  });
}
