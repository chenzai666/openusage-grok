const fs = require("fs");
const path = require("path");
const os = require("os");
const { createHash, randomUUID } = require("crypto");

const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const RESET_URL = "https://chatgpt.com/backend-api/wham/rate-limit-reset-credits";
const MAX_BYTES = 1024 * 1024;
const MAX_ACCOUNTS = 20;
const hash = (value) => createHash("sha256").update(value).digest("hex");
const text = (obj, key) => typeof obj?.[key] === "string" ? obj[key].trim() : "";

function jwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString()); }
  catch { return {}; }
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") return null;
  const tokens = raw.tokens || raw;
  const access = text(tokens, "access_token");
  const claims = jwt(access);
  const id = jwt(tokens.id_token);
  const kind = text(raw, "type").toLowerCase();
  if (kind && kind !== "codex" && kind !== "chatgpt") return null;
  if (claims.iss && claims.iss !== "https://auth.openai.com") return null;
  if (!access || (!kind && !raw.tokens && !claims["https://api.openai.com/auth"])) return null;
  if (access.length > 65536 || /[\x00-\x20\x7f]/.test(access)) throw new Error("access_token 格式无效");
  const authClaims = claims["https://api.openai.com/auth"] || id["https://api.openai.com/auth"] || {};
  const accountId = text(tokens, "account_id") || text(authClaims, "chatgpt_account_id");
  const email = text(raw, "email") || text(id, "email") || text(claims["https://api.openai.com/profile"], "email");
  if (accountId.length > 512 || email.length > 254 || /[\x00-\x1f\x7f]/.test(accountId + email)) throw new Error("账号身份格式无效");
  const principal = text(claims, "sub") || text(id, "sub") || email.toLowerCase() || hash(access);
  const identity = hash(accountId + ":" + principal);
  // CLIProxy owns refresh-token rotation; keep only an encrypted access snapshot.
  return { entryKey: "chatgpt:" + identity, identity, accessToken: access, accountId, email, plan: text(raw, "plan_type"), source: "CLIProxy 导入" };
}

function parseDocuments(documents) {
  if (!Array.isArray(documents) || !documents.length || documents.length > 200) throw new Error("请选择 1–200 个账号 JSON 文件");
  const found = new Map();
  let nodes = 0;
  function collect(value, depth = 0) {
    if (++nodes > 10000 || depth > 8) throw new Error("JSON 嵌套过深或条目过多");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) collect(item, depth + 1); return; }
    const entry = normalize(value);
    if (entry) { found.set(entry.entryKey, entry); return; }
    for (const key of ["accounts", "auths", "files", "data", "items", "credentials"]) {
      if (value[key] && typeof value[key] === "object") collect(value[key], depth + 1);
    }
    // Auth exports can be keyed by filename instead of an accounts array.
    if (!value.access_token && !value.tokens) {
      for (const [key, child] of Object.entries(value)) {
        if (key.endsWith(".json") && child && typeof child === "object") collect(child, depth + 1);
      }
    }
    if (found.size > MAX_ACCOUNTS) throw new Error("最多支持 20 个 ChatGPT 账号");
  }
  let bytes = 0;
  for (const document of documents) {
    if (typeof document !== "string" || Buffer.byteLength(document) > MAX_BYTES) throw new Error("单个 JSON 文件不得超过 1 MiB");
    bytes += Buffer.byteLength(document);
    if (bytes > 8 * MAX_BYTES) throw new Error("本次导入内容超过 8 MiB");
    let value;
    try { value = JSON.parse(document.replace(/^\uFEFF/, "")); }
    catch { throw new Error("不是有效 JSON，请选择 CLIProxy 的 Codex 账号文件"); }
    collect(value);
  }
  if (found.size > MAX_ACCOUNTS) throw new Error("最多支持 20 个 ChatGPT 账号");
  if (!found.size) throw new Error("未发现 Codex OAuth 账号；config.yaml、API Key 或 xAI 文件不适用");
  return [...found.values()];
}

function maskEmail(email) {
  const at = String(email || "").indexOf("@");
  return at > 0 ? email.slice(0, Math.min(2, at)) + "***" + email.slice(at) : "ChatGPT 账号";
}

function planName(value) {
  const name = typeof value === "string" ? value.trim() : "";
  const known = { team: "Team", plus: "Plus", pro: "Pro", free: "Free", enterprise: "Enterprise", business: "Business", edu: "Edu", go: "Go" };
  return known[name.toLowerCase()] || name || "ChatGPT";
}

