/**
 * HTTP helper: prefer Electron Chromium net (session proxy),
 * fall back to global fetch / undici ProxyAgent.
 */
const settings = require("./settings");

let electronNet = null;
try {
  electronNet = require("electron").net;
} catch {
  electronNet = null;
}

let proxyAgent = null;
let proxyAgentUrl = null;

const ENV_PROXY_NAMES = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "https_proxy",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/**
 * Read a single env var from Windows User/Machine registry (fresh),
 * so we do not stick to a stale process.env from app launch / last apply.
 */
function readWindowsEnvVar(name) {
  if (process.platform !== "win32") return "";
  const { execFileSync } = require("child_process");
  const keys = [
    "HKCU\\Environment",
    "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
  ];
  for (const key of keys) {
    try {
      const out = execFileSync("reg", ["query", key, "/v", name], {
        encoding: "utf8",
        timeout: 2000,
        windowsHide: true,
      });
      const lines = String(out).split(/\r?\n/);
      for (const line of lines) {
        // e.g. "    HTTP_PROXY    REG_SZ    http://127.0.0.1:2080"
        const m = line.match(new RegExp(String.raw`^\s*${name}\s+REG_\w+\s+(.+)$`, "i"));
        if (m) return m[1].trim();
      }
    } catch {
      /* missing value */
    }
  }
  return "";
}

function envProxyUrl() {
  // Prefer fresh Windows registry values over process.env. We used to copy the
  // resolved proxy back into process.env, so after switching proxy software /
  // ports the UI kept showing the old port (e.g. 10808) until restart.
  if (process.platform === "win32") {
    for (const name of ENV_PROXY_NAMES) {
      const v = readWindowsEnvVar(name);
      if (v) return v;
    }
  }
  for (const name of ENV_PROXY_NAMES) {
    const v = (process.env[name] || "").trim();
    if (v) return v;
  }
  return "";
}

function parseProxyHostPort(url) {
  try {
    let raw = String(url || "").trim();
    if (!raw) return null;
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = "http://" + raw;
    raw = raw.replace(/^socks5h:/i, "socks5:");
    const u = new URL(raw);
    const port = Number(u.port) || (/^socks/i.test(u.protocol) ? 1080 : 80);
    if (!u.hostname || !Number.isFinite(port) || port <= 0) return null;
    return { host: u.hostname, port };
  } catch {
    return null;
  }
}

function isLoopbackHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "0.0.0.0";
}

/** Cache local port probes so auto-resolve stays cheap. */
const _portProbeCache = new Map(); // key -> { ok, at }

function isLocalProxyListening(url, timeoutMs = 350) {
  const hp = parseProxyHostPort(url);
  if (!hp) return true; // can't parse — don't block
  if (!isLoopbackHost(hp.host)) return true; // only probe loopback

  const key = hp.host + ":" + hp.port;
  const now = Date.now();
  const hit = _portProbeCache.get(key);
  if (hit && now - hit.at < 5000) return hit.ok;

  let ok = false;
  try {
    const { spawnSync } = require("child_process");
    const script =
      "const n=require('net');const s=n.connect(" +
      hp.port +
      "," +
      JSON.stringify(hp.host) +
      ",()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(1));s.setTimeout(" +
      timeoutMs +
      ",()=>{s.destroy();process.exit(1)});";
    const r = spawnSync(process.execPath, ["-e", script], {
      timeout: timeoutMs + 400,
      windowsHide: true,
      stdio: "ignore",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    });
    ok = r.status === 0;
  } catch {
    ok = false;
  }
  _portProbeCache.set(key, { ok, at: now });
  return ok;
}

/**
 * Pick first usable URL in auto cascade. Dead local env ports are skipped
 * so we fall through to system proxy (e.g. old 10808 after switching apps).
 */
function pickAutoProxy(custom, env, bypass) {
  if (custom) {
    if (isLocalProxyListening(custom)) {
      return { mode: "fixed_servers", url: custom, bypass, source: "auto-custom" };
    }
    // local custom dead → keep trying env/system
  }
  if (env) {
    if (isLocalProxyListening(env)) {
      return { mode: "fixed_servers", url: env, bypass, source: "auto-env" };
    }
    return {
      mode: "system",
      url: null,
      bypass,
      source: "auto-system",
      skippedEnv: env,
      note: "环境变量代理不可达，已改用系统代理",
    };
  }
  return { mode: "system", url: null, bypass, source: "auto-system" };
}

/**
 * Resolve effective proxy from app settings + env.
 * @returns {{ mode: string, url: string|null, bypass: string, source: string, skippedEnv?: string, note?: string }}
 */
function resolveProxy() {
  const cfg = settings.load();
  const mode = cfg.proxyMode || "auto";
  const bypass = (cfg.proxyBypass || "localhost,127.0.0.1,<local>").trim();
  const custom = (cfg.proxyUrl || "").trim();
  const env = envProxyUrl();

  if (mode === "direct") {
    return { mode: "direct", url: null, bypass, source: "direct" };
  }
  if (mode === "custom") {
    if (custom) return { mode: "fixed_servers", url: custom, bypass, source: "custom" };
    return { mode: "direct", url: null, bypass, source: "custom-empty" };
  }
  if (mode === "env") {
    if (env) return { mode: "fixed_servers", url: env, bypass, source: "env" };
    return { mode: "direct", url: null, bypass, source: "env-empty" };
  }
  if (mode === "system") {
    return { mode: "system", url: null, bypass, source: "system" };
  }
  // auto: custom → env → system (skip unreachable local ports)
  return pickAutoProxy(custom, env, bypass);
}

