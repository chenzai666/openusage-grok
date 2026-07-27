const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  clipboard,
  nativeTheme,
  screen,
  session,
} = require("electron");
const path = require("path");
const fs = require("fs");
const { applySessionProxy, resolveProxy, testProxyConnectivity } = require("../lib/http");

const settings = require("../lib/settings");
const secure = require("../lib/secureAccounts");
const grokAuth = require("../lib/grokAuth");
const grokBilling = require("../lib/grokBilling");
const grokApiTest = require("../lib/grokApiTest");
const { createTrayNativeImage } = require("../lib/trayIcon");
const { appDataRoot, accountsPath, configPath, cliAuthPath, debugDir } = require("../lib/paths");

const ALLOWED_EXTERNAL = [
  /^https:\/\/auth\.x\.ai(\/|$)/i,
  /^https:\/\/([a-z0-9-]+\.)?x\.ai(\/|$)/i,
  /^https:\/\/([a-z0-9-]+\.)?grok\.com(\/|$)/i,
  /^https:\/\/x\.com(\/|$)/i,
  /^https:\/\/twitter\.com(\/|$)/i,
];

let tray = null;
let panel = null;
let isQuitting = false;
let isFullscreen = false;
let refreshTimer = null;
let loginPollTimer = null;
let lastUsage = null;
let compactBounds = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    showPanel();
  });
}

function applyTheme() {
  const cfg = settings.load();
  let theme = cfg.theme || "dark";
  // 历史配置 system+浅色系统 会导致白底白字；首次拉起纠正为 dark
  if (theme === "system" && !nativeTheme.shouldUseDarkColors) {
    theme = "dark";
    settings.save({ theme: "dark" });
  }
  if (theme === "dark") nativeTheme.themeSource = "dark";
  else if (theme === "light") nativeTheme.themeSource = "light";
  else nativeTheme.themeSource = "system";
  if (panel && !panel.isDestroyed()) {
    panel.webContents.send("theme-changed", {
      theme,
      // 卡片始终按深色可读渲染；外壳可随主题
      shouldUseDarkColors: theme === "light" ? false : true,
    });
  }
}

function createPanel() {
  const cfg = settings.load();
  const w = Math.max(360, Math.min(900, cfg.panelWidth || 420));
  const h = Math.max(480, Math.min(1200, cfg.panelHeight || 640));

  panel = new BrowserWindow({
    width: w,
    height: h,
    minWidth: 360,
    minHeight: 420,
    maxWidth: 1400,
    maxHeight: 1200,
    show: false,
    frame: false,
    resizable: true,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: false,
    backgroundColor: "#0a0a0a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  panel.loadFile(path.join(__dirname, "..", "src", "index.html"));

  panel.on("blur", () => {
    if (isFullscreen || isQuitting) return;
    // small delay so clicks on tray still work
    setTimeout(() => {
      if (!panel || panel.isDestroyed() || isFullscreen) return;
      if (!panel.isFocused()) panel.hide();
    }, 150);
  });

  panel.on("resized", () => {
    if (isFullscreen || !panel || panel.isDestroyed()) return;
    const b = panel.getBounds();
    settings.save({ panelWidth: b.width, panelHeight: b.height });
  });

  panel.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      panel.hide();
    }
  });
}

function positionNearTray() {
  if (!panel || panel.isDestroyed()) return;
  const display = screen.getPrimaryDisplay();
  const wa = display.workArea;
  const b = panel.getBounds();
  // bottom-right near typical Windows tray
  const x = Math.round(wa.x + wa.width - b.width - 12);
  const y = Math.round(wa.y + wa.height - b.height - 8);
  panel.setPosition(Math.max(wa.x, x), Math.max(wa.y, y));
}

function showPanel() {
  if (!panel || panel.isDestroyed()) createPanel();
  if (!isFullscreen) positionNearTray();
  panel.show();
  panel.focus();
  panel.webContents.send("panel-shown");
}

function hidePanel() {
  if (panel && !panel.isDestroyed()) panel.hide();
}