function primaryLimitLabel(window, plan) {
  const seconds = window?.limit_window_seconds;
  if (plan === "Free" && (!Number.isFinite(seconds) || seconds <= 0 || seconds === 30 * 24 * 3600)) return "月限额";
  if (!Number.isFinite(seconds) || seconds <= 0) return "5h限额";
  const hours = Math.floor(seconds / 3600);
  const minutes = (seconds % 3600) / 60;
  return `${hours ? hours + "h" : ""}${minutes ? minutes + "min" : ""}限额`;
}

function createService({ root, safeStorage, request, getShowFullEmails = () => false, localAuthPaths = () => process.env.CODEX_HOME?.trim()
  ? [path.join(process.env.CODEX_HOME.trim(), "auth.json")]
  : [path.join(os.homedir(), ".config", "codex", "auth.json"), path.join(os.homedir(), ".codex", "auth.json")] }) {
  const vaultPath = () => path.join(root(), "chatgpt-accounts.json");
  let refreshPromise = null;
  let mutating = false;
  let revision = 0;
  let lastUsage = null;

  function load() {
    if (!fs.existsSync(vaultPath())) return { v: 1, accounts: {}, deletedLocal: false, activeEntryKey: null, pendingResets: {} };
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows 凭据解密不可用");
    const stat = fs.statSync(vaultPath());
    if (stat.size > 12 * MAX_BYTES) throw new Error("ChatGPT 账号库超过大小限制");
    try {
      const envelope = JSON.parse(fs.readFileSync(vaultPath(), "utf8"));
      if (envelope.__openusage_enc !== "chatgpt-secure-v1" || typeof envelope.payload !== "string") throw new Error("format");
      const data = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, "base64")));
      if (data.v !== 1 || !data.accounts || !data.pendingResets) throw new Error("format");
      return data;
    } catch { throw new Error("ChatGPT 账号库无法解密或格式损坏；已保留原文件，请检查 Windows 用户"); }
  }

  function save(data) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("Windows DPAPI 不可用，已停止保存凭据");
    const payload = safeStorage.encryptString(JSON.stringify(data)).toString("base64");
    fs.mkdirSync(root(), { recursive: true });
    const temp = vaultPath() + ".tmp";
    fs.writeFileSync(temp, JSON.stringify({ __openusage_enc: "chatgpt-secure-v1", payload }), { mode: 0o600 });
    fs.renameSync(temp, vaultPath());
  }

  function localEntry() {
    for (const file of localAuthPaths()) {
      try {
        if (fs.statSync(file).size > MAX_BYTES) continue;
        const raw = JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
        if (!raw.tokens?.access_token) continue;
        const entry = normalize(raw);
        if (entry) return { ...entry, entryKey: "chatgpt:local", source: "本机 Codex（只读）" };
      } catch { /* try the next documented auth path */ }
    }
    return null;
  }

  function entries() {
    const data = load();
    const imported = Object.values(data.accounts);
    const local = !data.deletedLocal && localEntry();
    return local ? [local, ...imported] : imported;
  }

  function resolve(key) {
    const entry = entries().find((a) => a.entryKey === key);
    if (!entry) throw new Error("账号不存在或已移除，请刷新");
    return entry;
  }

  function displayFields(entry) {
    const emailDisplay = entry.email ? (getShowFullEmails() ? entry.email : maskEmail(entry.email)) : entry.entryKey === "chatgpt:local" ? "本机 Codex" : "ChatGPT 账号";
    return { emailDisplay, title: emailDisplay };
  }

  function currentDisplay(result) {
    if (!result) return null;
    const byKey = new Map(entries().map((entry) => [entry.entryKey, entry]));
    return { ...result, accounts: result.accounts.filter((card) => byKey.has(card.entryKey))
      .map((card) => ({ ...card, ...displayFields(byKey.get(card.entryKey)) })) };
  }

  function list() {
    const data = load();
    return entries().map((a) => ({ entryKey: a.entryKey, emailMasked: a.entryKey === "chatgpt:local" ? "本机 Codex" : maskEmail(a.email), ...displayFields(a), source: a.source, enabled: data.activeEntryKey === a.entryKey, labels: [], subscription: null }));
  }

  function importDocuments(documents) {
    const incoming = parseDocuments(documents);
    const data = load();
    const added = incoming.filter((a) => !Object.hasOwn(data.accounts, a.entryKey)).length;
    for (const a of incoming) data.accounts[a.entryKey] = a;
    if (Object.keys(data.accounts).length > MAX_ACCOUNTS) throw new Error("最多保存 20 个导入账号，请先移除不用的账号");
    if (!data.activeEntryKey) data.activeEntryKey = incoming[0].entryKey;
    save(data); revision++;
    return { added, updated: incoming.length - added, total: Object.keys(data.accounts).length, scanned: incoming.length };
  }

  function importPaths(paths) {
    if (!Array.isArray(paths) || paths.length > 200) throw new Error("文件数量超过限制");
    const documents = [];
    const seen = new Set();
    let bytes = 0;
    for (const candidate of paths) {
      const resolved = fs.realpathSync(candidate);
      const stat = fs.statSync(resolved);
      const files = stat.isDirectory() ? fs.readdirSync(resolved).filter((n) => n.toLowerCase().endsWith(".json")).map((n) => path.join(resolved, n)) : [resolved];
      for (const file of files) {
        if (seen.has(file)) continue;
        seen.add(file);
        const meta = fs.lstatSync(file);
        if (meta.isSymbolicLink() || !meta.isFile() || meta.size > MAX_BYTES) continue;
        if (seen.size > 200) throw new Error("扫描超过 200 个 JSON 文件，请选择更具体的目录");
        // Enforce the batch budget before reading, not after retaining every file.
        bytes += meta.size;
        if (bytes > 8 * MAX_BYTES) throw new Error("本次导入内容超过 8 MiB");
        const document = fs.readFileSync(file, "utf8");
        try { JSON.parse(document.replace(/^\uFEFF/, "")); } catch { continue; }
        documents.push(document);
      }
    }
    return importDocuments(documents);
  }

  function syncLocal({ force = false } = {}) {
    const local = localEntry();
    if (!local) throw new Error("本机未发现 Codex OAuth 登录；API Key 不提供订阅额度，请导入 CLIProxy Codex JSON");
    const data = load();
    if (force) data.deletedLocal = false;
    save(data); revision++;
    return { added: data.deletedLocal ? 0 : 1, total: entries().length, exists: true, cliCount: 1, path: "Codex OAuth 登录文件（只读）" };
  }

  function remove(key) {
    const data = load();
    if (key === "chatgpt:local") data.deletedLocal = true;
    else delete data.accounts[key];
    if (data.activeEntryKey === key) data.activeEntryKey = null;
    save(data); revision++;
    if (lastUsage) lastUsage.accounts = lastUsage.accounts.filter((a) => a.entryKey !== key);
    return true;
  }

  function setActive(key) {
    resolve(key);
    const data = load(); data.activeEntryKey = key; save(data); revision++;
    if (lastUsage) { lastUsage.accounts.forEach((a) => a.enabled = a.entryKey === key); lastUsage.trayEntryKey = key; lastUsage.trayPercent = lastUsage.accounts.find((a) => a.enabled)?.weeklyPercent ?? null; }
  }

  async function api(entry, url, body) {
    const headers = { Authorization: "Bearer " + entry.accessToken, Accept: "application/json", "User-Agent": "OpenUsage-Grok" };
    if (entry.accountId) headers["ChatGPT-Account-Id"] = entry.accountId;
    if (body) headers["Content-Type"] = "application/json";
    let response;
    try { response = await request(url, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body), timeoutMs: 12000, redirect: "error" }); }
    catch { throw new Error(body ? "重置结果待确认，请先刷新；再次操作会复用原请求编号" : "用量请求失败，请检查代理与网络"); }
    if (response.status === 401 || response.status === 403) throw new Error("凭据失效或权限不足，请重新导入最新 CLIProxy JSON / 登录 Codex");
    if (!response.ok) throw new Error("OpenAI 接口返回 HTTP " + response.status);
    if (!response.data || typeof response.data !== "object") throw new Error("OpenAI 接口响应格式异常");
    return response.data;
  }

  function clearAll() {
    const data = load(); data.accounts = {}; data.deletedLocal = true; data.activeEntryKey = null;
    save(data); revision++; lastUsage = null;
    return true;
  }

  async function fetchCard(entry) {
    const card = { provider: "chatgpt", entryKey: entry.entryKey, ...displayFields(entry), emailMasked: maskEmail(entry.email), source: entry.source, status: "查询失败", labels: [], metrics: [], weeklyPercent: null, resetCount: null, planName: null, refreshedAt: null };
    try {
      const data = await api(entry, USAGE_URL);
      card.planName = planName(text(data, "plan_type") || entry.plan);
      const add = (label, window) => {
        if (!window || typeof window.used_percent !== "number" || !Number.isFinite(window.used_percent)) return;
        const percent = Math.max(0, Math.min(100, window.used_percent));
        const resetMs = typeof window.reset_at === "number" ? window.reset_at * 1000 : null;
        const resetAt = resetMs != null && Number.isFinite(resetMs) && Math.abs(resetMs) < 8.64e15 ? new Date(resetMs).toISOString() : null;
        card.metrics.push({ label, percent, resetAt });
        if (label === "周限额") card.weeklyPercent = percent;
      };
      add(primaryLimitLabel(data.rate_limit?.primary_window, card.planName), data.rate_limit?.primary_window); add("周限额", data.rate_limit?.secondary_window);
      add("代码审查", data.code_review_rate_limit?.primary_window);
      for (const extra of (Array.isArray(data.additional_rate_limits) ? data.additional_rate_limits.slice(0, 20) : [])) {
        const label = typeof extra.limit_name === "string" ? extra.limit_name.slice(0, 80) : "模型";
        add(label, extra.rate_limit?.primary_window); add(label + " 周限", extra.rate_limit?.secondary_window);
      }
      const count = data.rate_limit_reset_credits?.available_count;
      if (Number.isSafeInteger(count) && count >= 0) card.resetCount = count;
      if (data.credits && data.credits.balance != null && ["number", "string"].includes(typeof data.credits.balance)) card.creditsText = String(data.credits.balance).slice(0, 80);
      card.status = card.metrics.some((m) => m.percent >= 100) ? "限制" : card.metrics.length ? "正常" : "暂无额度数据";
    } catch (e) { card.error = e.message; }
    card.refreshedAt = new Date().toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
    return card;
  }

  async function refresh() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const startRevision = revision;
      const all = entries(); const accounts = [];
      // Bound concurrency without coupling one account's failure to the rest.
      let index = 0;
      await Promise.all(Array.from({ length: Math.min(3, all.length) }, async () => {
        while (index < all.length) { const i = index++; accounts[i] = await fetchCard(all[i]); }
      }));
      if (revision !== startRevision) return null;
      const data = load();
      accounts.forEach((a, i) => { a.pendingReset = !!data.pendingResets[all[i].identity]; });
      const selected = accounts.find((a) => a.entryKey === data.activeEntryKey) || accounts[0];
      accounts.forEach((a) => { a.enabled = a === selected; });
      lastUsage = { v: 1, provider: "chatgpt", accounts, trayEntryKey: selected?.entryKey || null, trayPercent: selected?.weeklyPercent ?? null, refreshedAt: new Date().toISOString() };
      lastUsage = currentDisplay(lastUsage);
      return lastUsage;
    })().finally(() => { refreshPromise = null; });
    return refreshPromise;
  }

  async function consumeReset(key, confirm) {
    if (mutating) throw new Error("重置请求正在执行，请勿重复点击");
    mutating = true;
    try {
      let entry = resolve(key);
      let data = load();
      const pending = data.pendingResets[entry.identity];
      const details = await api(entry, RESET_URL);
      if (!Number.isSafeInteger(details.available_count) || details.available_count < 0) throw new Error("接口未返回有效的重置卡数量");
      if (!pending && details.available_count === 0) return { outcome: "no_credit", message: "没有可用的重置卡" };
      if (!await confirm({ title: entry.entryKey === "chatgpt:local" ? "本机 Codex" : maskEmail(entry.email), count: details.available_count, pending: !!pending })) return { outcome: "cancelled", message: "已取消" };
      const current = resolve(key);
      if (current.identity !== entry.identity) throw new Error("账号身份已变化，请重新确认");
      entry = current; data = load();
      const requestId = data.pendingResets[entry.identity] || randomUUID();
      data.pendingResets[entry.identity] = requestId; save(data);
      const result = await api(entry, RESET_URL + "/consume", { redeem_request_id: requestId });
      const messages = { reset: "额度重置成功，已使用 1 张重置卡", nothing_to_reset: "当前没有需要重置的额度", no_credit: "没有可用的重置卡", already_redeemed: "原重置请求已处理" };
      if (!Object.hasOwn(messages, result.code)) throw new Error("重置结果待确认；再次操作将复用原请求编号");
      data = load(); delete data.pendingResets[entry.identity]; save(data);
      return { outcome: result.code, message: messages[result.code] };
    } finally { mutating = false; }
  }

  return { list, importDocuments, importPaths, syncLocal, remove, clearAll, setActive, refresh, consumeReset,
    getLastUsage: () => currentDisplay(lastUsage), hasPending: (key) => !!load().pendingResets[resolve(key).identity] };
}

module.exports = { createService, normalize, parseDocuments, maskEmail, USAGE_URL, RESET_URL };
