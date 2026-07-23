/* global openusage */
(() => {
  const $ = (sel, el = document) => el.querySelector(sel);
  const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

  const state = {
    view: "home",
    usage: null,
    accounts: [],
    settings: null,
    fullscreen: false,
    loginInfo: null,
    dragKey: null,
    reauthKey: null,
  };

  function esc(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function applyTheme(shouldDark) {
    document.documentElement.classList.toggle("light", !shouldDark);
  }

  function setView(name) {
    state.view = name;
    $("#view-home").hidden = name !== "home";
    $("#view-settings").hidden = name !== "settings";
    $("#view-login").hidden = name !== "login";
    $$(".nav-item").forEach((b) => {
      b.classList.toggle("active", b.dataset.view === name);
    });
  }

  function formatTime(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "—";
    const pad = (n) => String(n).padStart(2, "0");
    return `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function healthDotsHtml(percent) {
    const total = 18;
    const pct =
      percent == null || !Number.isFinite(percent)
        ? null
        : Math.max(0, Math.min(100, percent));
    const filled =
      pct == null ? 0 : pct >= 100 ? 0 : Math.max(1, Math.round(((100 - pct) / 100) * total));
    let dots = "";
    for (let i = 0; i < total; i++) {
      dots += `<span class="${i < filled ? "on" : ""}"></span>`;
    }
    const label = pct == null ? "—" : Math.round(pct) + "%";
    return `<div class="health">
      <span class="health-label">健康状态（周限）</span>
      <div class="health-dots">${dots}</div>
      <span class="health-pct">${esc(label)}</span>
    </div>`;
  }

  function thinBar(percent) {
    if (percent == null || !Number.isFinite(percent)) return "";
    const p = Math.max(0, Math.min(100, percent));
    return `<div class="thin-bar"><i style="width:${p}%"></i></div>`;
  }

  function metric(label, value, barPercent, muted) {
    return `<div class="metric">
      <div class="metric-row">
        <span class="metric-label">${esc(label)}</span>
        <span class="metric-value${muted ? " muted" : ""}" title="${esc(value)}">${esc(value)}</span>
      </div>
      ${barPercent != null ? thinBar(barPercent) : ""}
    </div>`;
  }

  function statusClass(status) {
    if (status === "正常") return "status-ok";
    if (status === "限制" || status === "需重新登录" || status === "错误") return "status-bad";
    return "status-warn";
  }

  function probeHtml(probe) {
    if (!probe || (!probe.billing && !probe.settings && !probe.chat && !probe.testedAt)) {
      return "";
    }
    const tags = [];
    if (probe.billing) {
      tags.push(
        `<span class="ptag ${probe.billing.ok ? "ok" : "bad"}">billing ${probe.billing.ok ? "✓" : "✗"} ${probe.billing.code || ""}</span>`
      );
    }
    if (probe.settings) {
      tags.push(
        `<span class="ptag ${probe.settings.ok ? "ok" : "bad"}">settings ${probe.settings.ok ? "✓" : "✗"} ${probe.settings.code || ""}</span>`
      );
    }
    if (probe.chat) {
      tags.push(
        `<span class="ptag ${probe.chat.ok ? "ok" : "bad"}">chat ${probe.chat.ok ? "✓" : "✗"} ${probe.chat.code || ""}</span>`
      );
    }
    return `<div class="probe-box">
      <div class="probe-counts">
        <span class="chip ok">成功 ${probe.ok ?? 0}</span>
        <span class="chip fail">失败 ${probe.fail ?? 0}</span>
      </div>
      <div class="probe-tags">${tags.join("")}</div>
      ${probe.note ? `<div class="probe-note">${esc(probe.note)}</div>` : ""}
      ${probe.testedAt ? `<div class="probe-time">${esc(probe.testedAt)}</div>` : ""}
    </div>`;
  }

  function renderCard(acc) {
    const tags = (acc.labels || [])
      .map((t) => `<span class="badge tag">${esc(t)}</span>`)
      .join("");
    const dateChip = acc.subscription
      ? acc.subscription.split("·")[0]?.trim()
      : null;
    const weeklyVal =
      acc.weeklyPercent != null
        ? `已用 ${Math.round(acc.weeklyPercent)}%` +
          (acc.weeklyReset ? ` · 重置 ${acc.weeklyReset}` : "")
        : "无周额度数据";
    const buildVal =
      acc.buildPercent != null
        ? `已用 ${Math.round(acc.buildPercent)}%`
        : acc.buildText || "接口未返回 Build 字段";
    const apiVal =
      acc.apiUsed != null && acc.apiLimit != null
        ? `已用 ${Math.round(acc.apiPercent || 0)}% · ${acc.apiUsed} / ${acc.apiLimit}` +
          (acc.apiReset ? ` · 重置 ${acc.apiReset}` : "")
        : "接口未返回 API 字段";
    const planLine =
      (acc.planLine || "Grok") + (acc.refreshedAt ? " · 刷新 " + acc.refreshedAt : "");

    return `<article class="acc-card" data-key="${esc(acc.entryKey)}">
      <div class="card-head">
        <input type="checkbox" class="tray-check" data-act="enable" title="设为托盘账号" ${acc.enabled ? "checked" : ""} />
        <div class="avatar">xAI</div>
        <div class="head-main">
          <div class="head-row">
            <span class="badge xai">xAI</span>
            <span class="badge ${statusClass(acc.status)}">${esc(acc.status || "—")}</span>
            ${tags}
            ${dateChip ? `<span class="badge tag">${esc(dateChip)}</span>` : ""}
          </div>
          <div class="card-title">${esc(acc.title || acc.emailMasked)}</div>
          <div class="email-blur">${esc(acc.emailMasked || "")}</div>
          <div class="plan-line">${esc(planLine)}</div>
          ${acc.unifiedNote ? `<div class="unified-note">ⓘ ${esc(acc.unifiedNote)}</div>` : ""}
          ${acc.error ? `<div class="unified-note">${esc(acc.error)}</div>` : ""}
          ${probeHtml(acc.probe)}
        </div>
      </div>
      ${healthDotsHtml(acc.weeklyPercent)}
      ${metric("周限额", weeklyVal, acc.weeklyPercent, acc.weeklyPercent == null)}
      ${metric("Build 用量", buildVal, acc.buildPercent, acc.buildPercent == null)}
      ${metric("API 月额度", apiVal, acc.apiPercent, acc.apiPercent == null)}
      ${metric("按量已用", acc.onDemandText || "已用 -- · US$0.00 / --", null, false)}
      <div class="footer-meta">
        <span title="${esc(acc.parseSummary || "")}">${esc(acc.parseSummary || "")}</span>
      </div>
      <div class="footer-meta">
        <span>按量付费</span>
        <span>${esc(acc.payAsYouGo || "未启用")}</span>
      </div>
      ${
        acc.subscription
          ? `<div class="footer-meta"><span>到期/续费</span><span>${esc(acc.subscription)}</span></div>`
          : ""
      }
      <div class="card-actions">
        <button type="button" class="act-btn wide" data-act="test" title="API 测试">◎ 测试</button>
        <button type="button" class="act-btn" data-act="reauth" title="重新登录">↻</button>
        <button type="button" class="act-btn" data-act="edit" title="设置">⚙</button>
        <button type="button" class="act-btn danger" data-act="delete" title="删除">🗑</button>
        <span class="spacer"></span>
        <label class="toggle" title="设为托盘账号">
          <span>启用</span>
          <input type="checkbox" data-act="enable" ${acc.enabled ? "checked" : ""} />
        </label>
      </div>
    </article>`;
  }

  function renderHomeToolbar() {
    const list = state.usage?.accounts || [];
    const bar = $("#home-toolbar");
    if (!list.length) {
      bar.hidden = true;
      return;
    }
    bar.hidden = false;
    const ok = list.filter((a) => a.status === "正常").length;
    const warn = list.length - ok;
    const at = state.usage?.refreshedAt;
    const mins = state.settings?.refreshMinutes || 5;
    let next = "—";
    if (at) {
      next = formatTime(new Date(new Date(at).getTime() + mins * 60 * 1000).toISOString());
    }
    $("#home-toolbar-meta").innerHTML =
      `<strong>${list.length} 账号</strong> · 正常 ${ok} / 异常 ${warn}` +
      ` · 上次 ${formatTime(at)} · 下次 ${next}`;
    $("#btn-home-fullscreen").textContent = state.fullscreen ? "退出全屏" : "全屏";
  }

  function renderCards() {
    const list = state.usage?.accounts || [];
    const empty = $("#empty-state");
    const grid = $("#cards");
    renderHomeToolbar();
    if (!list.length) {
      empty.hidden = false;
      grid.innerHTML = "";
      grid.className = "cards-grid";
      return;
    }
    empty.hidden = true;
    grid.className =
      "cards-grid" +
      (list.length >= 3 ? " cols-3" : list.length >= 2 ? " cols-2" : "");
    grid.innerHTML = list.map(renderCard).join("");
  }

  function renderAccountList() {
    const host = $("#account-list");
    const list = state.accounts || [];
    if (!list.length) {
      host.innerHTML = `<p class="muted">暂无账号。可添加或从 Grok CLI 导入。</p>`;
      return;
    }
    host.innerHTML = list
      .map(
        (a) => `<div class="acc-row" draggable="true" data-key="${esc(a.entryKey)}">
        <span class="handle" title="拖拽排序">⠿</span>
        <div class="info">
          <div class="name">${esc(a.labels?.[0] || a.emailMasked || "未命名")}</div>
          <div class="sub">${esc(a.emailMasked || "")}${a.subscription ? " · " + esc(a.subscription) : ""}</div>
          <div class="tags">${(a.labels || []).map((t) => `<span class="badge tag">${esc(t)}</span>`).join("")}</div>
        </div>
        <button type="button" class="btn sm" data-act="edit-acc">编辑</button>
        <button type="button" class="btn sm danger" data-act="del-acc">删除</button>
      </div>`
      )
      .join("");
    bindDrag();
  }

  function bindDrag() {
    const rows = $$(".acc-row");
    rows.forEach((row) => {
      row.addEventListener("dragstart", (e) => {
        // only from handle or name
        state.dragKey = row.dataset.key;
        row.classList.add("dragging");
        e.dataTransfer.effectAllowed = "move";
      });
      row.addEventListener("dragend", () => {
        row.classList.remove("dragging");
        state.dragKey = null;
        $$(".drop-line").forEach((n) => n.remove());
      });
      row.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      });
      row.addEventListener("drop", async (e) => {
        e.preventDefault();
        const from = state.dragKey;
        const to = row.dataset.key;
        if (!from || !to || from === to) return;
        const keys = state.accounts.map((a) => a.entryKey);
        const fi = keys.indexOf(from);
        const ti = keys.indexOf(to);
        if (fi < 0 || ti < 0) return;
        keys.splice(fi, 1);
        keys.splice(ti, 0, from);
        await openusage.reorderAccounts(keys);
        await reloadAccounts();
        await openusage.refreshUsage();
      });
    });
  }

  async function reloadAccounts() {
    state.accounts = await openusage.listAccounts();
    $("#account-count").textContent = `${state.accounts.length} 账号`;
    renderAccountList();
  }

  function formatProxyStatus(proxy) {
    if (!proxy) return "代理：未知";
    const url = proxy.url || "—";
    const map = {
      direct: "直连",
      system: "系统代理",
      "auto-custom": "自动·自定义",
      "auto-env": "自动·环境变量",
      "auto-system": "自动·系统",
      custom: "自定义",
      "custom-empty": "自定义（未填地址→直连）",
      env: "环境变量",
      "env-empty": "环境变量（空→直连）",
    };
    const label = map[proxy.source] || proxy.source || proxy.mode;
    return `当前生效：${label}${proxy.url ? " · " + proxy.url : ""}`;
  }

  async function reloadProxyStatus() {
    try {
      const p = await openusage.getProxyStatus();
      $("#proxy-status").textContent = formatProxyStatus(p);
    } catch {
      $("#proxy-status").textContent = "代理：读取失败";
    }
  }

  async function reloadSettings() {
    state.settings = await openusage.getSettings();
    const st = await openusage.getStatus();
    $("#set-theme").value = state.settings.theme || "system";
    $("#set-refresh").value = String(state.settings.refreshMinutes || 5);
    $("#set-login-item").checked = !!state.settings.launchAtLogin;
    $("#set-tray-pct").checked = state.settings.trayShowPercent !== false;
    $("#set-proxy-mode").value = state.settings.proxyMode || "auto";
    $("#set-proxy-url").value = state.settings.proxyUrl || "";
    $("#set-proxy-bypass").value =
      state.settings.proxyBypass || "localhost,127.0.0.1,<local>";
    $("#encrypt-status").textContent = st.encrypted
      ? "账号库：Windows DPAPI (safeStorage) 已加密"
      : "账号库：当前环境未启用加密（明文 envelope）";
    $("#about-version").textContent = `OpenUsage Grok v${st.version || "?"}`;
    applyTheme(st.dark);
    await reloadProxyStatus();
  }

  function updateRefreshMeta() {
    const at = state.usage?.refreshedAt;
    const mins = state.settings?.refreshMinutes || 5;
    let next = "";
    if (at) {
      const t = new Date(at).getTime() + mins * 60 * 1000;
      next = " · 下次 " + formatTime(new Date(t).toISOString());
    }
    $("#refresh-meta").textContent = at ? `上次 ${formatTime(at)}${next}` : "";
  }

  async function openEditModal(entryKey) {
    const acc = state.accounts.find((a) => a.entryKey === entryKey);
    if (!acc) return;
    $("#modal-entry-key").value = entryKey;
    $("#modal-title").textContent = "账号设置 · " + (acc.emailMasked || "");
    $("#modal-labels").value = (acc.labels || []).join(", ");
    $("#modal-sub-paste").value = acc.subscription_paste || "";
    $("#modal-sub-preview").textContent = acc.subscription
      ? "当前：" + acc.subscription
      : "粘贴续费文案后自动解析为 dd/mm/YYYY · 支付方式";
    $("#modal-account").showModal();
  }

  // Events
  $("#btn-hide").addEventListener("click", () => openusage.hidePanel());
  $("#btn-fullscreen").addEventListener("click", async () => {
    const on = await openusage.toggleFullscreen();
    document.getElementById("app").classList.toggle("fullscreen", on);
    $("#side-nav").hidden = !on;
    state.fullscreen = on;
  });
  $("#btn-settings").addEventListener("click", () => setView("settings"));
  $("#btn-home-settings").addEventListener("click", () => setView("settings"));
  async function doRefresh() {
    $("#btn-refresh").disabled = true;
    $("#btn-home-refresh").disabled = true;
    try {
      await openusage.refreshUsage();
    } finally {
      $("#btn-refresh").disabled = false;
      $("#btn-home-refresh").disabled = false;
    }
  }
  async function doTestAll() {
    $("#btn-test-all").disabled = true;
    $("#btn-home-test").disabled = true;
    try {
      await openusage.testAllApis();
    } finally {
      $("#btn-test-all").disabled = false;
      $("#btn-home-test").disabled = false;
    }
  }
  $("#btn-refresh").addEventListener("click", doRefresh);
  $("#btn-home-refresh").addEventListener("click", doRefresh);
  $("#btn-test-all").addEventListener("click", doTestAll);
  $("#btn-home-test").addEventListener("click", doTestAll);
  $("#btn-home-fullscreen").addEventListener("click", () => $("#btn-fullscreen").click());
  $("#btn-settings-test-all").addEventListener("click", doTestAll);
  $("#btn-settings-add").addEventListener("click", () => {
    state.reauthKey = null;
    setView("login");
  });
  $("#btn-empty-login").addEventListener("click", () => setView("login"));
  $("#btn-logout-all").addEventListener("click", async () => {
    if (!confirm("确定退出并删除全部本地账号？")) return;
    await openusage.logoutAll();
    await reloadAccounts();
    setView("login");
  });

  $$(".nav-item").forEach((b) => {
    b.addEventListener("click", () => {
      state.reauthKey = null;
      setView(b.dataset.view);
    });
  });

  // Login
  async function startLogin() {
    $("#login-error").hidden = true;
    try {
      const info = await openusage.startBrowserLogin({
        reauthEntryKey: state.reauthKey || null,
      });
      state.loginInfo = info;
      $("#login-idle").hidden = true;
      $("#login-pending").hidden = false;
      $("#user-code").textContent = info.userCode || "—";
      $("#verify-uri").textContent = info.verificationUri || "https://auth.x.ai/device";
      $("#login-status").textContent = "链接已复制 · 等待浏览器授权…";
    } catch (e) {
      $("#login-error").hidden = false;
      $("#login-error").textContent = String(e.message || e);
    }
  }
  $("#btn-start-login").addEventListener("click", startLogin);
  $("#btn-cancel-login").addEventListener("click", async () => {
    await openusage.cancelLogin();
    $("#login-idle").hidden = false;
    $("#login-pending").hidden = true;
    state.reauthKey = null;
  });
  $("#btn-copy-link").addEventListener("click", async () => {
    const url = state.loginInfo?.copyUrl || state.loginInfo?.verificationUriComplete;
    if (url) await openusage.copyText(url);
    $("#login-status").textContent = "链接已复制到剪贴板";
  });
  $("#btn-import-cli").addEventListener("click", async () => {
    const n = await openusage.softImportCli();
    alert(n > 0 ? `已导入 ${n} 个账号` : "没有可导入的新账号");
    await reloadAccounts();
    if (n > 0) setView("home");
  });

  // Cards actions
  $("#cards").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const card = e.target.closest(".acc-card");
    if (!card) return;
    const key = card.dataset.key;
    const act = btn.dataset.act;
    if (act === "test") {
      btn.disabled = true;
      try {
        await openusage.testAccountApi(key);
      } finally {
        btn.disabled = false;
      }
    } else if (act === "reauth") {
      state.reauthKey = key;
      setView("login");
      startLogin();
    } else if (act === "edit") {
      await reloadAccounts();
      openEditModal(key);
    } else if (act === "delete") {
      if (!confirm("删除该账号？")) return;
      await openusage.removeAccount(key);
      await reloadAccounts();
    } else if (act === "enable") {
      const on = btn.checked;
      if (on) await openusage.setActiveAccount(key);
    }
  });
  $("#cards").addEventListener("change", async (e) => {
    if (e.target.matches('input[data-act="enable"]')) {
      const card = e.target.closest(".acc-card");
      if (!card) return;
      if (e.target.checked) await openusage.setActiveAccount(card.dataset.key);
    }
  });

  // Account list actions
  $("#account-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const row = e.target.closest(".acc-row");
    if (!row) return;
    const key = row.dataset.key;
    if (btn.dataset.act === "edit-acc") openEditModal(key);
    if (btn.dataset.act === "del-acc") {
      if (!confirm("删除该账号？")) return;
      await openusage.removeAccount(key);
      await reloadAccounts();
    }
  });

  // Modal save
  $("#form-account").addEventListener("submit", async (e) => {
    const submitter = e.submitter;
    if (submitter && submitter.value === "cancel") return;
    e.preventDefault();
    const key = $("#modal-entry-key").value;
    const labels = $("#modal-labels").value
      .split(/[,，]/)
      .map((s) => s.trim())
      .filter(Boolean);
    await openusage.setAccountLabels(key, labels);
    const paste = $("#modal-sub-paste").value.trim();
    if (paste) {
      await openusage.setAccountSubscription(key, { paste });
    }
    $("#modal-account").close();
    await reloadAccounts();
    await openusage.refreshUsage();
  });

  $("#modal-sub-paste").addEventListener("input", async () => {
    const parsed = await openusage.parseRenewal($("#modal-sub-paste").value);
    if (parsed) {
      const parts = [parsed.date, parsed.method].filter(Boolean);
      $("#modal-sub-preview").textContent = "解析预览：" + parts.join(" · ");
    } else {
      $("#modal-sub-preview").textContent = "未能解析（可继续保存原始粘贴）";
    }
  });

  // Settings fields
  $("#set-theme").addEventListener("change", async (e) => {
    await openusage.updateSettings({ theme: e.target.value });
    const st = await openusage.getStatus();
    applyTheme(st.dark);
  });
  $("#set-refresh").addEventListener("change", async (e) => {
    await openusage.updateSettings({ refreshMinutes: Number(e.target.value) });
    state.settings = await openusage.getSettings();
    updateRefreshMeta();
  });
  $("#set-login-item").addEventListener("change", async (e) => {
    await openusage.updateSettings({ launchAtLogin: e.target.checked });
  });
  $("#set-tray-pct").addEventListener("change", async (e) => {
    await openusage.updateSettings({ trayShowPercent: e.target.checked });
  });

  async function saveProxyFromForm(applyOnly) {
    const proxyMode = $("#set-proxy-mode").value;
    const proxyUrl = $("#set-proxy-url").value.trim();
    const proxyBypass = $("#set-proxy-bypass").value.trim() || "localhost,127.0.0.1,<local>";
    await openusage.updateSettings({ proxyMode, proxyUrl, proxyBypass });
    if (applyOnly) await openusage.applyProxy();
    await reloadProxyStatus();
    state.settings = await openusage.getSettings();
  }

  $("#set-proxy-mode").addEventListener("change", () => saveProxyFromForm(false));
  $("#set-proxy-url").addEventListener("change", () => saveProxyFromForm(false));
  $("#set-proxy-bypass").addEventListener("change", () => saveProxyFromForm(false));
  $("#btn-proxy-apply").addEventListener("click", async () => {
    $("#btn-proxy-apply").disabled = true;
    $("#proxy-test-result").textContent = "正在应用…";
    try {
      await saveProxyFromForm(true);
      $("#proxy-test-result").textContent = "已应用代理配置";
    } catch (e) {
      $("#proxy-test-result").textContent = "应用失败: " + (e.message || e);
    } finally {
      $("#btn-proxy-apply").disabled = false;
    }
  });
  $("#btn-proxy-test").addEventListener("click", async () => {
    $("#btn-proxy-test").disabled = true;
    $("#proxy-test-result").textContent = "测试中…";
    try {
      await saveProxyFromForm(true);
      const r = await openusage.testProxy();
      $("#proxy-test-result").textContent = r.ok
        ? `✓ ${r.message}（${r.ms}ms）`
        : `✗ ${r.message}（${r.ms}ms）`;
      $("#proxy-test-result").style.color = r.ok ? "var(--ok)" : "var(--danger)";
      await reloadProxyStatus();
    } catch (e) {
      $("#proxy-test-result").textContent = "测试失败: " + (e.message || e);
      $("#proxy-test-result").style.color = "var(--danger)";
    } finally {
      $("#btn-proxy-test").disabled = false;
    }
  });

  $$("[data-path]").forEach((b) => {
    b.addEventListener("click", () => openusage.openPath(b.dataset.path));
  });

  // IPC events
  openusage.onUsageResult((data) => {
    state.usage = data;
    renderCards();
    updateRefreshMeta();
    if (data?.accounts?.length && state.view === "login" && !state.loginInfo) {
      /* keep login if mid-flow */
    }
  });
  openusage.onLoginState((st) => {
    if (!st) return;
    $("#login-status").textContent = st.message || st.state;
    if (st.state === "complete") {
      $("#login-idle").hidden = false;
      $("#login-pending").hidden = true;
      state.loginInfo = null;
      state.reauthKey = null;
      reloadAccounts().then(() => setView("home"));
    } else if (st.state === "expired" || st.state === "cancelled" || st.state === "error") {
      if (st.state !== "cancelled") {
        $("#login-error").hidden = false;
        $("#login-error").textContent = st.message || st.state;
      }
      $("#login-idle").hidden = false;
      $("#login-pending").hidden = true;
    } else if (st.userCode) {
      state.loginInfo = { ...state.loginInfo, ...st };
      $("#login-idle").hidden = true;
      $("#login-pending").hidden = false;
      $("#user-code").textContent = st.userCode;
      if (st.verificationUri) $("#verify-uri").textContent = st.verificationUri;
    }
  });
  openusage.onThemeChanged((p) => applyTheme(p.shouldUseDarkColors));
  openusage.onAccountsChanged(() => reloadAccounts());
  openusage.onFullscreenChanged((on) => {
    state.fullscreen = on;
    document.getElementById("app").classList.toggle("fullscreen", on);
    $("#side-nav").hidden = !on;
  });
  openusage.onNavigate((view) => {
    if (view === "settings") setView("settings");
    else if (view === "home") setView("home");
  });
  openusage.onPanelShown(() => {
    /* noop */
  });

  document.addEventListener("keydown", async (e) => {
    if (e.key === "Escape") {
      if (state.fullscreen) {
        await openusage.setFullscreen(false);
      } else {
        const modal = $("#modal-account");
        if (modal.open) modal.close();
        else openusage.hidePanel();
      }
    }
  });

  // boot
  (async () => {
    await reloadSettings();
    await reloadAccounts();
    const st = await openusage.getStatus();
    if (st.lastUsage) {
      state.usage = st.lastUsage;
      renderCards();
      updateRefreshMeta();
    }
    state.fullscreen = !!st.isFullscreen;
    document.getElementById("app").classList.toggle("fullscreen", state.fullscreen);
    $("#side-nav").hidden = !state.fullscreen;
    if (!state.accounts.length) setView("login");
    else setView("home");
  })();
})();
