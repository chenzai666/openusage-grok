const path = require("path");
const os = require("os");
const fs = require("fs");

const APP_DIR_NAME = "OpenUsageGrok";

function appDataRoot() {
  const base = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  const dir = path.join(base, APP_DIR_NAME);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function accountsPath() {
  return path.join(appDataRoot(), "accounts.json");
}

function configPath() {
  return path.join(appDataRoot(), "config.json");
}

function debugDir() {
  const d = path.join(appDataRoot(), "debug");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function cliAuthPath() {
  return path.join(os.homedir(), ".grok", "auth.json");
}

function backupsDir() {
  const d = path.join(appDataRoot(), "backups");
  fs.mkdirSync(d, { recursive: true });
  return d;
}

module.exports = {
  APP_DIR_NAME,
  appDataRoot,
  accountsPath,
  configPath,
  debugDir,
  cliAuthPath,
  backupsDir,
};
