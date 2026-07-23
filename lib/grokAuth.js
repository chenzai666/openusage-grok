const DEFAULT_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const TOKEN_URL = "https://auth.x.ai/oauth2/token";
const SCOPES =
  "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";

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

function readClientId(entryKey, entry) {
  if (entry?.oidc_client_id) return String(entry.oidc_client_id).trim();
  const parts = String(entryKey || "").split("::");
  return (parts.length > 1 ? parts[parts.length - 1] : "") || DEFAULT_CLIENT_ID;
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

async function ensureAccessToken(entryKey, entry, { forceRefresh = false } = {}) {
  let token = (entry.key || entry.access_token || "").trim();
  const exp = entry.expires_at ? Date.parse(entry.expires_at) : NaN;
  const nearExpiry = Number.isFinite(exp) && Date.now() > exp - 5 * 60 * 1000;
  if (forceRefresh || !token || nearExpiry) {
    try {
      const refreshed = await refreshToken(entryKey, entry);
      if (refreshed) return refreshed;
    } catch (e) {
      if (e.code === "invalid_grant") throw e;
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
    const sub = payload.sub || "";
    const clientId = pendingDevice.client_id;
    let entryKey = pendingDevice.reauthEntryKey;
    if (!entryKey) {
      entryKey = sub
        ? `https://auth.x.ai::${clientId}::${sub}`
        : `https://auth.x.ai::${clientId}`;
    }
    const prev = loadAccounts().accounts[entryKey] || {};
    const expiresIn = Number(data.expires_in) || 3600;
    const entry = {
      ...prev,
      key: data.access_token,
      refresh_token: data.refresh_token || prev.refresh_token,
      id_token: data.id_token || prev.id_token,
      expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
      oidc_client_id: clientId,
      email: payload.email || prev.email,
      tier: payload.tier != null ? payload.tier : prev.tier,
      labels: prev.labels || [],
      auth_mode: "oidc",
      create_time: prev.create_time || new Date().toISOString(),
    };
    upsertEntry(entryKey, entry);
    pendingDevice = null;
    return {
      state: "complete",
      message: "登录成功",
      entryKey,
      email: entry.email || null,
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
  ensureAccessToken,
  refreshToken,
  startDeviceLogin,
  pollDeviceLogin,
  cancelDeviceLogin,
};
