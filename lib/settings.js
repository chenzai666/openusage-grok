const fs = require("fs");
const { configPath } = require("./paths");

const DEFAULTS = {
  // 产品默认深色，与参考卡片一致（避免浅色白底+白字）
  theme: "dark",
  refreshMinutes: 5,
  launchAtLogin: false,
  trayShowPercent: true,
  panelWidth: 420,
  panelHeight: 640,
  activeEntryKey: null,
  accountOrder: [],
  /** auto | env | system | custom | direct */
  proxyMode: "auto",
  /** e.g. http://127.0.0.1:10808 or socks5://127.0.0.1:10808 */
  proxyUrl: "",
  proxyBypass: "localhost,127.0.0.1,<local>",
  /** CLIProxyAPI auth-dir (xai-*.json). Empty = scan default ~/.cli-proxy-api */
  cliproxyAuthDir: "",
};

function load() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return { ...DEFAULTS };
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(partial) {
  const next = { ...load(), ...partial };
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), "utf8");
  return next;
}

module.exports = { load, save, DEFAULTS };
