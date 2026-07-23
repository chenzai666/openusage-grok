/**
 * Grok dual-billing fetch + parse (CLI-aligned headers).
 * Credits: weekly % / productUsage; plain: monthly API limit.
 */
const fs = require("fs");
const path = require("path");
const { ensureAccessToken, decodeJwtPayload } = require("./grokAuth");
const { loadAccounts, upsertEntry, maskEmail, parseRenewalPaste } = require("./secureAccounts");
const { debugDir } = require("./paths");
const settings = require("./settings");
const { request } = require("./http");

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing";
const BILLING_CREDITS_URL = BILLING_URL + "?format=credits";
const SETTINGS_URL = "https://cli-chat-proxy.grok.com/v1/settings";
const CENTS_PER_DOLLAR = 100;
const CLIENT_VERSION = "0.2.93";

function billingHeaders(token) {
  return {
    Authorization: "Bearer " + token,
    "X-XAI-Token-Auth": "xai-grok-cli",
    "X-Grok-Client-Identifier": "grok-shell",
    "X-Grok-Client-Version": CLIENT_VERSION,
    Accept: "application/json",
    "User-Agent": "Grok CLI/" + CLIENT_VERSION,
  };
}

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function healthColor(percent) {
  if (percent >= 90) return "#ef4444";
  if (percent >= 70) return "#f59e0b";
  return "#22c55e";
}

function unitsValue(obj) {
  if (!obj || typeof obj !== "object") return null;
  const n = Number(obj.val);
  return Number.isFinite(n) ? n : null;
}

function formatResetShort(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return mm + "/" + dd + " " + hh + ":" + mi;
}

function findProduct(products, name) {
  if (!Array.isArray(products)) return null;
  return products.find((p) => p && p.product === name) || null;
}

function redactToken(s) {
  if (!s || typeof s !== "string") return s;
  if (s.length < 20) return "***";
  return s.slice(0, 8) + "…" + s.slice(-4);
}

function redactDeep(obj, depth = 0) {
  if (depth > 8 || obj == null) return obj;
  if (typeof obj === "string") {
    if (obj.startsWith("eyJ") || obj.length > 80) return redactToken(obj);
    return obj;
  }
  if (Array.isArray(obj)) return obj.map((x) => redactDeep(x, depth + 1));
  if (typeof obj === "object") {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (/token|authorization|secret|password|key/i.test(k) && typeof v === "string") {
        out[k] = redactToken(v);
      } else {
        out[k] = redactDeep(v, depth + 1);
      }
    }
    return out;
  }
  return obj;
}

