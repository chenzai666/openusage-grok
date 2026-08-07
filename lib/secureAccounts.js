/**
 * Multi-account store with Electron safeStorage (Windows DPAPI) when available.
 * Soft-import from ~/.grok/auth.json — never overwrite CLI file wholesale.
 * Never drop vault-only accounts when syncing CLI.
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
  if (!raw || typeof raw !== "object") return { accounts: {}, deletedKeys: [] };
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
  return { accounts: raw, deletedKeys: [] };
}

function normalizeData(data) {
  if (!data || typeof data !== "object") data = { accounts: {} };
  if (!data.accounts || typeof data.accounts !== "object") data.accounts = {};
  if (!Array.isArray(data.deletedKeys)) data.deletedKeys = [];
  return data;
}

function backup(data) {
  try {
    const name = `accounts.backup.${Date.now()}.json`;
    fs.writeFileSync(path.join(backupsDir(), name), JSON.stringify(data, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

function quarantineBrokenVault(reason) {
  const p = accountsPath();
  if (!fs.existsSync(p)) return null;
  try {
    const dest = path.join(backupsDir(), `accounts.broken.${Date.now()}.json`);
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
 * On decrypt failure: quarantine + merge CLI into empty (preserve nothing if undecryptable).
 */
function loadAccounts({ allowEmptyOnMissing = true, recoverFromCli = true } = {}) {
  const p = accountsPath();
  if (!fs.existsSync(p)) {
    if (!allowEmptyOnMissing) return normalizeData({ accounts: {} });
    const imported = syncFromCli(true);
    if ((imported.added > 0 || imported.updated > 0) && fs.existsSync(p)) {
      return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
    }
    return normalizeData({ accounts: {} });
  }

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    if (recoverFromCli) {
      quarantineBrokenVault("json-parse:" + (e.message || e));
      syncFromCli(true);
      if (fs.existsSync(p)) {
        return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
      }
      return normalizeData({ accounts: {} });
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
      syncFromCli(true);
      if (fs.existsSync(p)) {
        try {
          return loadAccounts({ allowEmptyOnMissing: false, recoverFromCli: false });
        } catch {
          return normalizeData({ accounts: {} });
        }
      }
      return normalizeData({ accounts: {} });
    }
    throw e;
  }

  data = normalizeData(data);

  if (raw.__openusage_enc === "plain" && canEncrypt()) {
    try {
      saveAccounts(data);
    } catch {
      /* ignore */
    }
  }
  return data;
}

function saveAccounts(data) {
  data = normalizeData(data);
  const p = accountsPath();
  if (fs.existsSync(p)) {
    try {
      const prev = normalizeData(decryptFile(JSON.parse(fs.readFileSync(p, "utf8"))));
      const prevN = Object.keys(prev.accounts).length;
      const nextN = Object.keys(data.accounts).length;
      if (prevN > 0 && nextN === 0 && !data.__allowEmpty) {
        throw new Error("拒绝将账号库静默清空（请使用退出全部）");
      }
      // Refuse silent multi-account shrink unless deliberate delete (nextN can be less)
      // Only block total wipe, not single deletes.
      backup(prev);
    } catch (e) {
      if (String(e.message || e).includes("拒绝")) throw e;
      if (e.code === "DECRYPT_UNAVAILABLE" || e.code === "DECRYPT_FAILED") {
        if (Object.keys(data.accounts).length === 0 && !data.__allowEmpty) {
          throw new Error("现有账号库无法解密，且无新账号可写入");
        }
        quarantineBrokenVault(e.message || e.code);
      }
    }
  }
  delete data.__allowEmpty;
  const envelope = encryptPayload({
    accounts: data.accounts,
    deletedKeys: data.deletedKeys || [],
  });
  fs.writeFileSync(p, JSON.stringify(envelope, null, 2), "utf8");
  return data;
}

const DEFAULT_OIDC_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";

/**
 * Grok CLI stores the active session under a short scope key:
 *   https://auth.x.ai::<clientId>
 * (no user identity). OpenUsage must NEVER treat that short key as a stable
 * multi-account id — every CLI re-login reuses the same short key.
 */
function isShortCliScopeKey(key) {
  const parts = String(key || "").split("::").filter((p) => p !== "");
  // ["https://auth.x.ai", clientId]  — no third identity segment
  return parts.length === 2 && String(parts[0]).includes("auth.x.ai");
}

function readCliIdentity(entry, cliKey) {
  const sub =
    (entry && (entry.user_id || entry.sub || entry.principal_id)) ||
    "";
  const emailRaw =
    (entry &&
      ((typeof entry.email === "string" && entry.email) ||
        (typeof entry.user_email === "string" && entry.user_email))) ||
    "";
  const email = String(emailRaw || "").trim();
  const emailNorm = email.toLowerCase();
  const clientId =
    (entry && entry.oidc_client_id) ||
    (String(cliKey || "").split("::")[1] || DEFAULT_OIDC_CLIENT_ID);
  return { sub: String(sub || "").trim(), email, emailNorm, clientId };
}