function setFullscreenMode(on) {
  if (!panel || panel.isDestroyed()) return;
  isFullscreen = !!on;
  if (isFullscreen) {
    compactBounds = panel.getBounds();
    const display = screen.getDisplayMatching(compactBounds) || screen.getPrimaryDisplay();
    const wa = display.workArea;
    panel.setAlwaysOnTop(false);
    panel.setSkipTaskbar(false);
    panel.setBounds({ x: wa.x, y: wa.y, width: wa.width, height: wa.height });
    panel.show();
    panel.focus();
  } else {
    panel.setAlwaysOnTop(true);
    panel.setSkipTaskbar(true);
    if (compactBounds) {
      panel.setBounds(compactBounds);
    } else {
      const cfg = settings.load();
      panel.setSize(cfg.panelWidth || 420, cfg.panelHeight || 640);
      positionNearTray();
    }
  }
  panel.webContents.send("fullscreen-changed", isFullscreen);
}

function updateTrayIcon(percent) {
  if (!tray) return;
  const cfg = settings.load();
  const show = cfg.trayShowPercent !== false;
  const p = show && percent != null && Number.isFinite(percent) ? Math.round(percent) : null;
  try {
    const img = createTrayNativeImage(nativeImage, p != null ? p : 0, { size: 32 });
    tray.setImage(img);
    tray.setToolTip(
      p != null ? `OpenUsage Grok · 周限已用 ${p}%` : "OpenUsage Grok"
    );
  } catch (e) {
    console.error("tray icon", e);
  }
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: "显示详情",
      click: () => {
        if (isFullscreen) setFullscreenMode(false);
        showPanel();
        panel?.webContents.send("navigate", "home");
      },
    },
    {
      label: isFullscreen ? "退出全屏工作台" : "全屏工作台",
      click: () => {
        setFullscreenMode(!isFullscreen);
        showPanel();
      },
    },
    {
      label: "设置",
      click: () => {
        showPanel();
        panel?.webContents.send("navigate", "settings");
      },
    },
    { type: "separator" },
    {
      label: "刷新用量",
      click: () => {
        refreshAll().catch(console.error);
      },
    },
    { type: "separator" },
    {
      label: "退出",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function createTray() {
  const img = createTrayNativeImage(nativeImage, 0, { size: 32 });
  tray = new Tray(img);
  tray.setToolTip("OpenUsage Grok");
  tray.setContextMenu(buildTrayMenu());
  tray.on("click", () => {
    if (!panel || panel.isDestroyed()) {
      showPanel();
      return;
    }
    if (panel.isVisible() && !isFullscreen) hidePanel();
    else showPanel();
  });
  tray.on("right-click", () => {
    tray.setContextMenu(buildTrayMenu());
    tray.popUpContextMenu();
  });
}

async function refreshAll(opts = {}) {
  try {
    // Merge CLI tokens only — never drops vault-only (device-login) accounts
    if (opts.skipCliSync !== true) {
      try {
        secure.syncFromCli(true);
      } catch (e) {
        console.error("cli-sync on refresh", e);
      }
    }
    const result = await grokBilling.fetchAllUsage({ runChat: !!opts.runChat });
    lastUsage = result;
    updateTrayIcon(result.trayPercent);
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send("usage-result", result);
    }
    return result;
  } catch (e) {
    console.error("refreshAll", e);
    const errPayload = {
      v: 1,
      accounts: [],
      error: String(e.message || e),
      refreshedAt: new Date().toISOString(),
    };
    if (panel && !panel.isDestroyed()) {
      panel.webContents.send("usage-result", errPayload);
    }
    throw e;
  }
}

function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const cfg = settings.load();
  const mins = Math.max(1, Number(cfg.refreshMinutes) || 5);
  refreshTimer = setInterval(() => {
    refreshAll().catch(console.error);
  }, mins * 60 * 1000);
}

function startLoginPoll() {
  if (loginPollTimer) clearInterval(loginPollTimer);
  loginPollTimer = setInterval(async () => {
    try {
      const st = await grokAuth.pollDeviceLogin();
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send("login-state", st);
      }
      if (st.state === "complete") {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
        // Keep other accounts; mark newly logged-in as tray/active
        if (st.entryKey) {
          settings.save({ activeEntryKey: st.entryKey });
        }
        panel?.webContents.send("accounts-changed");
        await refreshAll({ skipCliSync: false });
      } else if (st.state === "expired" || st.state === "cancelled") {
        clearInterval(loginPollTimer);
        loginPollTimer = null;
      }
    } catch (e) {
      if (panel && !panel.isDestroyed()) {
        panel.webContents.send("login-state", {
          state: "error",
          message: String(e.message || e),
        });
      }
    }
  }, 2000);
}

