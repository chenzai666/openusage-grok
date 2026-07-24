/**
 * Multi-account store with Electron safeStorage (Windows DPAPI) when available.
 * Soft-import from ~/.grok/auth.json — never overwrite CLI file wholesale.
 */
const fs = require("fs");
const path = require("path");
const { accountsPath, cliAuthPath, backupsDir } = require("./paths");

const ENC_MARKER = "openusage-secure-v1";

let safeStorage = null;
try {
  ({ safeStorage } = require("electron"));
} catch {
  safeStorage = null;
}

function canEncrypt() {
  try {
    return !!(
      safeStorage &&
      safeStorage.isEncryptionAvailable &&
      safeStorage.isEncryptionAvailable()
    );
  } catch {
    return false;
  }
}

function encryptPayload(plainObj) {
  const json = JSON.stringify(plainObj);
  if (!canEncrypt()) {
    return { __openusage_enc: "plain", payload: plainObj };
  }
  const buf = safeStorage.encryptString(json);
  return {
    __openusage_enc: ENC_MARKER,
    alg: "safeStorage",
    payload: buf.toString("base64"),
  };
}

function decryptFile(raw) {
  if (!raw || typeof raw !== "object") return { accounts: {} };
  if (raw.__openusage_enc === ENC_MARKER && typeof raw.payload === "string") {
    if (!canEncrypt()) {
      const err = new Error("无法解密账号库（safeStorage 不可用，请在 Electron 应用内访问）");
      err.code = "DECRYPT_UNAVAILABLE";
      throw err;
    }
    try {
      const plain = safeStorage.decryptString(Buffer.from(raw.payload, "base64"));
      return JSON.parse(plain);
    } catch (e) {
      const err = new Error("账号库解密失败: " + (e.message || e));
      err.code = "DECRYPT_FAILED";
      throw err;
    }
  }
  if (raw.__openusage_enc === "plain" && raw.payload) return raw.payload;
  if (raw.accounts) return raw;
  return { accounts: raw };
}

