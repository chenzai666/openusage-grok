/**
 * Manual API probe: billing + settings + chat for one or all accounts.
 */
const { fetchOneAccount } = require("./grokBilling");
const { loadAccounts } = require("./secureAccounts");
const settings = require("./settings");

async function testAccount(entryKey) {
  const data = loadAccounts();
  const entry = data.accounts[entryKey];
  if (!entry) throw new Error("账号不存在: " + entryKey);
  return fetchOneAccount(entryKey, entry, { forceRefresh: false, runChat: true });
}

async function testAllAccounts() {
  const data = loadAccounts();
  const cfg = settings.load();
  let order = Array.isArray(cfg.accountOrder) ? cfg.accountOrder.slice() : [];
  const keys = Object.keys(data.accounts || {});
  order = order.filter((k) => keys.includes(k));
  for (const k of keys) {
    if (!order.includes(k)) order.push(k);
  }

  const results = [];
  let okTotal = 0;
  let failTotal = 0;
  for (const key of order) {
    try {
      const card = await fetchOneAccount(key, data.accounts[key], { runChat: true });
      results.push(card);
      okTotal += card.probe?.ok || 0;
      failTotal += card.probe?.fail || 0;
    } catch (e) {
      failTotal += 3;
      results.push({
        entryKey: key,
        error: String(e.message || e),
        probe: { ok: 0, fail: 3, billing: null, settings: null, chat: null },
      });
    }
  }
  return {
    accounts: results,
    okTotal,
    failTotal,
    testedAt: new Date().toISOString(),
  };
}

module.exports = { testAccount, testAllAccounts };
