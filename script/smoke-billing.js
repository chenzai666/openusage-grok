/**
 * Headless smoke: soft-import CLI + fetch billing (must run under Electron).
 * Usage: npx electron script/smoke-billing.js
 */
const { app, session } = require("electron");
const { applySessionProxy, resolveProxy } = require("../lib/http");

app.whenReady().then(async () => {
  try {
    const resolved = await applySessionProxy(session.defaultSession);
    console.log("[smoke] proxy", resolveProxy(), resolved);
    const secure = require("../lib/secureAccounts");
    const billing = require("../lib/grokBilling");
    const n = secure.softImportCli(true);
    console.log("[smoke] soft-import added:", n);
    console.log("[smoke] canEncrypt:", secure.canEncrypt());
    const entries = secure.listEntries();
    console.log(
      "[smoke] accounts:",
      entries.length,
      entries.map((e) => e.entry?.email || e.entryKey.slice(0, 32))
    );
    if (!entries.length) {
      console.error("[smoke] no accounts — login via UI or set ~/.grok/auth.json");
      app.exit(2);
      return;
    }
    const result = await billing.fetchAllUsage({ runChat: true });
    for (const a of result.accounts) {
      console.log("[smoke] card", {
        title: a.title,
        status: a.status,
        weekly: a.weeklyPercent,
        build: a.buildPercent,
        api: a.apiUsed != null ? `${a.apiUsed}/${a.apiLimit}` : null,
        plan: a.planLine,
        probe: a.probe,
        error: a.error || null,
      });
    }
    console.log("[smoke] trayPercent:", result.trayPercent);
    console.log("[smoke] OK");
    app.exit(0);
  } catch (e) {
    console.error("[smoke] FAIL", e);
    app.exit(1);
  }
});

// Prevent default window
app.on("window-all-closed", (e) => e.preventDefault());
