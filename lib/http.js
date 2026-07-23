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

function envProxyUrl() {
  return (
    process.env.HTTPS_PROXY ||
    process.env.HTTP_PROXY ||
    process.env.https_proxy ||
    process.env.http_proxy ||
    process.env.ALL_PROXY ||
    process.env.all_proxy ||
    ""
  ).trim();
}

/**
 * Resolve effective proxy from app settings + env.
 * @returns {{ mode: string, url: string|null, bypass: string, source: string }}
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
  // auto: custom > env > system
  if (custom) return { mode: "fixed_servers", url: custom, bypass, source: "auto-custom" };
  if (env) return { mode: "fixed_servers", url: env, bypass, source: "auto-env" };
  return { mode: "system", url: null, bypass, source: "auto-system" };
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
    }
  } else if (resolved.mode === "direct") {
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
        });
      } else {
        resp = await fetch(url, {
          method,
          headers,
          body,
          signal: controller?.signal,
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
        "User-Agent": "Grok CLI/0.2.93",
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
