/**
 * Copy electron-builder artifacts to Desktop\OpenUsage-releases\OpenUsage-v{version}\
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const root = path.join(__dirname, "..");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
const version = pkg.version;
const distDir = path.join(root, "dist");
const outDir = path.join(
  os.homedir(),
  "Desktop",
  "OpenUsage-releases",
  `OpenUsage-v${version}`
);

fs.mkdirSync(outDir, { recursive: true });

function copyIfExists(src, destName) {
  if (!fs.existsSync(src)) {
    console.warn("skip missing:", src);
    return false;
  }
  const dest = path.join(outDir, destName);
  fs.copyFileSync(src, dest);
  console.log("copied", destName);
  return true;
}

const portable = path.join(distDir, `OpenUsage-Grok-${version}-win-x64.exe`);
const setupCandidates = [
  path.join(distDir, `OpenUsage-Grok-${version}-win-x64.exe`),
  // nsis often differs; scan
];

// Prefer explicit artifact names; also scan dist
let files = [];
try {
  files = fs.readdirSync(distDir);
} catch {
  console.error("dist/ missing — run electron-builder first");
  process.exit(1);
}

const portableHit = files.find(
  (f) => /portable/i.test(f) && f.endsWith(".exe")
);
const setupHit = files.find(
  (f) => /setup|nsis/i.test(f) && f.endsWith(".exe") && !/portable/i.test(f)
);
// electron-builder portable may just be OpenUsage-Grok-x.y.z-win-x64.exe without "portable"
const allExes = files.filter((f) => f.endsWith(".exe") && !f.includes("uninstall"));

if (portableHit) {
  copyIfExists(path.join(distDir, portableHit), `OpenUsage-Grok-${version}-portable.exe`);
} else if (allExes.length) {
  // first exe as portable-like
  const p = allExes.find((f) => !/Setup/i.test(f)) || allExes[0];
  copyIfExists(path.join(distDir, p), `OpenUsage-Grok-${version}-portable.exe`);
}

if (setupHit) {
  copyIfExists(path.join(distDir, setupHit), `OpenUsage-Grok-${version}-setup.exe`);
} else {
  const setup = allExes.find((f) => /Setup/i.test(f));
  if (setup) {
    copyIfExists(path.join(distDir, setup), `OpenUsage-Grok-${version}-setup.exe`);
  }
}

const readme = `OpenUsage Grok v${version}
========================

Grok / SuperGrok 多账号用量监控（Windows）

文件：
- OpenUsage-Grok-${version}-portable.exe  绿色便携
- OpenUsage-Grok-${version}-setup.exe     安装包（若有）

数据目录：%APPDATA%\\OpenUsageGrok\\
  - accounts.json  （DPAPI 加密多账号）
  - config.json
  - debug\\billing-last.json

兼容：可 soft-import %USERPROFILE%\\.grok\\auth.json（只读合并，不覆盖 CLI）

登录：device-code，复制链接后自行打开浏览器（不自动弹窗）

构建于：${new Date().toISOString()}
`;

fs.writeFileSync(path.join(outDir, "README.txt"), readme, "utf8");
console.log("Release folder:", outDir);