/**
 * Resolve a stable vault entry key for a CLI auth entry.
 * Prefer: existing vault slot by email → long key with sub → email-tagged key → raw CLI key.
 */
function resolveCliEntryKey(cliKey, entry, vaultAccounts) {
  const { sub, email, emailNorm, clientId } = readCliIdentity(entry, cliKey);

  if (emailNorm) {
    const existingByEmail = Object.entries(vaultAccounts || {}).find(
      ([, e]) =>
        e &&
        String(e.email || e.user_email || "")
          .trim()
          .toLowerCase() === emailNorm &&
        e.source !== "cli-import-short-dup"
    );
    if (existingByEmail) return existingByEmail[0];
  }

  // Always expand short CLI scope keys to identity-bearing keys when possible.
  // (Previously only upgraded when preferred already existed — that left all
  // CLI imports under the shared short key, so deleting one banned every future CLI account.)
  if (sub) return `https://auth.x.ai::${clientId}::${sub}`;
  if (emailNorm) return `https://auth.x.ai::${clientId}::email:${emailNorm}`;
  return cliKey;
}

/**
 * Tombstone checks by identity. Never block a *different* CLI user solely
 * because the shared short scope key was deleted earlier.
 */
function isCliEntryTombstoned(deleted, entryKey, cliKey, entry) {
  const { sub, emailNorm } = readCliIdentity(entry, cliKey);
  if (deleted.has(entryKey)) return true;
  if (sub && deleted.has(`sub:${sub}`)) return true;
  if (emailNorm && deleted.has(`email:${emailNorm}`)) return true;
  // Short scope key only applies when we still store under that short key
  // (no user_id/email to form a stable identity).
  if (entryKey === cliKey && deleted.has(cliKey)) return true;
  return false;
}

/**
 * Drop legacy tombstones that only list the shared CLI short scope key.
 * Those incorrectly blocked every subsequent CLI login after one delete.
 */
function pruneLegacyShortScopeTombs(data) {
  const before = (data.deletedKeys || []).length;
  data.deletedKeys = (data.deletedKeys || []).filter((k) => !isShortCliScopeKey(k));
  return before - data.deletedKeys.length;
}