function backup(data) {
  try {
    const name = `accounts.backup.${Date.now()}.json`;
    fs.writeFileSync(path.join(backupsDir(), name), JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

/** Move undecryptable vault aside so we can rebuild from CLI. */
function quarantineBrokenVault(reason) {
  const p = accountsPath();
  if (!fs.existsSync(p)) return null;
  try {
    const dest = path.join(
      backupsDir(),
      `accounts.broken.${Date.now()}.json`
    );
    fs.renameSync(p, dest);
    console.warn("[vault] quarantined broken accounts.json ->", dest, reason || "");
    return dest;
  } catch (e) {
    console.error("[vault] quarantine failed", e);
    try {
      fs.unlinkSync(p);
      return "deleted";
    } catch {
      return null;
    }
  }
}

/**
 * Load accounts.
 * On safeStorage decrypt failure: quarantine vault and rebuild from CLI (portable/dev DPAPI mismatch).
 */
function loadAccounts({ allowEmptyOnMissing = true, recoverFromCli = true } = {}) {
  const p = accountsPath();
  if (!fs.existsSync(p)) {
    if (!allowEmptyOnMissing) return { accounts: {} };
    const imported = syncFromCli(true);
    if ((imported.added > 0 || imported.updated > 0) && fs.existsSync(p)) {
      return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
    }
    return { accounts: {} };
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (recoverFromCli) {
      quarantineBrokenVault("json-parse:" + (e.message || e));
      const imported = syncFromCli(true);
      if (imported.total > 0 && fs.existsSync(p)) {
        return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
      }
      return { accounts: {} };
    }
    throw e;
  }

  let data;
  try {
    data = decryptFile(raw);
  } catch (e) {
    if (
      recoverFromCli &&
      (e.code === "DECRYPT_FAILED" || e.code === "DECRYPT_UNAVAILABLE")
    ) {
      quarantineBrokenVault(e.message || e.code);
      // Rebuild vault purely from CLI without reading broken file
      const imported = syncFromCli(true);
      if (imported.error && imported.total === 0) {
        // still return empty rather than throw — UI can re-login
        return { accounts: {} };
      }
      if (fs.existsSync(p)) {
        try {
          return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
        } catch {
          return { accounts: {} };
        }
      }
      return { accounts: {} };
    }
    throw e;
  }

  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};

  // Auto-migrate plain → DPAPI when running inside Electron
  if (raw.__openusage_enc === "plain" && canEncrypt()) {
    try {
      saveAccounts(data);
    } catch {
      /* ignore migrate failure */
    }
  }
  return data;
}

function saveAccounts(data) {
  if (!data || typeof data !== "object") throw new Error("invalid accounts data");
  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
  const p = accountsPath();
  if (fs.existsSync(p)) {
    try {
      const prev = decryptFile(JSON.parse(fs.readFileSync(p, "utf8")));
      const prevN = Object.keys(prev.accounts || {}).length;
      const nextN = Object.keys(data.accounts).length;
      if (prevN > 0 && nextN === 0 && !data.__allowEmpty) {
        throw new Error("拒绝将账号库静默清空（请使用退出全部）");
      }
      backup(prev);
    } catch (e) {
      if (String(e.message || e).includes("拒绝")) throw e;
      if (e.code === "DECRYPT_UNAVAILABLE" || e.code === "DECRYPT_FAILED") {
        // Vault is broken — quarantine and allow rewrite when we have accounts
        if (Object.keys(data.accounts).length === 0 && !data.__allowEmpty) {
          throw new Error("现有账号库无法解密，且无新账号可写入");
        }
        quarantineBrokenVault(e.message || e.code);
      }
    }
  }
  delete data.__allowEmpty;
  const envelope = encryptPayload(data);
  fs.writeFileSync(p, JSON.stringify(envelope, null, 2), "utf8");
  return data;
}

/**
 * Sync from Grok CLI ~/.grok/auth.json into vault (like Tauri: CLI is source of tokens).
 * - Never writes/overwrites the CLI file.
 * - Adds missing keys; updates tokens on existing keys (keeps labels / 手动订阅).
 * Returns a detail object (not a bare number).
 */
function syncFromCli(persist = true) {
  const p = cliAuthPath();
  const result = {
    path: p,
    exists: false,
    cliCount: 0,
    added: 0,
    updated: 0,
    skipped: 0,
    total: 0,
    emails: [],
    error: null,
  };

  if (!fs.existsSync(p)) {
    result.error = "未找到 Grok CLI 凭证文件";
    return result;
  }
  result.exists = true;

  let cli;
  try {
    cli = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    result.error = "无法解析 auth.json: " + (e.message || e);
    return result;
  }
  if (!cli || typeof cli !== "object" || Array.isArray(cli)) {
    result.error = "auth.json 格式无效（需要对象 map）";
    return result;
  }

  let data;
  let recoveredVault = false;
  try {
    data = fs.existsSync(accountsPath())
      ? loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false })
      : { accounts: {} };
  } catch (e) {
    console.error("syncFromCli: cannot load vault", e.message || e);
    if (e.code === "DECRYPT_UNAVAILABLE" || e.code === "DECRYPT_FAILED") {
      // Do not abort CLI sync — quarantine broken DPAPI blob and rebuild from CLI
      quarantineBrokenVault(e.message || e.code);
      data = { accounts: {} };
      recoveredVault = true;
      result.recovered = true;
      result.recoverNote =
        "本地加密账号库无法解密（常见于便携版/开发版切换），已隔离坏库并从 CLI 重建";
    } else {
      data = { accounts: {} };
    }
  }

  for (const [key, entry] of Object.entries(cli)) {
    if (!entry || typeof entry !== "object") {
      result.skipped++;
      continue;
    }
    const token =
      (typeof entry.key === "string" && entry.key.trim()) ||
      (typeof entry.access_token === "string" && entry.access_token.trim()) ||
      "";
    if (!token) {
      result.skipped++;
      continue;
    }
    result.cliCount++;
    const email =
      (typeof entry.email === "string" && entry.email) ||
      (typeof entry.user_email === "string" && entry.user_email) ||
      "";
    if (email) result.emails.push(email);

    const prev = data.accounts[key];
    if (!prev) {
      data.accounts[key] = {
        ...entry,
        key: token,
        labels: Array.isArray(entry.labels) ? entry.labels : [],
        source: "cli-import",
      };
      result.added++;
    } else {
      // Prefer CLI tokens (same as Tauri reading auth.json live); keep local meta
      data.accounts[key] = {
        ...prev,
        ...entry,
        key: token,
        labels: Array.isArray(prev.labels) ? prev.labels : entry.labels || [],
        subscription_renews_at: prev.subscription_renews_at || entry.subscription_renews_at,
        subscription_payment_method:
          prev.subscription_payment_method || entry.subscription_payment_method,
        subscription_paste: prev.subscription_paste || entry.subscription_paste,
        subscription_note: prev.subscription_note || entry.subscription_note,
        source: prev.source || "cli-import",
      };
      result.updated++;
    }
  }

  result.total = Object.keys(data.accounts).length;
  if (persist && (result.added > 0 || result.updated > 0 || recoveredVault)) {
    try {
      // Force write even if previous vault was broken
      if (recoveredVault) data.__allowEmpty = result.total === 0;
      saveAccounts(data);
      if (recoveredVault && !result.error) {
        result.message = result.recoverNote || "已从 CLI 重建账号库";
      }
    } catch (e) {
      result.error = "写入账号库失败: " + (e.message || e);
    }
  }
  return result;
}

