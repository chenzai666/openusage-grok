/**
 * Import xAI / Grok credentials from CLIProxyAPI ("Cliproxy"):
 *   ~/.cli-proxy-api/xai-*.json  or pasted JSON from the management UI.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { decodeJwtPayload, DEFAULT_CLIENT_ID } = require("./grokAuth");

function defaultAuthDirs() {
  const home = os.homedir();
  return [
    path.join(home, ".cli-proxy-api"),
    path.join(home, ".cli-proxy-api", "auths"),
    path.join(home, ".cliproxy-api"),
    path.join(home, ".cliproxyapi"),
    path.join(home, "cli-proxy-api"),
    "C:\\cli-proxy-api",
    "D:\\cli-proxy-api",
    "D:\\CLIProxyAPI",
    "D:\\CLIProxyAPI\\auths",
    "D:\\cliproxy",
    "D:\\cliproxy\\auths",
  ];
}

function discoverDirs() {
  const found = [];
  const seen = new Set();
  for (const d of defaultAuthDirs()) {
    try {
      const resolved = path.resolve(d);
      if (seen.has(resolved)) continue;
      if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
        seen.add(resolved);
        found.push(resolved);
      }
    } catch {
      /* ignore */
    }
  }
  return found;
}

function looksLikeJwt(s) {
  return typeof s === "string" && /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(s.trim());
}

function pickToken(obj) {
  if (!obj || typeof obj !== "object") return "";
  const raw =
    obj.access_token ||
    obj.key ||
    obj.token ||
    obj.accessToken ||
    obj.AccessToken ||
    "";
  return String(raw || "")
    .replace(/^Bearer\s+/i, "")
    .trim();
}

function isXaiAuth(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return false;
  const type = String(obj.type || obj.auth_kind || obj.provider || obj.authKind || "")
    .toLowerCase()
    .replace(/[_-]/g, "");
  if (type === "xai" || type === "grok" || type === "xaioauth") return true;
  const token = pickToken(obj);
  if (!looksLikeJwt(token) && !looksLikeJwt(obj.id_token)) return false;
  const jwt = decodeJwtPayload(token) || decodeJwtPayload(obj.id_token) || {};
  const iss = String(jwt.iss || obj.oidc_issuer || obj.token_endpoint || "");
  if (/x\.ai/i.test(iss) || /auth\.x\.ai/i.test(iss)) return true;
  if (obj.refresh_token && (obj.email || obj.sub || jwt.email || jwt.sub)) return true;
  return false;
}

function toIsoExpiry(raw, jwt) {
  if (raw != null && raw !== "") {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      const ms = raw < 1e12 ? raw * 1000 : raw;
      return new Date(ms).toISOString();
    }
    const s = String(raw).trim();
    const parsed = Date.parse(s);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  if (jwt && jwt.exp) return new Date(Number(jwt.exp) * 1000).toISOString();
  return undefined;
}

function normalizeOne(raw) {
  if (!raw || typeof raw !== "object") return null;
  const token = pickToken(raw);
  if (!looksLikeJwt(token)) return null;
  const jwt = decodeJwtPayload(token) || decodeJwtPayload(raw.id_token) || {};
  const email = String(raw.email || raw.user_email || jwt.email || "").trim();
  const sub = String(raw.sub || raw.user_id || raw.subject || jwt.sub || "").trim();
  const clientId = String(
    raw.oidc_client_id || jwt.azp || jwt.client_id || DEFAULT_CLIENT_ID
  ).trim();
  const expires_at = toIsoExpiry(
    raw.expires_at || raw.expiry || raw.expired || raw.expire || raw.expiresAt,
    jwt
  );
  return {
    key: token,
    access_token: token,
    refresh_token: String(raw.refresh_token || raw.refresh || "").trim(),
    id_token: String(raw.id_token || "").trim(),
    expires_at,
    email,
    user_email: email,
    user_id: sub,
    sub,
    oidc_client_id: clientId || DEFAULT_CLIENT_ID,
    oidc_issuer: raw.oidc_issuer || jwt.iss || "https://auth.x.ai",
    auth_mode: "oidc",
    tier: raw.tier != null ? raw.tier : jwt.tier,
    source: "cliproxy-import",
  };
}