function registerIpc() {
  ipcMain.handle("get-status", async () => {
    const cfg = settings.load();
    const accounts = secure.listEntries();
    return {
      version: app.getVersion(),
      encrypted: secure.canEncrypt(),
      accountCount: accounts.length,
      activeEntryKey: cfg.activeEntryKey,
      lastUsage,
      paths: {
        appData: appDataRoot(),
        accounts: accountsPath(),
        config: configPath(),
        cliAuth: cliAuthPath(),
        debug: debugDir(),
      },
      isFullscreen,
      dark: nativeTheme.shouldUseDarkColors,
      proxy: resolveProxy(),
      cliAuth: secure.cliAuthStatus(),
    };
  });

  ipcMain.handle("get-settings", async () => settings.load());
  ipcMain.handle("update-settings", async (_e, partial) => {
    const next = settings.save(partial || {});
    applyTheme();
    if (partial && ("refreshMinutes" in partial || "launchAtLogin" in partial)) {
      scheduleRefresh();
    }
    if (partial && "launchAtLogin" in partial) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!partial.launchAtLogin });
      } catch {
        /* ignore */
      }
    }
    if (partial && "trayShowPercent" in partial) {
      updateTrayIcon(lastUsage?.trayPercent ?? 0);
    }
    if (
      partial &&
      ("proxyMode" in partial || "proxyUrl" in partial || "proxyBypass" in partial)
    ) {
      await applySessionProxy(session.defaultSession);
    }
    return next;
  });

  ipcMain.handle("get-proxy-status", async () => resolveProxy());
  ipcMain.handle("test-proxy", async () => {
    await applySessionProxy(session.defaultSession);
    return testProxyConnectivity();
  });
  ipcMain.handle("apply-proxy", async () => applySessionProxy(session.defaultSession));

  ipcMain.handle("list-accounts", async () => {
    const data = secure.loadAccounts();
    const cfg = settings.load();
    return Object.entries(data.accounts || {}).map(([entryKey, entry]) => ({
      entryKey,
      email: entry.email || entry.user_email || null,
      emailMasked: secure.maskEmail(entry.email || entry.user_email || ""),
      labels: entry.labels || [],
      subscription_renews_at: entry.subscription_renews_at || null,
      subscription_payment_method: entry.subscription_payment_method || null,
      subscription_paste: entry.subscription_paste || null,
      subscription: grokBilling.formatSubscriptionLine(entry),
      tier: entry.tier ?? null,
      plan_name: entry.plan_name || null,
      planLine:
        entry.tier != null
          ? `tier ${entry.tier}${entry.plan_name ? " · " + entry.plan_name : ""}`
          : entry.plan_name || null,
      enabled: cfg.activeEntryKey === entryKey,
      source: entry.source || null,
    }));
  });

  ipcMain.handle("set-active-account", async (_e, entryKey) => {
    settings.save({ activeEntryKey: entryKey || null });
    if (lastUsage && Array.isArray(lastUsage.accounts)) {
      lastUsage.accounts.forEach((a) => {
        a.enabled = a.entryKey === entryKey;
      });
      lastUsage.trayEntryKey = entryKey;
      const t = lastUsage.accounts.find((a) => a.entryKey === entryKey);
      lastUsage.trayPercent = t?.weeklyPercent ?? null;
      updateTrayIcon(lastUsage.trayPercent);
      panel?.webContents.send("usage-result", lastUsage);
    }
    panel?.webContents.send("accounts-changed");
    return true;
  });

  ipcMain.handle("remove-account", async (_e, entryKey) => {
    // Tombstone so CLI soft-sync won't re-add; do not run syncFromCli right after
    const ok = secure.removeEntry(entryKey);
    const cfg = settings.load();
    if (cfg.activeEntryKey === entryKey) {
      const left = secure.listEntries();
      settings.save({ activeEntryKey: left[0]?.entryKey || null });
    }
    // Drop deleted card from lastUsage immediately
    if (lastUsage && Array.isArray(lastUsage.accounts)) {
      lastUsage.accounts = lastUsage.accounts.filter((a) => a.entryKey !== entryKey);
      lastUsage.trayEntryKey = settings.load().activeEntryKey;
      const tray = lastUsage.accounts.find((a) => a.entryKey === lastUsage.trayEntryKey);
      lastUsage.trayPercent = tray?.weeklyPercent ?? null;
      updateTrayIcon(lastUsage.trayPercent);
      panel?.webContents.send("usage-result", lastUsage);
    }
    panel?.webContents.send("accounts-changed");
    // Refresh remaining only — skip full CLI re-import wipe path
    try {
      const result = await grokBilling.fetchAllUsage({ runChat: false });
      lastUsage = result;
      updateTrayIcon(result.trayPercent);
      panel?.webContents.send("usage-result", result);
    } catch (e) {
      console.error("refresh after remove", e);
    }
    return ok;
  });

  ipcMain.handle("set-account-labels", async (_e, entryKey, labels) => {
    const list = Array.isArray(labels)
      ? labels
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .slice(0, 8)
          .map((x) => x.slice(0, 32))
      : [];
    const data = secure.loadAccounts();
    const entry = data.accounts[entryKey];
    if (!entry) throw new Error("账号不存在");
    secure.upsertEntry(entryKey, { ...entry, labels: list });
    panel?.webContents.send("accounts-changed");
    return list;
  });

  ipcMain.handle("set-account-subscription", async (_e, entryKey, fields) => {
    const data = secure.loadAccounts();
    const entry = data.accounts[entryKey];
    if (!entry) throw new Error("账号不存在");
    const patch = { ...entry };
    if (fields && typeof fields.paste === "string") {
      patch.subscription_paste = fields.paste;
      const parsed = secure.parseRenewalPaste(fields.paste);
      if (parsed) {
        if (parsed.date) patch.subscription_renews_at = parsed.date;
        if (parsed.method) patch.subscription_payment_method = parsed.method;
      }
    }
    if (fields && fields.date != null) patch.subscription_renews_at = fields.date;
    if (fields && fields.method != null) patch.subscription_payment_method = fields.method;
    if (fields && fields.note != null) patch.subscription_note = fields.note;
    secure.upsertEntry(entryKey, patch);
    panel?.webContents.send("accounts-changed");
    return grokBilling.formatSubscriptionLine(patch);
  });

  ipcMain.handle("reorder-accounts", async (_e, orderedKeys) => {
    if (!Array.isArray(orderedKeys)) return false;
    settings.save({ accountOrder: orderedKeys });
    panel?.webContents.send("accounts-changed");
    return true;
  });

  ipcMain.handle("test-account-api", async (_e, entryKey) => {
    const card = await grokApiTest.testAccount(entryKey);
    if (lastUsage && Array.isArray(lastUsage.accounts)) {
      const idx = lastUsage.accounts.findIndex((a) => a.entryKey === entryKey);
      if (idx >= 0) lastUsage.accounts[idx] = card;
      else lastUsage.accounts.push(card);
      panel?.webContents.send("usage-result", lastUsage);
    }
    return card;
  });

  ipcMain.handle("test-all-apis", async () => {
    const result = await grokApiTest.testAllAccounts();
    if (lastUsage) {
      lastUsage.accounts = result.accounts;
      panel?.webContents.send("usage-result", lastUsage);
    }
    return result;
  });

  ipcMain.handle("start-browser-login", async (_e, opts) => {
    const info = await grokAuth.startDeviceLogin({
      reauthEntryKey: opts?.reauthEntryKey || null,
    });
    // auto-copy link, never open browser
    try {
      clipboard.writeText(info.copyUrl);
    } catch {
      /* ignore */
    }
    startLoginPoll();
    panel?.webContents.send("login-state", {
      state: "pending",
      message: "等待浏览器授权…",
      ...info,
    });
    return info;
  });

  ipcMain.handle("cancel-login", async () => {
    grokAuth.cancelDeviceLogin();
    if (loginPollTimer) {
      clearInterval(loginPollTimer);
      loginPollTimer = null;
    }
    panel?.webContents.send("login-state", { state: "cancelled", message: "已取消登录" });
    return true;
  });

  ipcMain.handle("poll-login", async () => grokAuth.pollDeviceLogin());

  ipcMain.handle("logout", async (_e, entryKey) => {
    secure.removeEntry(entryKey);
    const cfg = settings.load();
    if (cfg.activeEntryKey === entryKey) {
      const left = secure.listEntries();
      settings.save({ activeEntryKey: left[0]?.entryKey || null });
    }
    panel?.webContents.send("accounts-changed");
    await refreshAll({ skipCliSync: true }).catch(() => {});
    return true;
  });

  ipcMain.handle("logout-all", async () => {
    secure.clearAll();
    settings.save({ activeEntryKey: null, accountOrder: [] });
    lastUsage = { v: 1, accounts: [], trayPercent: null };
    updateTrayIcon(0);
    panel?.webContents.send("accounts-changed");
    panel?.webContents.send("usage-result", lastUsage);
    return true;
  });

  ipcMain.handle("refresh-usage", async (_e, opts) => refreshAll(opts || {}));

  ipcMain.handle("soft-import-cli", async () => {
    const result = secure.syncFromCli(true);
    panel?.webContents.send("accounts-changed");
    if (result.added > 0 || result.updated > 0 || result.total > 0) {
      await refreshAll().catch(() => {});
    }
    return result;
  });

  ipcMain.handle("open-path", async (_e, which) => {
    const map = {
      appData: appDataRoot(),
      accounts: accountsPath(),
      config: configPath(),
      cliAuth: path.dirname(cliAuthPath()),
      debug: debugDir(),
    };
    const p = map[which] || appDataRoot();
    await shell.openPath(p);
    return true;
  });

  ipcMain.handle("open-external", async (_e, url) => {
    if (typeof url !== "string") throw new Error("invalid url");
    if (!ALLOWED_EXTERNAL.some((re) => re.test(url))) {
      throw new Error("域名不在白名单: " + url);
    }
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("hide-panel", async () => {
    hidePanel();
    return true;
  });

  ipcMain.handle("quit-app", async () => {
    isQuitting = true;
    app.quit();
    return true;
  });

  ipcMain.handle("get-fullscreen", async () => isFullscreen);
  ipcMain.handle("set-fullscreen", async (_e, on) => {
    setFullscreenMode(!!on);
    return isFullscreen;
  });
  ipcMain.handle("toggle-fullscreen", async () => {
    setFullscreenMode(!isFullscreen);
    return isFullscreen;
  });

  ipcMain.handle("copy-text", async (_e, text) => {
    clipboard.writeText(String(text || ""));
    return true;
  });

  ipcMain.handle("parse-renewal", async (_e, text) => secure.parseRenewalPaste(text));
}

app.whenReady().then(async () => {
  await applySessionProxy(session.defaultSession);
  applyTheme();
  registerIpc();
  createPanel();
  createTray();

  // Sync tokens from Grok CLI auth.json (same path as Tauri: ~/.grok/auth.json)
  try {
    const sync = secure.syncFromCli(true);
    console.log("[cli-sync]", sync);
  } catch (e) {
    console.error("cli-sync", e);
  }

  const cfg = settings.load();
  // Ensure tray/active account is set when vault has entries but config is empty
  try {
    const entries = secure.listEntries();
    if (entries.length > 0) {
      const activeStillThere =
        cfg.activeEntryKey && entries.some((e) => e.entryKey === cfg.activeEntryKey);
      if (!activeStillThere) {
        settings.save({ activeEntryKey: entries[0].entryKey });
        console.log("[cli-sync] activeEntryKey ->", entries[0].entryKey);
      }
    }
  } catch (e) {
    console.error("active account init", e);
  }

  try {
    app.setLoginItemSettings({ openAtLogin: !!cfg.launchAtLogin });
  } catch {
    /* ignore */
  }

  scheduleRefresh();
  refreshAll()
    .then(() => {
      // Always show panel after first load so user sees CLI accounts immediately
      showPanel();
    })
    .catch((e) => {
      console.error(e);
      showPanel();
    });
});

app.on("before-quit", () => {
  isQuitting = true;
  if (refreshTimer) clearInterval(refreshTimer);
  if (loginPollTimer) clearInterval(loginPollTimer);
});

// Keep running in tray; do not quit when panel is hidden/closed.
app.on("window-all-closed", () => {});