/** @deprecated use syncFromCli — kept for callers; returns detail object */
function softImportCli(persist = true) {
  return syncFromCli(persist);
}

function cliAuthStatus() {
  const p = cliAuthPath();
  const st = { path: p, exists: fs.existsSync(p), count: 0, emails: [] };
  if (!st.exists) return st;
  try {
    const cli = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!cli || typeof cli !== "object") return st;
    for (const entry of Object.values(cli)) {
      if (!entry || typeof entry !== "object") continue;
      const token =
        (typeof entry.key === "string" && entry.key.trim()) ||
        (typeof entry.access_token === "string" && entry.access_token.trim()) ||
        "";
      if (!token) continue;
      st.count++;
      const email = entry.email || entry.user_email;
      if (email) st.emails.push(email);
    }
  } catch {
    /* ignore */
  }
  return st;
}

function listEntries() {
  try {
    const data = loadAccounts();
    return Object.entries(data.accounts).map(([entryKey, entry]) => ({
      entryKey,
      entry,
    }));
  } catch (e) {
    console.error("listEntries", e);
    return [];
  }
}

function upsertEntry(entryKey, entry) {
  const data = loadAccounts();
  const prev = data.accounts[entryKey] || {};
  data.accounts[entryKey] = {
    ...prev,
    ...entry,
    labels: entry.labels !== undefined ? entry.labels : prev.labels || [],
  };
  saveAccounts(data);
  return data.accounts[entryKey];
}

function removeEntry(entryKey) {
  const data = loadAccounts();
  if (!data.accounts[entryKey]) return false;
  delete data.accounts[entryKey];
  saveAccounts(data);
  return true;
}

function clearAll() {
  saveAccounts({ accounts: {}, __allowEmpty: true });
}

function parseRenewalPaste(text) {
  if (!text || typeof text !== "string") return null;
  const s = text.trim();
  if (!s) return null;
  let method = null;
  const via =
    s.match(/billed via\s+(.+?)(?:\s*[·|]|$)/i) || s.match(/via\s+(.+?)(?:\s*[·|]|$)/i);
  if (via && via[1]) method = via[1].trim().replace(/\.$/, "");

  const months = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
    jan: 1,
    feb: 2,
    mar: 3,
    apr: 4,
    jun: 6,
    jul: 7,
    aug: 8,
    sep: 9,
    oct: 10,
    nov: 11,
    dec: 12,
  };
  let dateStr = null;
  const m1 = s.match(/Renews on\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
  if (m1) {
    const mon = months[m1[1].toLowerCase()];
    if (mon) {
      dateStr = `${String(+m1[2]).padStart(2, "0")}/${String(mon).padStart(2, "0")}/${m1[3]}`;
    }
  }
  if (!dateStr) {
    const m2 = s.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m2) dateStr = `${m2[3]}/${m2[2]}/${m2[1]}`;
  }
  if (!dateStr) {
    const m3 = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m3) {
      dateStr =
        String(+m3[1]).padStart(2, "0") +
        "/" +
        String(+m3[2]).padStart(2, "0") +
        "/" +
        m3[3];
    }
  }
  if (!dateStr && !method) return null;
  return { date: dateStr, method };
}

function maskEmail(email) {
  if (!email || typeof email !== "string") return "未命名账号";
  const s = email.trim();
  const at = s.indexOf("@");
  if (at <= 0) return s;
  const user = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (user.length <= 3) return `${user[0]}***@${domain}`;
  return `${user.slice(0, 3)}***${user.slice(-2)}@${domain}`;
}

module.exports = {
  loadAccounts,
  saveAccounts,
  softImportCli,
  syncFromCli,
  cliAuthStatus,
  listEntries,
  upsertEntry,
  removeEntry,
  clearAll,
  parseRenewalPaste,
  maskEmail,
  canEncrypt,
  accountsPath,
  cliAuthPath,
};