function collectFromValue(value, out, depth = 0) {
  if (value == null || depth > 6) return;
  if (typeof value === "string") {
    const t = value.trim();
    if (looksLikeJwt(t)) {
      const n = normalizeOne({ access_token: t });
      if (n) out.push(n);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectFromValue(item, out, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  const keys = Object.keys(value);
  const nestedAuthJson = keys.some(
    (k) => typeof k === "string" && k.includes("auth.x.ai") && value[k] && typeof value[k] === "object"
  );
  if (nestedAuthJson && !pickToken(value)) {
    for (const v of Object.values(value)) collectFromValue(v, out, depth + 1);
    return;
  }

  for (const nest of ["files", "auths", "accounts", "items", "data", "credentials"]) {
    if (value[nest] != null) collectFromValue(value[nest], out, depth + 1);
  }

  if (isXaiAuth(value) || pickToken(value)) {
    const n = normalizeOne(value);
    if (n) out.push(n);
  }
}

function dedupe(entries) {
  const seen = new Set();
  const out = [];
  for (const e of entries) {
    const id = (e.user_id || "") + "|" + (e.email || "").toLowerCase() + "|" + (e.key || "").slice(-12);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(e);
  }
  return out;
}

function parseText(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return { entries: [], error: "空内容" };
  if (looksLikeJwt(trimmed.replace(/^Bearer\s+/i, ""))) {
    const n = normalizeOne({ access_token: trimmed.replace(/^Bearer\s+/i, "") });
    return n
      ? { entries: [n], error: null }
      : { entries: [], error: "看起来是 JWT，但无法解析" };
  }
  try {
    const json = JSON.parse(trimmed);
    const entries = [];
    collectFromValue(json, entries);
    const unique = dedupe(entries);
    return {
      entries: unique,
      error: unique.length
        ? null
        : "JSON 里没有 xAI/Grok 凭证（需要 type=xai 或 access_token + refresh_token）",
    };
  } catch {
    return { entries: [], error: "不是合法 JSON。请粘贴 Cliproxy 的 xai-*.json 或导出内容。" };
  }
}

function scanDir(dir) {
  const resolved = dir ? path.resolve(String(dir)) : "";
  if (!resolved || !fs.existsSync(resolved)) {
    return { dir: resolved, files: [], entries: [], error: "目录不存在" };
  }
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch (e) {
    return { dir: resolved, files: [], entries: [], error: String(e.message || e) };
  }

  const files = [];
  const entries = [];
  const fileList = [];
  if (stat.isFile()) {
    fileList.push(resolved);
  } else if (stat.isDirectory()) {
    let names = [];
    try {
      names = fs.readdirSync(resolved);
    } catch (e) {
      return { dir: resolved, files: [], entries: [], error: String(e.message || e) };
    }
    for (const name of names) {
      if (!/\.json$/i.test(name)) continue;
      fileList.push(path.join(resolved, name));
    }
  }

  for (const fp of fileList) {
    try {
      const st = fs.statSync(fp);
      if (!st.isFile() || st.size > 2_000_000) continue;
      const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      const before = entries.length;
      collectFromValue(raw, entries);
      if (entries.length > before) files.push(path.basename(fp));
    } catch {
      /* skip bad file */
    }
  }

  return {
    dir: resolved,
    files,
    entries: dedupe(entries),
    error: null,
  };
}

function scanDefault() {
  const dirs = discoverDirs();
  const all = [];
  const files = [];
  const usedDirs = [];
  for (const d of dirs) {
    const r = scanDir(d);
    if (r.entries.length) {
      usedDirs.push(d);
      files.push(...r.files.map((f) => path.join(d, f)));
      all.push(...r.entries);
    }
  }
  return {
    dirs: usedDirs,
    discovered: dirs,
    files,
    entries: dedupe(all),
    error:
      dirs.length === 0
        ? "未找到 Cliproxy 目录（默认 %USERPROFILE%\\.cli-proxy-api）"
        : all.length
          ? null
          : "目录里没有可导入的 xAI 账号 JSON",
  };
}

module.exports = {
  defaultAuthDirs,
  discoverDirs,
  parseText,
  scanDir,
  scanDefault,
  normalizeOne,
};
