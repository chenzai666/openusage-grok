const { contextBridge, ipcRenderer } = require("electron");

function invoke(channel, ...args) {
  return ipcRenderer.invoke(channel, ...args);
}

function on(channel, handler) {
  const wrapped = (_e, ...payload) => handler(...payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
}

contextBridge.exposeInMainWorld("openusage", {
  getStatus: () => invoke("get-status"),
  getSettings: () => invoke("get-settings"),
  updateSettings: (partial) => invoke("update-settings", partial),
  listAccounts: () => invoke("list-accounts"),
  setActiveAccount: (entryKey) => invoke("set-active-account", entryKey),
  removeAccount: (entryKey) => invoke("remove-account", entryKey),
  setAccountLabels: (entryKey, labels) => invoke("set-account-labels", entryKey, labels),
  setAccountSubscription: (entryKey, fields) =>
    invoke("set-account-subscription", entryKey, fields),
  reorderAccounts: (orderedKeys) => invoke("reorder-accounts", orderedKeys),
  testAccountApi: (entryKey) => invoke("test-account-api", entryKey),
  testAllApis: () => invoke("test-all-apis"),
  startBrowserLogin: (opts) => invoke("start-browser-login", opts || {}),
  cancelLogin: () => invoke("cancel-login"),
  pollLogin: () => invoke("poll-login"),
  logout: (entryKey) => invoke("logout", entryKey),
  logoutAll: () => invoke("logout-all"),
  refreshUsage: (opts) => invoke("refresh-usage", opts || {}),
  softImportCli: (opts) => invoke("soft-import-cli", opts || {}),
  cliproxyDiscover: () => invoke("cliproxy-discover"),
  cliproxyScanDefault: () => invoke("cliproxy-scan-default"),
  cliproxyImportText: (text) => invoke("cliproxy-import-text", text),
  cliproxyPickImport: () => invoke("cliproxy-pick-import"),
  cliproxyPickFolder: () => invoke("cliproxy-pick-folder"),
  openPath: (which) => invoke("open-path", which),
  openExternal: (url) => invoke("open-external", url),
  hidePanel: () => invoke("hide-panel"),
  quitApp: () => invoke("quit-app"),
  getFullscreen: () => invoke("get-fullscreen"),
  setFullscreen: (on) => invoke("set-fullscreen", on),
  toggleFullscreen: () => invoke("toggle-fullscreen"),
  copyText: (text) => invoke("copy-text", text),
  parseRenewal: (text) => invoke("parse-renewal", text),
  getProxyStatus: () => invoke("get-proxy-status"),
  testProxy: () => invoke("test-proxy"),
  applyProxy: () => invoke("apply-proxy"),

  onUsageResult: (cb) => on("usage-result", cb),
  onLoginState: (cb) => on("login-state", cb),
  onThemeChanged: (cb) => on("theme-changed", cb),
  onAccountsChanged: (cb) => on("accounts-changed", cb),
  onFullscreenChanged: (cb) => on("fullscreen-changed", cb),
  onPanelShown: (cb) => on("panel-shown", cb),
  onNavigate: (cb) => on("navigate", cb),
});
