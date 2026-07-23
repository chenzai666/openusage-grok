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

/**
 * Load accounts. On decrypt failure throws (does NOT return empty — avoids wipe).
 * missingOk: if file missing, soft-import then return.
 */
function loadAccounts({ allowEmptyOnMissing = true } = {}) {
  const p = accountsPath();
  if (!fs.existsSync(p)) {
    if (!allowEmptyOnMissing) return { accounts: {} };
    const imported = softImportCli(true);
    if (imported > 0 && fs.existsSync(p)) return loadAccounts({ allowEmptyOnMissing: false });
    return { accounts: {} };
  }
  const raw = JSON.parse(fs.readFileSync(p, "utf8"));
  const data = decryptFile(raw);
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
        // Do not overwrite an undecryptable vault with a new empty-ish payload
        // unless caller already has entries (merge path)
        if (Object.keys(data.accounts).length === 0 && !data.__allowEmpty) {
          throw new Error("现有账号库无法解密，已拒绝覆盖写入");
        }
      }
    }
  }
  delete data.__allowEmpty;
  const envelope = encryptPayload(data);
  fs.writeFileSync(p, JSON.stringify(envelope, null, 2), "utf8");
  return data;
}

/** Read CLI auth.json and merge missing entries into OpenUsage store. Never writes CLI file. */
function softImportCli(persist = true) {
  const p = cliAuthPath();
  if (!fs.existsSync(p)) return 0;
  let cli;
  try {
    cli = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return 0;
  }
  if (!cli || typeof cli !== "object") return 0;

  let data;
  try {
    data = fs.existsSync(accountsPath())
      ? loadAccounts({ allowEmptyOnMissing: false })
      : { accounts: {} };
  } catch (e) {
    console.error("softImportCli: cannot load vault", e.message || e);
    // Fall back to empty only if no vault file issues other than decrypt in node —
    // still refuse to wipe encrypted vault from non-electron by not writing over it.
    if (e.code === "DECRYPT_UNAVAILABLE" || e.code === "DECRYPT_FAILED") {
      return 0;
    }
    data = { accounts: {} };
  }

  let added = 0;
  for (const [key, entry] of Object.entries(cli)) {
    if (!entry || typeof entry !== "object") continue;
    const token =
      (typeof entry.key === "string" && entry.key.trim()) ||
      (typeof entry.access_token === "string" && entry.access_token.trim()) ||
      "";
    if (!token) continue;
    if (data.accounts[key]) continue;
    data.accounts[key] = {
      ...entry,
      key: token,
      labels: entry.labels || [],
      source: "cli-import",
    };
    added++;
  }
  if (added > 0 && persist) saveAccounts(data);
  return added;
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
  listEntries,
  upsertEntry,
  removeEntry,
  clearAll,
  parseRenewalPaste,
  maskEmail,
  canEncrypt,
  accountsPath,
};
