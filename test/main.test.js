const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");

const sourcePath = path.join(__dirname, "..", "electron", "main.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Load the real IPC registrations with no Electron startup, network, or account I/O.
function fixture() {
  const handlers = new Map(), sent = [], timeouts = [], images = [], tips = [];
  const calls = { imports: [], sync: [], refresh: 0, discover: 0, proxy: 0 };
  const cfg = { selectedProvider: "grok", theme: "dark", activeEntryKey: "grok:a" };
  const usage = () => ({ provider: "chatgpt", accounts: [], trayPercent: 66 });
  const service = {
    list: () => [],
    refresh: async () => { calls.refresh++; return usage(); },
    getLastUsage: usage,
    importDocuments: (documents) => { calls.imports.push(["text", plain(documents)]); return { added: 1 }; },
    importPaths: (paths) => { calls.imports.push(["paths", plain(paths)]); return { added: 1 }; },
    syncLocal: (options) => { calls.sync.push(plain(options)); return { added: 1 }; },
    consumeReset: async (_key, confirm) => ({ outcome: await confirm({ title: "测试账号", count: 2, pending: false }) ? "reset" : "cancelled" }),
    hasPending: () => false,
    setActive: () => {}, remove: () => {}, clearAll: () => {},
  };
  let panel, windowOptions;
  class BrowserWindow extends EventEmitter {
    constructor(options) { super(); panel = this; windowOptions = options; this.hidden = 0; this.webContents = { send: (...args) => sent.push(args) }; }
    loadFile() {} setPosition() {} isDestroyed() { return false; }
    isFocused() { return false; } hide() { this.hidden++; }
    getBounds() { return { x: 0, y: 0, width: 420, height: 640 }; }
  }
  class Tray extends EventEmitter {
    setToolTip(value) { tips.push(value); } setImage(value) { images.push(value); }
    setContextMenu() {}
  }
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, quit: () => {}, whenReady: () => ({ then() {} }), getVersion: () => "test" });
  const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const secure = {
    syncFromCli: () => ({ added: 0 }), listEntries: () => [{ entryKey: "grok:a" }, { entryKey: "grok:b" }],
    removeEntry: () => true, clearAll: () => {},
  };
  const billing = { fetchAllUsage: async () => ({ accounts: [{ entryKey: "grok:a", weeklyPercent: 11 }, { entryKey: "grok:b", weeklyPercent: 22 }], trayPercent: 11 }) };
  const electron = {
    app, BrowserWindow, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog,
    shell: { openExternal: async () => {} }, clipboard: {}, nativeTheme: { shouldUseDarkColors: true },
    screen: {}, session: { defaultSession: {} }, safeStorage: {},
  };
  const modules = {
    electron, path, fs: { existsSync: () => false },
    "../lib/http": { applySessionProxy: async () => { calls.proxy++; }, resolveProxy: () => ({}), testProxyConnectivity: async () => ({}), request: () => { throw new Error("network must stay isolated"); } },
    "../lib/settings": { load: () => cfg, save: (partial) => Object.assign(cfg, partial) },
    "../lib/secureAccounts": secure, "../lib/grokAuth": {}, "../lib/grokBilling": billing, "../lib/grokApiTest": {},
    "../lib/cliproxyImport": { discoverDirs: () => { calls.discover++; return ["mock-default-auth-dir"]; } },
    "../lib/trayIcon": { createTrayNativeImage: (_native, percent) => ({ percent }) },
    "../lib/paths": Object.fromEntries(["appDataRoot", "accountsPath", "configPath", "cliAuthPath", "debugDir"].map((name) => [name, () => "mock-only-path"])),
    "../lib/chatgpt": { createService: () => service },
  };
  const context = vm.createContext({
    require: (name) => { if (!Object.hasOwn(modules, name)) throw new Error("Unexpected real module: " + name); return modules[name]; },
    __dirname: path.dirname(sourcePath), console: { log() {}, error() {} },
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval: () => { throw new Error("startup timers must not run"); }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8") + "\nregisterIpc(); createPanel(); createTray();", context, { filename: sourcePath });
  return { cfg, service, dialog, billing, calls, sent, images, tips, timeouts, panel, windowOptions,
    invoke: (name, ...args) => handlers.get(name)({}, ...args) };
}

test("main window keeps renderer sandbox and isolation enabled", () => {
  const f=fixture();
  assert.equal(f.windowOptions.webPreferences.sandbox,true);
  assert.equal(f.windowOptions.webPreferences.contextIsolation,true);
  assert.equal(f.windowOptions.webPreferences.nodeIntegration,false);
});

test("reset native confirmation defaults to cancel and keeps panel open", async () => {
  const f=fixture(), pending=deferred();let options;
  f.dialog.showMessageBox=(_panel,opts)=>{options=opts;return pending.promise;};
  const result=f.invoke("chatgpt-reset","chatgpt:a");
  assert.equal(options.defaultId,0);assert.equal(options.cancelId,0);
  assert.equal(options.buttons[0],"取消");assert.equal(options.type,"warning");
  f.panel.emit("blur");assert.equal(f.timeouts.length,0);assert.equal(f.panel.hidden,0);
  pending.resolve({response:0});assert.equal((await result).outcome,"cancelled");
  assert.equal(f.calls.refresh,0);
  f.panel.emit("blur");assert.equal(f.timeouts.length,1);f.timeouts[0]();assert.equal(f.panel.hidden,1);
});

test("pending reset native dialog explicitly verifies the original request", async () => {
  const f=fixture();let options;
  f.service.consumeReset=async (_key,confirm)=>({outcome:await confirm({title:"测试账号",count:0,pending:true})?"already_redeemed":"cancelled"});
  f.dialog.showMessageBox=async (_panel,opts)=>{options=opts;return {response:1};};
  assert.equal((await f.invoke("chatgpt-reset","chatgpt:a")).outcome,"already_redeemed");
  assert.equal(options.defaultId,0);assert.equal(options.buttons[1],"核对原请求");assert.match(options.detail,/复用/);
  assert.equal(f.calls.refresh,1);
});

test("reset error preserves pending status and successful reset survives refresh failure", async () => {
  const f=fixture();f.service.consumeReset=async()=>{throw new Error("重置结果待确认");};f.service.hasPending=()=>true;
  const error=await f.invoke("chatgpt-reset","chatgpt:a");
  assert.equal(error.outcome,"error");assert.equal(error.pending,true);assert.equal(f.calls.refresh,0);
  f.service.consumeReset=async()=>({outcome:"reset",message:"重置成功"});
  f.service.refresh=async()=>{throw new Error("offline");};
  const result=await f.invoke("chatgpt-reset","chatgpt:a");assert.equal(result.outcome,"reset");
});

test("dialog errors release blur protection", async () => {
  const f=fixture();f.dialog.showOpenDialog=async()=>{throw new Error("dialog closed unexpectedly");};
  await assert.rejects(f.invoke("chatgpt-import","files"),/dialog closed unexpectedly/);
  f.panel.emit("blur");assert.equal(f.timeouts.length,1);f.timeouts[0]();assert.equal(f.panel.hidden,1);
});

test("ChatGPT imports route text, read-only local restore and scan directories", async () => {
  const f=fixture();
  await f.invoke("chatgpt-import","text","mock-json");assert.deepEqual(f.calls.imports[0],["text",["mock-json"]]);
  await f.invoke("chatgpt-import","local",{force:true});assert.deepEqual(f.calls.sync[0],{force:true});
  await f.invoke("chatgpt-import","local",{force:"true"});assert.deepEqual(f.calls.sync[1],{force:false});
  await f.invoke("chatgpt-import","scan");assert.deepEqual(f.calls.imports[1],["paths",["mock-default-auth-dir"]]);
  assert.equal(f.calls.discover,1);
  f.cfg.cliproxyAuthDir="  custom-auth-dir  ";await f.invoke("chatgpt-import","scan");
  assert.deepEqual(f.calls.imports[2],["paths",["custom-auth-dir"]]);assert.equal(f.calls.discover,1);
  await assert.rejects(f.invoke("chatgpt-import","arbitrary"),/不支持/);
});

test("files and folder imports use native selection and cancellation does not import", async () => {
  for(const [mode,properties] of [["files",["openFile","multiSelections"]],["folder",["openDirectory"]]]) {
    const f=fixture(),pending=deferred();let options;
    f.dialog.showOpenDialog=(_panel,opts)=>{options=opts;return pending.promise;};
    const result=f.invoke("chatgpt-import",mode);
    assert.deepEqual(plain(options.properties),properties);assert.deepEqual(plain(options.filters[0].extensions),["json"]);
    f.panel.emit("blur");assert.equal(f.timeouts.length,0);
    pending.resolve({canceled:false,filePaths:["selected-auth-path"]});await result;
    assert.deepEqual(f.calls.imports,[["paths",["selected-auth-path"]]]);
    const before=f.calls.refresh;f.dialog.showOpenDialog=async()=>({canceled:true,filePaths:[]});
    assert.equal((await f.invoke("chatgpt-import",mode)).cancelled,true);
    assert.equal(f.calls.imports.length,1);assert.equal(f.calls.refresh,before);
  }
});

test("late Grok and ChatGPT refresh results cannot overwrite another provider's tray", async () => {
  const f=fixture(),grok=deferred();f.billing.fetchAllUsage=()=>grok.promise;
  const first=f.invoke("refresh-usage");f.cfg.selectedProvider="chatgpt";
  grok.resolve({accounts:[],trayPercent:11});assert.equal((await first).provider,"grok");assert.equal(f.images.length,0);
  const chatgpt=deferred();f.service.refresh=()=>chatgpt.promise;
  const second=f.invoke("chatgpt-refresh");f.cfg.selectedProvider="grok";
  chatgpt.resolve({provider:"chatgpt",accounts:[],trayPercent:66});await second;assert.equal(f.images.length,0);
  assert.equal(f.sent.filter(([event])=>event==="usage-result").length,2);
});

test("switching selected provider uses its own cached tray result", async () => {
  const f=fixture();await f.invoke("refresh-usage");assert.equal(f.images.at(-1).percent,11);
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});assert.equal(f.images.at(-1).percent,66);
  assert.match(f.tips.at(-1),/ChatGPT/);
  await f.invoke("update-settings",{selectedProvider:"grok"});assert.equal(f.images.at(-1).percent,11);
  assert.match(f.tips.at(-1),/Grok/);
});

test("background Grok account actions never replace the ChatGPT tray", async () => {
  for(const [name,args] of [["set-active-account",["grok:b"]],["remove-account",["grok:a"]],["logout-all",[]]]) {
    const f=fixture();await f.invoke("refresh-usage");f.cfg.selectedProvider="chatgpt";
    const before=f.images.length;await f.invoke(name,...args);
    assert.equal(f.images.length,before,name+" touched another provider's tray");
  }
});

test("shared proxy controls remain available independently of selected provider", async () => {
  const f=fixture();f.cfg.selectedProvider="chatgpt";
  await f.invoke("apply-proxy");await f.invoke("test-proxy");
  await f.invoke("update-settings",{proxyMode:"custom",proxyUrl:"http://127.0.0.1:2080"});
  assert.equal(f.calls.proxy,3);assert.equal(f.cfg.proxyMode,"custom");
});
