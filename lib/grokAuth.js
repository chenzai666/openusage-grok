const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
// Align with Grok CLI scopes so device-login tokens behave like CLI tokens
const SCOPES =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write workspaces:read workspaces:write";

const { upsertEntry, loadAccounts } = require("./secureAccounts");
const { request } = require("./http");

let pendingDevice = null;

function decodeJwtPayload(token) {
  try {
    const parts = String(token).split(".");
    if (parts.length < 2) return null;
    const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(Buffer.from(pad, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * entryKey formats:
 *   https://auth.x.ai::<clientId>
 *   https://auth.x.ai::<clientId>::<sub|email:...>
 */
function readClientId(entryKey, entry) {
  if (entry?.oidc_client_id) return String(entry.oidc_client_id).trim();
  const parts = String(entryKey || "").split("::").filter((p) => p !== "");
  // ["https://auth.x.ai", clientId] or ["https://auth.x.ai", clientId, sub]
  if (parts.length >= 2) return parts[1].trim() || DEFAULT_CLIENT_ID;
  return DEFAULT_CLIENT_ID;
}

function makeEntryKey(clientId, payload, email) {
  const sub = (payload && payload.sub) || "";
  if (sub) return `https://auth.x.ai::${clientId}::${sub}`;
  const em = (email || (payload && payload.email) || "").trim().toLowerCase();
  if (em) return `https://auth.x.ai::${clientId}::email:${em}`;
  // last resort — still unique so we don't overwrite other logins
  return `https://auth.x.ai::${clientId}::t${Date.now()}`;
}

function findExistingKeyByEmail(email) {
  if (!email) return null;
  const want = String(email).trim().toLowerCase();
  const data = loadAccounts({ recoverFromCli: false });
  for (const [k, e] of Object.entries(data.accounts || {})) {
    const em = (e.email || e.user_email || "").trim().toLowerCase();
    if (em && em === want) return k;
  }
  return null;
}

function findExistingKeyBySub(sub) {
  if (!sub) return null;
  const want = String(sub).trim();
  const data = loadAccounts({ recoverFromCli: false });
  for (const [k, e] of Object.entries(data.accounts || {})) {
    const esub = String(e.user_id || e.sub || e.principal_id || "").trim();
    if (esub && esub === want) return k;
    const parts = String(k).split("::");
    if (parts.length >= 3 && parts[parts.length - 1] === want) return k;
  }
  return null;
}

async function refreshToken(entryKey, entry) {
  const refresh = (entry.refresh_token || entry.refresh || "").trim();
  if (!refresh) return null;
  const clientId = readClientId(entryKey, entry);
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refresh,
  });
  const resp = await request(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const data = resp.data || {};
  if (!resp.ok || !data.access_token) {
    const err = data.error || data.error_description || `HTTP ${resp.status}`;
    if (String(err).includes("invalid_grant") || resp.status === 400) {
      const e = new Error("invalid_grant");
      e.code = "invalid_grant";
      throw e;
    }
    return null;
  }
  const expiresIn = Number(data.expires_in) || 3600;
  const patch = {
    key: data.access_token,
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    oidc_client_id: clientId,
  };
  if (data.refresh_token) patch.refresh_token = data.refresh_token;
  if (data.id_token) patch.id_token = data.id_token;
  const payload = decodeJwtPayload(data.access_token) || decodeJwtPayload(data.id_token);
  if (payload?.email) patch.email = payload.email;
  if (payload?.tier != null) patch.tier = payload.tier;
  upsertEntry(entryKey, { ...entry, ...patch });
  return patch.key;
}

function tokenStillValid(entry, token) {
  const t = (token || entry?.key || entry?.access_token || "").trim();
  if (!t) return false;
  const exp = entry?.expires_at ? Date.parse(entry.expires_at) : NaN;
  if (Number.isFinite(exp)) return Date.now() < exp - 30 * 1000;
  // No expires_at: try JWT exp
  const payload = decodeJwtPayload(t);
  if (payload?.exp) return Date.now() < payload.exp * 1000 - 30 * 1000;
  return true;
}

async function ensureAccessToken(entryKey, entry, { forceRefresh = false } = {}) {
  let token = (entry.key || entry.access_token || "").trim();
  const exp = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
  const nearExpiry = Number.isFinite(exp) && Date.now() > exp - 5 * 60 * 1000;
  if (forceRefresh || !token || nearExpiry) {
    try {
      const refreshed = await refreshToken(entryKey, entry);
      if (refreshed) return refreshed;
    } catch (e) {
      // invalid_grant: only hard-fail when access token is already unusable
      if (e.code === "invalid_grant") {
        if (!tokenStillValid(entry, token)) throw e;
        // access token still has life — use it; UI can re-login later
        return token;
      }
    }
  }
  if (!token) throw new Error("无 access token");
  return token;
}

async function startDeviceLogin({ reauthEntryKey } = {}) {
  const body = new URLSearchParams({
    client_id: DEFAULT_CLIENT_ID,
    scope: SCOPES,
  });
  const resp = await request(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const data = resp.data || {};
  if (!resp.ok || !data.device_code) {
    throw new Error(data.error_description || data.error || `device code 失败 HTTP ${resp.status}`);
  }
  const copyUrl =
    data.verification_uri_complete ||
    `${data.verification_uri || "https://auth.x.ai/device"}?user_code=${data.user_code}`;
  pendingDevice = {
    device_code: data.device_code,
    client_id: DEFAULT_CLIENT_ID,
    interval: Math.max(3, Number(data.interval) || 5),
    expires_at: Date.now() + (Number(data.expires_in) || 900) * 1000,
    lastPoll: 0,
    reauthEntryKey: reauthEntryKey || null,
  };
  return {
    userCode: data.user_code,
    verificationUri: data.verification_uri || "https://auth.x.ai/device",
    verificationUriComplete: data.verification_uri_complete || null,
    expiresIn: Number(data.expires_in) || 900,
    interval: pendingDevice.interval,
    copyUrl,
  };
}

function cancelDeviceLogin() {
  pendingDevice = null;
}

async function pollDeviceLogin() {
  if (!pendingDevice) {
    return { state: "cancelled", message: "没有进行中的登录" };
  }
  if (Date.now() >= pendingDevice.expires_at) {
    pendingDevice = null;
    return { state: "expired", message: "登录码已过期，请重新开始" };
  }
  const waitMs = pendingDevice.interval * 1000;
  if (Date.now() - pendingDevice.lastPoll < waitMs) {
    return { state: "pending", message: "等待浏览器授权…" };
  }
  pendingDevice.lastPoll = Date.now();

  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    device_code: pendingDevice.device_code,
    client_id: pendingDevice.client_id,
  });
  const resp = await request(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });
  const data = resp.data || {};

  if (resp.ok && data.access_token) {
    const payload =
      decodeJwtPayload(data.id_token) || decodeJwtPayload(data.access_token) || {};
    const accessPayload = decodeJwtPayload(data.access_token) || {};
    const clientId = pendingDevice.client_id;
    const sub = String(payload.sub || accessPayload.sub || "").trim();
    const email = (
      payload.email ||
      accessPayload.email ||
      payload.preferred_username ||
      ""
    )
      .trim()
      .toLowerCase() || null;

    // ALWAYS resolve slot from the identity that just authorized (JWT).
    // Never stuff account B's tokens into account A's reauth slot — that made
    // "I logged in as the same CLI account" appear broken when Google picker
    // chose a different account, or when reauthEntryKey pointed at the wrong card.
    const vault = loadAccounts({ recoverFromCli: false }).accounts || {};
    const byEmail = findExistingKeyByEmail(email);
    const bySub = findExistingKeyBySub(sub);
    const preferred = makeEntryKey(clientId, { ...payload, sub }, email);

    let entryKey = bySub || byEmail || preferred;
    let identityMismatch = false;
    const wantedKey = pendingDevice.reauthEntryKey;

    if (wantedKey && vault[wantedKey]) {
      const want = vault[wantedKey];
      const wantSub = String(want.user_id || want.sub || want.principal_id || "").trim();
      const wantEmail = String(want.email || want.user_email || "")
        .trim()
        .toLowerCase();
      const parts = String(wantedKey).split("::");
      const wantKeySub =
        parts.length >= 3 && !String(parts[2]).startsWith("email:") ? parts[2] : "";
      const sameSub =
        sub && (sub === wantSub || sub === wantKeySub || wantedKey.endsWith("::" + sub));
      const sameEmail = email && wantEmail && email === wantEmail;
      if (sameSub || sameEmail) {
        // Same identity as the card user clicked "reauth" on
        entryKey = wantedKey;
      } else {
        // Browser authorized a *different* xAI/Google account than the card
        identityMismatch = true;
        entryKey = bySub || byEmail || preferred;
      }
    }

    // Never use short key without identity
    if (entryKey === `https://auth.x.ai::${clientId}`) {
      entryKey = preferred;
    }

    const prev = vault[entryKey] || {};
    const expiresIn = Number(data.expires_in) || 3600;
    const entry = {
      ...prev,
      key: data.access_token,
      refresh_token: data.refresh_token || prev.refresh_token,
      id_token: data.id_token || prev.id_token,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      oidc_client_id: clientId,
      email: email || prev.email,
      user_id: sub || prev.user_id || prev.sub || "",
      tier:
        payload.tier != null
          ? payload.tier
          : accessPayload.tier != null
            ? accessPayload.tier
            : prev.tier,
      labels: prev.labels || [],
      auth_mode: "oidc",
      source: "device-login",
      create_time: prev.create_time || new Date().toISOString(),
    };
    upsertEntry(entryKey, entry);
    pendingDevice = null;

    const shown = entry.email || sub || entryKey;
    let message = `浏览器授权成功（${shown}），正在刷新用量…`;
    if (identityMismatch) {
      const wantEm =
        (vault[wantedKey] && (vault[wantedKey].email || vault[wantedKey].user_email)) ||
        wantedKey;
      message =
        `浏览器里登录的是 ${shown}，与要点「重新登录」的账号（${wantEm}）不是同一个。` +
        `已写入 ${shown} 的令牌；请在授权页确认 Google/xAI 账号与 CLI 一致。`;
    }

    return {
      state: "complete",
      message,
      entryKey,
      email: entry.email || null,
      tier: entry.tier != null ? entry.tier : null,
      identityMismatch,
    };
  }

  const err = data.error || "unknown";
  if (err === "authorization_pending" || err === "slow_down") {
    return { state: "pending", message: "等待浏览器授权…" };
  }
  if (err === "expired_token" || err === "access_denied") {
    pendingDevice = null;
    return { state: "expired", message: `登录失败: ${err}` };
  }
  return { state: "pending", message: `等待中 (${err})` };
}

module.exports = {
  DEFAULT_CLIENT_ID,
  decodeJwtPayload,
  readClientId,
  makeEntryKey,
  ensureAccessToken,
  refreshToken,
  startDeviceLogin,
  pollDeviceLogin,
  cancelDeviceLogin,
};