function syncProcessEnvProxy(resolved) {
  if (resolved.url) {
    process.env.HTTP_PROXY = resolved.url;
    process.env.HTTPS_PROXY = resolved.url;
    process.env.http_proxy = resolved.url;
    process.env.https_proxy = resolved.url;
    if (/^socks/i.test(resolved.url)) {
      process.env.ALL_PROXY = resolved.url;
      process.env.all_proxy = resolved.url;
    } else {
      // Avoid leaving a stale socks ALL_PROXY when switching to http://
      delete process.env.ALL_PROXY;
      delete process.env.all_proxy;
    }
  } else {
    // system / direct / empty — clear sticky ports from a previous apply
    delete process.env.HTTP_PROXY;
    delete process.env.HTTPS_PROXY;
    delete process.env.http_proxy;
    delete process.env.https_proxy;
    delete process.env.ALL_PROXY;
    delete process.env.all_proxy;
  }
  // reset undici agent cache
  proxyAgent = null;
  proxyAgentUrl = null;
}

/**
 * Apply proxy to Electron session (and process env for undici fallback).
 * @param {Electron.Session} [sess]
 */
async function applySessionProxy(sess) {
  const resolved = resolveProxy();
  syncProcessEnvProxy(resolved);

  if (!sess) {
    try {
      sess = require("electron").session.defaultSession;
    } catch {
      return resolved;
    }
  }

  try {
    if (resolved.mode === "direct") {
      await sess.setProxy({ mode: "direct" });
    } else if (resolved.mode === "system") {
      await sess.setProxy({ mode: "system" });
    } else if (resolved.url) {
      await sess.setProxy({
        proxyRules: resolved.url,
        proxyBypassRules: resolved.bypass,
      });
    } else {
      await sess.setProxy({ mode: "system" });
    }
    console.log("[proxy]", resolved.source, resolved.url || resolved.mode);
  } catch (e) {
    console.error("[proxy] setProxy failed", e);
  }
  return resolved;
}

function getProxyAgent() {
  const resolved = resolveProxy();
  const url = resolved.url;
  if (!url) return null;
  if (proxyAgent && proxyAgentUrl === url) return proxyAgent;
  try {
    const { ProxyAgent, fetch: undiciFetch } = require("undici");
    proxyAgent = new ProxyAgent(url);
    proxyAgentUrl = url;
    proxyAgent._undiciFetch = undiciFetch;
    return proxyAgent;
  } catch {
    return null;
  }
}

/**
 * @param {string} url
 * @param {{ method?: string, headers?: Record<string,string>, body?: string, timeoutMs?: number }} opts
 */
async function request(url, opts = {}) {
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  const body = opts.body;
  const timeoutMs = opts.timeoutMs || 20000;

  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    let resp;
    if (electronNet && typeof electronNet.fetch === "function") {
      resp = await electronNet.fetch(url, {
        method,
        headers,
        body,
        signal: controller?.signal,
        redirect: opts.redirect || "follow",
      });
    } else {
      const agent = getProxyAgent();
      if (agent && agent._undiciFetch) {
        resp = await agent._undiciFetch(url, {
          method,
          headers,
          body,
          dispatcher: agent,
          signal: controller?.signal,
          redirect: opts.redirect || "follow",
        });
      } else {
        resp = await fetch(url, {
          method,
          headers,
          body,
          signal: controller?.signal,
          redirect: opts.redirect || "follow",
        });
      }
    }

    const text = await resp.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return {
      status: resp.status,
      ok: resp.status >= 200 && resp.status < 300,
      text,
      data,
    };
  } catch (e) {
    const msg = e.name === "AbortError" ? `请求超时 (${timeoutMs}ms)` : String(e.message || e);
    const err = new Error(msg);
    err.cause = e.cause || e;
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Probe connectivity through current proxy config. */
async function testProxyConnectivity() {
  const resolved = resolveProxy();
  const started = Date.now();
  try {
    // auth.x.ai often returns 403 without path; any HTTP response means proxy works
    const resp = await request("https://cli-chat-proxy.grok.com/v1/settings", {
      method: "GET",
      headers: {
        Accept: "application/json",
        "User-Agent": "Grok CLI/1.0.5",
      },
      timeoutMs: 15000,
    });
    return {
      ok: true,
      status: resp.status,
      ms: Date.now() - started,
      resolved,
      message:
        resp.status === 401 || resp.status === 403
          ? `代理可达（HTTP ${resp.status}，未带 token 属正常）`
          : `连通成功 HTTP ${resp.status}`,
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      resolved,
      message: String(e.message || e),
    };
  }
}

module.exports = {
  request,
  envProxyUrl,
  resolveProxy,
  applySessionProxy,
  testProxyConnectivity,
  syncProcessEnvProxy,
};