function writeDebug(payload) {
  try {
    const p = path.join(debugDir(), "billing-last.json");
    fs.writeFileSync(p, JSON.stringify(redactDeep(payload), null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

async function fetchJson(url, token, { method = "GET", body } = {}) {
  const headers = billingHeaders(token);
  if (body) headers["Content-Type"] = "application/json";
  return request(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    timeoutMs: 20000,
  });
}

function parseBillingConfig(resp) {
  if (!resp || !resp.ok || !resp.data || !resp.data.config || typeof resp.data.config !== "object") {
    return null;
  }
  return resp.data.config;
}

function formatSubscriptionLine(entry) {
  let date =
    typeof entry.subscription_renews_at === "string" ? entry.subscription_renews_at.trim() : "";
  let method =
    typeof entry.subscription_payment_method === "string"
      ? entry.subscription_payment_method.trim()
      : "";
  if ((!date || !method) && typeof entry.subscription_paste === "string") {
    const parsed = parseRenewalPaste(entry.subscription_paste);
    if (parsed) {
      if (!date && parsed.date) date = parsed.date;
      if (!method && parsed.method) method = parsed.method;
    }
  }
  if (/^\d{4}-\d{2}-\d{2}/.test(date)) {
    const p = date.slice(0, 10).split("-");
    date = p[2] + "/" + p[1] + "/" + p[0];
  }
  if (!date && !method) return null;
  if (date && method) return date + " · " + method;
  return date || method;
}

function formatTierBadge(tier) {
  if (tier === null || tier === undefined || tier === "") return null;
  const n = Number(tier);
  const label = Number.isFinite(n) ? "tier " + String(n) : "tier " + String(tier);
  if (Number.isFinite(n) && n <= 1) {
    return { text: label, color: "#f59e0b" };
  }
  if (Number.isFinite(n) && n >= 2) {
    return { text: label, color: "#22c55e" };
  }
  return { text: label, color: "#a3a3a3" };
}

function emptyCard(base) {
  return {
    entryKey: "",
    title: "未命名",
    emailMasked: "未命名账号",
    labels: [],
    status: "警告",
    statusColor: "#f59e0b",
    tier: null,
    planName: null,
    planLine: "",
    refreshedAt: null,
    unifiedNote: null,
    probe: {
      ok: 0,
      fail: 0,
      billing: null,
      settings: null,
      chat: null,
      note: null,
      testedAt: null,
    },
    weeklyPercent: null,
    weeklyReset: null,
    buildText: "接口未返回 Build 字段",
    buildPercent: null,
    apiUsed: null,
    apiLimit: null,
    apiPercent: null,
    apiReset: null,
    onDemandText: "已用 -- · US$0.00 / --",
    payAsYouGo: "未启用",
    parseSummary: null,
    subscription: null,
    enabled: false,
    error: null,
    ...base,
  };
}

async function fetchOneAccount(entryKey, entry, { forceRefresh = false, runChat = false } = {}) {
  const email =
    (typeof entry.email === "string" && entry.email) ||
    (typeof entry.user_email === "string" && entry.user_email) ||
    "";
  const labels = Array.isArray(entry.labels)
    ? entry.labels.filter((x) => typeof x === "string" && x.trim())
    : [];
  const emailMasked = maskEmail(email);
  const title = labels.length > 0 ? labels[0] : emailMasked;
  const cfg = settings.load();
  const activeKey = cfg.activeEntryKey;
  const enabled = activeKey ? activeKey === entryKey : false;
  const nowLabel = formatResetShort(new Date().toISOString());

  const card = emptyCard({
    entryKey,
    title,
    emailMasked,
    labels,
    enabled,
    subscription: formatSubscriptionLine(entry),
    refreshedAt: nowLabel,
  });

  let token;
  try {
    token = await ensureAccessToken(entryKey, entry, { forceRefresh });
  } catch (e) {
    card.status = "需重新登录";
    card.statusColor = "#ef4444";
    card.error = e.code === "invalid_grant" ? "invalid_grant：请重新登录" : String(e.message || e);
    card.probe.note = card.error;
    return card;
  }

  // Re-load entry after possible refresh
  const freshEntry = loadAccounts().accounts[entryKey] || entry;

  async function getWithRetry(url) {
    let resp = await fetchJson(url, token);
    if (resp.status === 401 || resp.status === 403) {
      try {
        token = await ensureAccessToken(entryKey, loadAccounts().accounts[entryKey] || freshEntry, {
          forceRefresh: true,
        });
        resp = await fetchJson(url, token);
      } catch {
        /* keep first */
      }
    }
    return resp;
  }

  let creditsResp = await getWithRetry(BILLING_CREDITS_URL);
  if (creditsResp.status === 403) {
    try {
      token = await ensureAccessToken(entryKey, loadAccounts().accounts[entryKey] || freshEntry, {
        forceRefresh: true,
      });
      creditsResp = await fetchJson(BILLING_CREDITS_URL, token);
    } catch {
      /* keep */
    }
  }
  const monthlyResp = await getWithRetry(BILLING_URL);
  const settingsResp = await getWithRetry(SETTINGS_URL);

  let chatStatus = 0;
  if (runChat) {
    try {
      const chatResp = await fetchJson(
        "https://cli-chat-proxy.grok.com/v1/chat/completions",
        token,
        {
          method: "POST",
          body: {
            model: "grok-3",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          },
        }
      );
      chatStatus = chatResp.status;
    } catch {
      chatStatus = 0;
    }
  }

  const creditsOk = creditsResp.ok;
  const monthlyOk = monthlyResp.ok;
  const billingOk = creditsOk || monthlyOk;
  const billingCode = creditsOk
    ? creditsResp.status
    : monthlyOk
      ? monthlyResp.status
      : creditsResp.status || monthlyResp.status || 0;
  const settingsOk = settingsResp.ok;

  let okCount = 0;
  let failCount = 0;
  if (billingOk) okCount++;
  else failCount++;
  if (settingsOk) okCount++;
  else failCount++;
  if (runChat) {
    if (chatStatus >= 200 && chatStatus < 300) okCount++;
    else failCount++;
  }

  card.probe = {
    ok: okCount,
    fail: failCount,
    billing: { ok: billingOk, code: billingCode },
    settings: { ok: settingsOk, code: settingsResp.status || 0 },
    chat: runChat
      ? { ok: chatStatus >= 200 && chatStatus < 300, code: chatStatus }
      : null,
    note: null,
    testedAt: runChat ? "测试于 " + (nowLabel || "") + " · 仅手动触发" : null,
  };

  const jwt =
    decodeJwtPayload(token) ||
    decodeJwtPayload(freshEntry.id_token) ||
    {};
  const tier = jwt.tier != null ? jwt.tier : freshEntry.tier != null ? freshEntry.tier : null;
  card.tier = tier;
  const tierBadge = formatTierBadge(tier);

  if (settingsOk && settingsResp.data) {
    const plan =
      settingsResp.data.subscription_tier_display ||
      settingsResp.data.subscription_tier ||
      settingsResp.data.plan ||
      null;
    card.planName = plan;
  }
  const planPart = card.planName || "Grok";
  card.planLine = tierBadge ? tierBadge.text + " · " + planPart : planPart;

  if (runChat && chatStatus === 403) {
    card.probe.note =
      "只读可用，对话被拒 (HTTP 403)" +
      (tier != null ? " · JWT tier=" + String(tier) + "（社区反馈 tier=1 常被 gate）" : "");
  } else if (runChat && chatStatus >= 200 && chatStatus < 300) {
    card.probe.note = "只读 + 对话接口均可用";
  }

  const creditsConfig = parseBillingConfig(creditsResp);
  const monthlyConfig = parseBillingConfig(monthlyResp);

  writeDebug({
    at: new Date().toISOString(),
    entryKey,
    email: emailMasked,
    creditsStatus: creditsResp.status,
    monthlyStatus: monthlyResp.status,
    settingsStatus: settingsResp.status,
    credits: creditsConfig,
    monthly: monthlyConfig,
    settings: settingsResp.data,
  });

  if (!creditsConfig && !monthlyConfig) {
    card.status = "警告";
    card.statusColor = "#ef4444";
    card.error =
      billingCode === 403 || billingCode === 401
        ? "账单认证失败，请重新登录"
        : "账单不可用 (HTTP " + billingCode + ")";
    return card;
  }

  const products =
    creditsConfig && Array.isArray(creditsConfig.productUsage) ? creditsConfig.productUsage : [];
  const period = creditsConfig && creditsConfig.currentPeriod;
  const weeklyEnd =
    period && period.end ? period.end : creditsConfig && creditsConfig.billingPeriodEnd;
  const usagePercentRaw = creditsConfig ? Number(creditsConfig.creditUsagePercent) : NaN;
  const hasWeeklyPercent = Number.isFinite(usagePercentRaw);
  const weeklyPercent = hasWeeklyPercent ? clampPercent(usagePercentRaw) : null;
  const isUnified = !!(creditsConfig && creditsConfig.isUnifiedBillingUser === true);

  if (isUnified) {
    card.unifiedNote = hasWeeklyPercent
      ? "统一账单账号：周限百分比已返回"
      : "统一账单账号：周限百分比未返回；已显示 Build/API/月额度（若接口有）";
  }

  card.weeklyPercent = weeklyPercent;
  card.weeklyReset = weeklyEnd ? formatResetShort(weeklyEnd) : null;

  const build = findProduct(products, "GrokBuild");
  if (build && Number.isFinite(Number(build.usagePercent))) {
    card.buildPercent = clampPercent(Number(build.usagePercent));
    card.buildText = null;
  } else {
    card.buildPercent = null;
    card.buildText = "接口未返回 Build 字段";
  }

  if (monthlyConfig) {
    const usedUnits = unitsValue(monthlyConfig.used);
    const limitUnits = unitsValue(monthlyConfig.monthlyLimit);
    if (usedUnits !== null && limitUnits !== null && limitUnits > 0) {
      card.apiUsed = usedUnits;
      card.apiLimit = limitUnits;
      card.apiPercent = clampPercent((usedUnits / limitUnits) * 100);
      card.apiReset = monthlyConfig.billingPeriodEnd
        ? formatResetShort(monthlyConfig.billingPeriodEnd)
        : null;
    }
  }

  const onDemandUsedUnits =
    (creditsConfig && unitsValue(creditsConfig.onDemandUsed)) ??
    (monthlyConfig && unitsValue(monthlyConfig.onDemandUsed));
  const onDemandCapUnits =
    (creditsConfig && unitsValue(creditsConfig.onDemandCap)) ??
    (monthlyConfig && unitsValue(monthlyConfig.onDemandCap));

  const usedUsd =
    onDemandUsedUnits != null ? (onDemandUsedUnits / CENTS_PER_DOLLAR).toFixed(2) : "0.00";
  const capPart =
    onDemandCapUnits != null && onDemandCapUnits > 0
      ? "US$" + (onDemandCapUnits / CENTS_PER_DOLLAR).toFixed(2)
      : "--";
  card.onDemandText =
    "已用 -- · US$" + usedUsd + " / " + capPart +
    (card.weeklyReset ? " · 重置 " + card.weeklyReset : "");
  card.payAsYouGo =
    onDemandCapUnits != null && onDemandCapUnits > 0
      ? "上限 US$" + (onDemandCapUnits / CENTS_PER_DOLLAR).toFixed(2)
      : "未启用";

  const flags = [
    "周限" + (hasWeeklyPercent ? "✓" : "✗"),
    "Build" + (card.buildPercent != null ? "✓" : "✗"),
    "API" + (card.apiPercent != null ? "✓" : "✗"),
  ];
  card.parseSummary = "解析 " + flags.join(" · ") + " · 原始数据 %APPDATA%\\OpenUsageGrok\\debug\\";

  if (weeklyPercent != null && weeklyPercent >= 90) {
    card.status = "限制";
    card.statusColor = "#ef4444";
  } else if (!billingOk || (isUnified && !hasWeeklyPercent && card.apiPercent == null)) {
    card.status = "警告";
    card.statusColor = "#f59e0b";
  } else {
    card.status = "正常";
    card.statusColor = "#22c55e";
  }

  // Persist plan/tier if useful
  try {
    const patch = {};
    if (card.planName) patch.plan_name = card.planName;
    if (tier != null) patch.tier = tier;
    if (Object.keys(patch).length) upsertEntry(entryKey, { ...freshEntry, ...patch });
  } catch {
    /* ignore */
  }

  return card;
}

async function fetchAllUsage({ runChat = false } = {}) {
  const data = loadAccounts();
  const entries = Object.entries(data.accounts || {});
  const cfg = settings.load();
  let order = Array.isArray(cfg.accountOrder) ? cfg.accountOrder : [];
  const keySet = new Set(entries.map(([k]) => k));
  order = order.filter((k) => keySet.has(k));
  for (const [k] of entries) {
    if (!order.includes(k)) order.push(k);
  }

  const accounts = [];
  for (const key of order) {
    const entry = data.accounts[key];
    if (!entry) continue;
    try {
      const card = await fetchOneAccount(key, entry, { runChat });
      accounts.push(card);
    } catch (e) {
      accounts.push(
        emptyCard({
          entryKey: key,
          title: maskEmail(entry.email || entry.user_email || ""),
          emailMasked: maskEmail(entry.email || entry.user_email || ""),
          labels: entry.labels || [],
          status: "错误",
          statusColor: "#ef4444",
          error: String(e.message || e),
          enabled: cfg.activeEntryKey === key,
        })
      );
    }
  }

  // Ensure one active if missing
  if (accounts.length && !accounts.some((a) => a.enabled)) {
    accounts[0].enabled = true;
    if (!cfg.activeEntryKey) {
      settings.save({ activeEntryKey: accounts[0].entryKey });
    }
  }

  const tray =
    accounts.find((a) => a.enabled) ||
    accounts.find((a) => a.entryKey === cfg.activeEntryKey) ||
    accounts[0] ||
    null;

  return {
    v: 1,
    accounts,
    trayEntryKey: tray ? tray.entryKey : null,
    trayPercent: tray && tray.weeklyPercent != null ? tray.weeklyPercent : null,
    refreshedAt: new Date().toISOString(),
  };
}

module.exports = {
  billingHeaders,
  fetchOneAccount,
  fetchAllUsage,
  clampPercent,
  healthColor,
  formatResetShort,
  formatSubscriptionLine,
};
