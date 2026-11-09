/**
 * Google Picker
 * drive.file スコープでは、ユーザーが Picker で選んだファイルにだけアクセスできるようになります。
 */
import { CONFIG } from './config.js';
import { loadScript, getToken } from './auth.js';

let loaded = null;

function loadPicker() {
  if (!loaded) {
    loaded = loadScript('https://apis.google.com/js/api.js')
      .then(() => new Promise((resolve) => gapi.load('picker', resolve)));
  }
  return loaded;
}

/** @returns {Promise<Array<{id: string, name: string, mimeType: string}>>} 選択されたファイル（キャンセル時は空配列） */
export async function pickFiles() {
  await loadPicker();
  const token = getToken();
  return new Promise((resolve) => {
    const docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true)
      .setMode(google.picker.DocsViewMode.LIST);
    const sharedView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setOwnedByMe(false)
      .setIncludeFolders(true)
      .setSelectFolderEnabled(true);

    const picker = new google.picker.PickerBuilder()
      .setTitle('アプリで使うファイルを選択')
      .addView(docsView)
      .addView(sharedView)
      .addView(new google.picker.DocsView(google.picker.ViewId.RECENTLY_PICKED))
      .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
      .enableFeature(google.picker.Feature.SUPPORT_DRIVES)
      .setOAuthToken(token)
      .setDeveloperKey(CONFIG.API_KEY)
      .setAppId(CONFIG.APP_ID)
      .setLocale('ja')
      .setOrigin(window.location.protocol + '//' + window.location.host)
      .setCallback((data) => {
        const action = data[google.picker.Response.ACTION];
        if (action === google.picker.Action.PICKED) {
          resolve(data[google.picker.Response.DOCUMENTS].map((d) => ({
            id: d[google.picker.Document.ID],
            name: d[google.picker.Document.NAME],
            mimeType: d[google.picker.Document.MIME_TYPE],
          })));
        } else if (action === google.picker.Action.CANCEL) {
          resolve([]);
        }
      })
      .build();
    picker.setVisible(true);
  });
}