/**
 * Sync CLI auth.json into vault:
 * - add/update CLI keys (unless identity is tombstoned in deletedKeys)
 * - always expand short CLI scope keys to user_id/email long form
 * - never remove vault-only (browser-login) accounts
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
    tombstoned: 0,
    migrated: 0,
    prunedTombs: 0,
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
      : normalizeData({ accounts: {} });
  } catch (e) {
    console.error("syncFromCli: cannot load vault", e.message || e);
    if (e.code === "DECRYPT_UNAVAILABLE" || e.code === "DECRYPT_FAILED") {
      quarantineBrokenVault(e.message || e.code);
      data = normalizeData({ accounts: {} });
      recoveredVault = true;
      result.recovered = true;
      result.recoverNote =
        "本地加密账号库无法解密（常见于便携版/开发版切换），已隔离坏库并从 CLI 重建";
    } else {
      data = normalizeData({ accounts: {} });
    }
  }
  data = normalizeData(data);

  // Fix prior bug: short scope key in deletedKeys banned ALL future CLI accounts
  result.prunedTombs = pruneLegacyShortScopeTombs(data);
  let deleted = new Set(data.deletedKeys || []);
  let dirty = result.prunedTombs > 0;

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

    const { sub, email, emailNorm } = readCliIdentity(entry, key);
    if (email) result.emails.push(email);

    const entryKey = resolveCliEntryKey(key, entry, data.accounts);

    if (isCliEntryTombstoned(deleted, entryKey, key, entry)) {
      result.tombstoned++;
      result.skipped++;
      continue;
    }

    // Migrate vault row off the shared short CLI scope key onto identity key
    let prev = data.accounts[entryKey];
    if (key !== entryKey && data.accounts[key]) {
      const short = data.accounts[key];
      const shortId = readCliIdentity(short, key);
      const sameIdentity =
        (emailNorm && shortId.emailNorm === emailNorm) ||
        (sub && shortId.sub === sub) ||
        (!shortId.emailNorm && !shortId.sub);
      if (sameIdentity) {
        prev = { ...short, ...(prev || {}) };
        delete data.accounts[key];
        result.migrated++;
        dirty = true;
      }
    }

    result.cliCount++;
    if (!prev) {
      data.accounts[entryKey] = {
        ...entry,
        key: token,
        labels: Array.isArray(entry.labels) ? entry.labels : [],
        source: "cli-import",
        email: email || entry.email,
        user_id: sub || entry.user_id,
      };
      result.added++;
      dirty = true;
    } else {
      data.accounts[entryKey] = {
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
        email: email || prev.email || entry.email,
        user_id: sub || prev.user_id || entry.user_id,
        tier: entry.tier != null ? entry.tier : prev.tier,
      };
      result.updated++;
      dirty = true;
    }
  }

  result.total = Object.keys(data.accounts).length;
  if (result.tombstoned > 0 && result.added === 0 && result.updated === 0) {
    result.message =
      `CLI 中有 ${result.tombstoned} 个账号曾被本应用删除，已跳过（不会自动加回）。` +
      `若要重新导入，请先在设置中清除删除记录，或用浏览器登录同一账号。`;
  }
  // Always persist when we added/updated/migrated/pruned OR recovered — never wipe other accounts
  if (
    persist &&
    (dirty || recoveredVault || result.added > 0 || result.updated > 0 || result.migrated > 0)
  ) {
    try {
      if (recoveredVault && result.total === 0) data.__allowEmpty = true;
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

function pushTombstone(list, value) {
  if (!value) return;
  const v = String(value);
  if (!list.includes(v)) list.push(v);
}

function clearIdentityTombs(deletedKeys, entryKey, entry) {
  const { sub, emailNorm } = readCliIdentity(entry || {}, entryKey);
  return (deletedKeys || []).filter((k) => {
    if (k === entryKey) return false;
    if (sub && k === `sub:${sub}`) return false;
    if (emailNorm && k === `email:${emailNorm}`) return false;
    return true;
  });
}

function upsertEntry(entryKey, entry) {
  const data = loadAccounts({ recoverFromCli: false });
  const prev = data.accounts[entryKey] || {};
  data.accounts[entryKey] = {
    ...prev,
    ...entry,
    labels: entry.labels !== undefined ? entry.labels : prev.labels || [],
  };
  // New login clears tombstones for this identity (key / email / sub)
  data.deletedKeys = clearIdentityTombs(data.deletedKeys, entryKey, data.accounts[entryKey]);
  // Also drop legacy short-scope tombs so CLI soft-sync can coexist
  pruneLegacyShortScopeTombs(data);
  saveAccounts(data);
  return data.accounts[entryKey];
}

function removeEntry(entryKey) {
  const data = loadAccounts({ recoverFromCli: false });
  data.deletedKeys = data.deletedKeys || [];

  if (!data.accounts[entryKey]) {
    // still tombstone so CLI sync won't re-add under this exact key
    pushTombstone(data.deletedKeys, entryKey);
    pruneLegacyShortScopeTombs(data);
    saveAccounts(data);
    return false;
  }

  const acc = data.accounts[entryKey];
  const { sub, email, emailNorm } = readCliIdentity(acc, entryKey);
  // Derive sub from long key if entry lacked user_id
  let subId = sub;
  if (!subId) {
    const parts = String(entryKey).split("::");
    if (parts.length >= 3 && !String(parts[2]).startsWith("email:")) {
      subId = parts[2];
    }
  }

  delete data.accounts[entryKey];

  // Tombstone by identity — NOT by the shared short CLI scope key.
  // (Grok CLI always uses https://auth.x.ai::<clientId> for whoever is logged in;
  // tombstoning that key would permanently block every future CLI account.)
  pushTombstone(data.deletedKeys, entryKey);
  if (emailNorm) pushTombstone(data.deletedKeys, `email:${emailNorm}`);
  if (subId) pushTombstone(data.deletedKeys, `sub:${subId}`);

  // If current CLI session is the same identity, also mark its long preferred key
  try {
    const cliPath = cliAuthPath();
    if (fs.existsSync(cliPath)) {
      const cli = JSON.parse(fs.readFileSync(cliPath, "utf8"));
      for (const [k, e] of Object.entries(cli || {})) {
        if (!e || typeof e !== "object") continue;
        const id = readCliIdentity(e, k);
        const same =
          (emailNorm && id.emailNorm === emailNorm) ||
          (subId && id.sub === subId);
        if (!same) continue;
        const preferred = resolveCliEntryKey(k, e, {});
        pushTombstone(data.deletedKeys, preferred);
        if (id.emailNorm) pushTombstone(data.deletedKeys, `email:${id.emailNorm}`);
        if (id.sub) pushTombstone(data.deletedKeys, `sub:${id.sub}`);
        // Deliberately do NOT push the short scope key `k` when isShortCliScopeKey(k)
      }
    }
  } catch {
    /* ignore */
  }

  pruneLegacyShortScopeTombs(data);

  // Allow empty after intentional delete
  if (Object.keys(data.accounts).length === 0) data.__allowEmpty = true;
  saveAccounts(data);
  return true;
}

function clearAll() {
  saveAccounts({ accounts: {}, deletedKeys: [], __allowEmpty: true });
}

function clearDeletedKeys() {
  const data = loadAccounts({ recoverFromCli: false });
  data.deletedKeys = [];
  saveAccounts(data);
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
    january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
    july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
    jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
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
  clearDeletedKeys,
  parseRenewalPaste,
  maskEmail,
  canEncrypt,
  accountsPath,
  cliAuthPath,
};
