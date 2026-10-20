const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const os = require("node:os");
const { EventEmitter } = require("node:events");

const sourcePath = path.join(__dirname, "..", "electron", "main.js");
const plain = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

// Load the real IPC registrations with no Electron startup, network, or account I/O.
function fixture(initial = {}, model = {}) {
  const handlers = new Map(), sent = [], timeouts = [], images = [], tips = [], layouts = [], errors = [];
  const calls = { imports: [], sync: [], refresh: 0, discover: 0, proxy: 0, serviceOptions: null };
  const cfg = { selectedProvider: "grok", theme: "dark", activeEntryKey: "grok:a", panelWidthMode: "auto", ...initial };
  const usage = () => ({ provider: "chatgpt", accounts: [], trayPercent: 66 });
  const service = {
    list: () => model.chatgpt || [],
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
    constructor(options) { super(); panel = this; windowOptions = options; this.hidden = 0; this.bounds = {x:0,y:0,width:options.width,height:options.height};this.webContents = { send: (...args) => sent.push(args) }; }
    loadFile() {} setPosition(x,y) {this.bounds.x=x;this.bounds.y=y;} isDestroyed() { return false; }
    isFocused() { return false; } hide() { this.hidden++; }
    getBounds() { return {...this.bounds}; } setBounds(bounds) {this.bounds={...bounds};this.emit("resized");}
    setSize(width,height) {this.bounds.width=width;this.bounds.height=height;this.emit("resized");}
    setAlwaysOnTop() {} setSkipTaskbar() {} show() {} focus() {}
  }
  class Tray extends EventEmitter {
    setToolTip(value) { tips.push(value); } setImage(value) { images.push(value); }
    setContextMenu() {}
  }
  const app = new EventEmitter();
  Object.assign(app, { requestSingleInstanceLock: () => true, quit: () => {}, whenReady: () => ({ then() {} }), getVersion: () => "test" });
  const dialog = { showMessageBox: async () => ({ response: 0 }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const secure = {
    syncFromCli: () => ({ added: 0 }), listEntries: () => model.grok || [{ entryKey: "grok:a" }, { entryKey: "grok:b" }],
    removeEntry: () => true, clearAll: () => {},
    canEncrypt: () => true, cliAuthStatus: () => ({}), maskEmail: (email) => email,
    loadAccounts: () => ({accounts:{"grok:a":{email:"a@example.com"},"grok:b":{email:"b@example.com"}}}),
  };
  const billing = { formatSubscriptionLine: () => "", fetchAllUsage: async () => ({ accounts: [{ entryKey: "grok:a", weeklyPercent: 11 }, { entryKey: "grok:b", weeklyPercent: 22 }], trayPercent: 11 }) };
  const electron = {
    app, BrowserWindow, Tray, Menu: { buildFromTemplate: (items) => items }, nativeImage: {},
    ipcMain: { handle: (name, fn) => handlers.set(name, fn) }, dialog,
    shell: { openExternal: async () => {} }, clipboard: {}, nativeTheme: { shouldUseDarkColors: true },
    screen: {getCursorScreenPoint:()=>({x:0,y:0}),getDisplayNearestPoint:()=>({workArea:model.workArea || {x:0,y:0,width:1920,height:1080}}),getDisplayMatching:()=>({workArea:model.workArea || {x:0,y:0,width:1920,height:1080}})}, session: { defaultSession: {} }, safeStorage: {},
  };
  const modules = {
    electron, path, fs: { existsSync: () => false },
    "../lib/http": { applySessionProxy: async () => { calls.proxy++; }, resolveProxy: () => ({}), testProxyConnectivity: async () => ({}), request: () => { throw new Error("network must stay isolated"); } },
    "../lib/settings": { load: () => cfg, save: (partial) => Object.assign(cfg, partial) },
    "../lib/secureAccounts": secure, "../lib/grokAuth": {}, "../lib/grokBilling": billing, "../lib/grokApiTest": {},
    "../lib/cliproxyImport": { discoverDirs: () => { calls.discover++; return ["mock-default-auth-dir"]; } },
    "../lib/trayIcon": { createTrayNativeImage: (_native, percent) => ({ percent }) },
    "../lib/paths": Object.fromEntries(["appDataRoot", "accountsPath", "configPath", "cliAuthPath", "debugDir"].map((name) => [name, () => "mock-only-path"])),
    "../lib/chatgpt": { createService: (options) => { calls.serviceOptions = options; return service; } },
  };
  const context = vm.createContext({
    require: (name) => { if (!Object.hasOwn(modules, name)) throw new Error("Unexpected real module: " + name); return modules[name]; },
    __dirname: path.dirname(sourcePath), console: { log: (...args) => layouts.push(args), error: (...args) => errors.push(args) },
    setTimeout: (fn) => { timeouts.push(fn); return timeouts.length; }, clearTimeout() {},
    setInterval: () => { throw new Error("startup timers must not run"); }, clearInterval() {},
  });
  vm.runInContext(fs.readFileSync(sourcePath, "utf8") + "\nregisterIpc(); createPanel(); createTray();", context, { filename: sourcePath });
  return { cfg, service, secure, dialog, billing, calls, sent, images, tips, timeouts, panel, windowOptions, layouts, errors,
    invoke: (name, ...args) => handlers.get(name)({}, ...args) };
}

test("main window keeps renderer sandbox and isolation enabled", () => {
  const f=fixture();
  assert.equal(f.windowOptions.webPreferences.sandbox,true);
  assert.equal(f.windowOptions.webPreferences.contextIsolation,true);
  assert.equal(f.windowOptions.webPreferences.nodeIntegration,false);
});

test("ChatGPT email privacy setting is read live and defaults to masked", async () => {
  const f=fixture();
  assert.equal(f.calls.serviceOptions.getShowFullEmails(),false);
  await f.invoke("update-settings",{showFullEmails:true});
  assert.equal(f.calls.serviceOptions.getShowFullEmails(),true);
  await f.invoke("update-settings",{showFullEmails:false});
  assert.equal(f.calls.serviceOptions.getShowFullEmails(),false);
  f.cfg.showFullEmails="true";
  assert.equal(f.calls.serviceOptions.getShowFullEmails(),false);
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

test("quota display switches the current provider's cached tray immediately without fetching", async () => {
  const f=fixture();let grokRefreshes=0;
  f.billing.fetchAllUsage=async()=>{grokRefreshes++;return {accounts:[],trayPercent:11};};
  const raw=await f.invoke("refresh-usage");assert.equal(raw.trayPercent,11);
  await f.invoke("update-settings",{quotaDisplay:"remaining"});
  assert.equal(f.images.at(-1).percent,89);assert.match(f.tips.at(-1),/Grok · 周限剩余 89%/);
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});
  assert.equal(f.images.at(-1).percent,34);assert.match(f.tips.at(-1),/ChatGPT · 周限剩余 34%/);
  await f.invoke("update-settings",{quotaDisplay:"used"});
  assert.equal(f.images.at(-1).percent,66);assert.match(f.tips.at(-1),/ChatGPT · 周限已用 66%/);
  await f.invoke("update-settings",{selectedProvider:"grok"});
  assert.equal(f.images.at(-1).percent,11);assert.match(f.tips.at(-1),/Grok · 周限已用 11%/);
  assert.equal(grokRefreshes,1);assert.equal(f.calls.refresh,0);
  assert.equal((await f.invoke("get-status")).lastUsage.trayPercent,11);
  assert.equal((await f.invoke("get-status")).chatgptLastUsage.trayPercent,66);
});

test("remaining tray handles endpoints and clamping without changing raw usage", async () => {
  for(const provider of ["grok","chatgpt"]) {
    for(const [used,expected] of [[0,100],[100,0],[-5,100],[105,0],[25.4,75]]) {
      const f=fixture({selectedProvider:provider,quotaDisplay:"remaining"});
      const raw={provider,accounts:[],trayPercent:used};
      f.billing.fetchAllUsage=async()=>raw;f.service.refresh=async()=>raw;
      const result=await f.invoke(provider==="chatgpt"?"chatgpt-refresh":"refresh-usage");
      assert.equal(result.trayPercent,used);
      assert.equal(f.images.at(-1).percent,expected);
      assert.match(f.tips.at(-1),new RegExp(`周限剩余 ${expected}%`));
    }
  }
});

test("missing quota and logout never become 100 percent remaining", async () => {
  for(const provider of ["grok","chatgpt"]) {
    for(const percent of [null,undefined,NaN,Infinity,"0"]) {
      const f=fixture({selectedProvider:provider,quotaDisplay:"remaining"});
      const raw={accounts:[],trayPercent:percent};
      f.billing.fetchAllUsage=async()=>raw;f.service.refresh=async()=>raw;
      await f.invoke(provider==="chatgpt"?"chatgpt-refresh":"refresh-usage");
      assert.equal(f.images.at(-1).percent,0);assert.doesNotMatch(f.tips.at(-1),/周限|100%/);
    }
  }
  const f=fixture({quotaDisplay:"remaining"});await f.invoke("logout-all");
  assert.equal(f.images.at(-1).percent,0);assert.doesNotMatch(f.tips.at(-1),/周限|100%/);
  f.service.getLastUsage=()=>null;
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});
  assert.equal(f.images.at(-1).percent,0);assert.doesNotMatch(f.tips.at(-1),/周限|100%/);
  await f.invoke("update-settings",{trayShowPercent:false});
  assert.doesNotMatch(f.tips.at(-1),/周限/);
});

test("quota display rejects unsupported values before saving any settings", async () => {
  const f=fixture({quotaDisplay:"used"});
  for(const value of [null,undefined,"left","Remaining",true,0,{},[]]) {
    await assert.rejects(f.invoke("update-settings",{quotaDisplay:value,selectedProvider:"chatgpt"}),/额度显示方式/);
    assert.equal(f.cfg.quotaDisplay,"used");assert.equal(f.cfg.selectedProvider,"grok");
  }
  assert.equal(f.images.length,0);assert.equal(f.calls.refresh,0);
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

test("ChatGPT order is persisted, deduplicated and used by list, refresh, status and active results", async () => {
  const f=fixture({selectedProvider:"chatgpt",accountOrder:["grok:b","grok:a"],chatgptAccountOrder:["chatgpt:stale","chatgpt:b","chatgpt:b"]});
  const cards=[{entryKey:"chatgpt:a",enabled:true},{entryKey:"chatgpt:b",enabled:false},{entryKey:"chatgpt:c",enabled:false}];
  f.service.list=()=>cards;
  const cached={provider:"chatgpt",accounts:cards,trayEntryKey:"chatgpt:a",trayPercent:17};
  f.service.getLastUsage=()=>cached;f.service.refresh=async()=>cached;
  const keys=(accounts)=>accounts.map(a=>a.entryKey);
  assert.deepEqual(plain(keys(await f.invoke("chatgpt-list"))),["chatgpt:b","chatgpt:a","chatgpt:c"]);
  assert.deepEqual(plain(f.cfg.chatgptAccountOrder),["chatgpt:b","chatgpt:a","chatgpt:c"]);
  await f.invoke("chatgpt-reorder",["chatgpt:c","chatgpt:unknown","chatgpt:c","chatgpt:b"]);
  const expected=["chatgpt:c","chatgpt:b","chatgpt:a"];
  assert.deepEqual(plain(f.cfg.chatgptAccountOrder),expected);
  assert.deepEqual(plain(f.cfg.accountOrder),["grok:b","grok:a"]);
  assert.deepEqual(plain(keys((await f.invoke("chatgpt-refresh")).accounts)),expected);
  assert.deepEqual(plain(keys((await f.invoke("get-status")).chatgptLastUsage.accounts)),expected);
  await f.invoke("chatgpt-active","chatgpt:a");
  const emitted=f.sent.filter(([event])=>event==="usage-result").at(-1)[1];
  assert.deepEqual(plain(keys(emitted.accounts)),expected);
  assert.equal(emitted.trayEntryKey,"chatgpt:a");assert.equal(f.cfg.activeEntryKey,"grok:a");
  assert.deepEqual(cached.accounts.map(a=>a.entryKey),["chatgpt:a","chatgpt:b","chatgpt:c"]);
  f.service.list=()=>[cards[0],cards[2]];
  assert.deepEqual(plain(keys(await f.invoke("chatgpt-list"))),["chatgpt:c","chatgpt:a"]);
  assert.deepEqual(plain(f.cfg.chatgptAccountOrder),["chatgpt:c","chatgpt:a"]);
});

test("reorder IPC rejects malformed and cross-provider keys without changing saved order", async () => {
  const f=fixture({chatgptAccountOrder:["chatgpt:a"],accountOrder:["grok:a"]});
  f.service.list=()=>[{entryKey:"chatgpt:a"}];
  for(const [channel,values] of [["chatgpt-reorder",[undefined,null,"chatgpt:a",["grok:a"],[123],[{}]]],["reorder-accounts",[undefined,null,"grok:a",["chatgpt:a"],[123],[{}]]]]) {
    for(const value of values) await assert.rejects(f.invoke(channel,value),/排序/);
  }
  assert.deepEqual(plain(f.cfg.chatgptAccountOrder),["chatgpt:a"]);
  assert.deepEqual(plain(f.cfg.accountOrder),["grok:a"]);
  await assert.rejects(f.invoke("update-settings",{chatgptAccountOrder:["grok:a"]}),/排序/);
  await assert.rejects(f.invoke("update-settings",{accountOrder:["chatgpt:a"]}),/排序/);
});

test("Grok reorder aligns cached usage, fresh usage and list without changing active selection", async () => {
  const f=fixture({chatgptAccountOrder:["chatgpt:a"]});f.service.list=()=>[{entryKey:"chatgpt:a"}];await f.invoke("refresh-usage");
  await f.invoke("reorder-accounts",["grok:b","grok:stale","grok:b"]);
  const expected=["grok:b","grok:a"],keys=accounts=>plain(accounts.map(a=>a.entryKey));
  assert.deepEqual(plain(f.cfg.accountOrder),expected);
  assert.deepEqual(keys(await f.invoke("list-accounts")),expected);
  assert.deepEqual(keys((await f.invoke("get-status")).lastUsage.accounts),expected);
  assert.deepEqual(keys((await f.invoke("refresh-usage")).accounts),expected);
  assert.equal(f.cfg.activeEntryKey,"grok:a");assert.deepEqual(plain(f.cfg.chatgptAccountOrder),["chatgpt:a"]);
});

test("manual panel uses the same configured size limits after fullscreen", async () => {
  for(const [cfg,width,height] of [[{},400,680],[{panelWidth:360,panelHeight:480},360,480],[{panelWidth:1200,panelHeight:900},1200,900],[{panelWidth:2000,panelHeight:2000},1400,1064]]) {
    cfg.panelWidthMode="manual";
    const f=fixture(cfg);assert.equal(f.windowOptions.width,width);assert.equal(f.windowOptions.height,height);
    await f.invoke("set-fullscreen",true);await f.invoke("set-fullscreen",false);
    assert.equal(f.panel.getBounds().width,width);assert.equal(f.panel.getBounds().height,height);
    assert.equal(f.windowOptions.minWidth,360);
  }
});

test("settings migrate legacy default widths to auto once and preserve custom widths and preferences", (t) => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"openusage-settings-test-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,"config.json"),module={exports:{}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"..","lib","settings.js"),"utf8"),{module,require:(name)=>name==="fs"?fs:{configPath:()=>file}});
  const settings=module.exports;
  assert.equal(settings.load().panelWidth,400);assert.equal(settings.load().panelWidthMode,"auto");assert.deepEqual(plain(settings.load().chatgptAccountOrder),[]);
  for(const legacy of [{},{panelWidth:420},{panelWidth:860,panelLayoutVersion:1}]) {
    fs.writeFileSync(file,JSON.stringify({...legacy,panelHeight:640,proxyMode:"custom",showFullEmails:true,accountOrder:["grok:b"]}));
    const cfg=settings.load();assert.equal(cfg.panelWidth,400);assert.equal(cfg.panelWidthMode,"auto");assert.equal(cfg.panelLayoutVersion,2);
    assert.equal(cfg.panelHeight,legacy.panelLayoutVersion===1?640:680);
    assert.equal(cfg.proxyMode,"custom");assert.equal(cfg.showFullEmails,true);assert.deepEqual(plain(cfg.accountOrder),["grok:b"]);
    assert.equal(JSON.parse(fs.readFileSync(file)).panelWidth,400);
    settings.save({panelWidth:420});assert.equal(settings.load().panelWidth,420);
  }
  fs.writeFileSync(file,JSON.stringify({panelWidth:610,panelHeight:850,theme:"light"}));
  let cfg=settings.load();assert.equal(cfg.panelWidth,610);assert.equal(cfg.panelWidthMode,"manual");assert.equal(cfg.panelHeight,850);assert.equal(cfg.theme,"light");
  fs.writeFileSync(file,JSON.stringify({panelWidth:860,panelWidthMode:"manual",panelLayoutVersion:1}));
  cfg=settings.load();assert.equal(cfg.panelWidth,860);assert.equal(cfg.panelWidthMode,"manual");
});

test("auto panel uses 400px for zero or one account and 720px for multiple accounts per provider", async () => {
  for(const provider of ["grok","chatgpt"]) {
    for(const count of [0,1,2,12]) {
      const accounts=Array.from({length:count},(_,i)=>({entryKey:`${provider}:${i}`}));
      const f=fixture({selectedProvider:provider,panelWidth:860},{[provider]:accounts});
      assert.equal(f.windowOptions.width,count>1?720:400,`${provider} ${count}`);
      assert.equal(f.cfg.panelWidth,860,"automatic sizing must not overwrite saved manual width");
      await f.invoke("set-fullscreen",true);await f.invoke("set-fullscreen",false);
      assert.equal(f.panel.getBounds().width,count>1?720:400);
      assert.equal(f.cfg.panelWidthMode,"auto");assert.equal(f.cfg.panelWidth,860);
    }
  }
});

test("provider switch resizes immediately using its own vault without waiting for network", async () => {
  const f=fixture({panelWidth:860},{grok:[{entryKey:"grok:a"}],chatgpt:[{entryKey:"chatgpt:a"},{entryKey:"chatgpt:b"}]});
  assert.equal(f.panel.getBounds().width,400);
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});assert.equal(f.panel.getBounds().width,720);
  await f.invoke("update-settings",{selectedProvider:"grok"});assert.equal(f.panel.getBounds().width,400);
  assert.equal(f.calls.refresh,0);assert.equal(f.cfg.panelWidth,860);assert.equal(f.cfg.panelWidthMode,"auto");
});

test("delete, clear and import recalculate automatic width before refresh completes", async () => {
  for(const provider of ["grok","chatgpt"]) {
    const f=fixture({selectedProvider:provider},{[provider]:[{entryKey:`${provider}:a`},{entryKey:`${provider}:b`}]});
    let cards=[{entryKey:`${provider}:a`},{entryKey:`${provider}:b`}];
    if(provider==="chatgpt") {
      f.service.list=()=>cards;f.service.remove=()=>{cards=cards.slice(1);};f.service.clearAll=()=>{cards=[];};
      f.service.importDocuments=()=>{cards=[...cards,{entryKey:"chatgpt:a"}];return {added:1};};
      const pending=deferred();f.service.refresh=()=>pending.promise;
      const remove=f.invoke("chatgpt-remove","chatgpt:a");assert.equal(f.panel.getBounds().width,400);
      pending.resolve({provider:"chatgpt",accounts:cards});await remove;
      await f.invoke("chatgpt-import","text","mock-json");assert.equal(f.panel.getBounds().width,720);
      await f.invoke("chatgpt-clear");assert.equal(f.panel.getBounds().width,400);
    } else {
      f.secure.listEntries=()=>cards;f.secure.removeEntry=()=>{cards=cards.slice(1);return true;};f.secure.clearAll=()=>{cards=[];};
      const pending=deferred();f.billing.fetchAllUsage=()=>pending.promise;
      const remove=f.invoke("remove-account","grok:a");assert.equal(f.panel.getBounds().width,400);
      pending.resolve({accounts:cards});await remove;
      f.secure.syncFromCli=()=>{cards.push({entryKey:"grok:a"});return {added:1};};
      await f.invoke("soft-import-cli",{force:true});assert.equal(f.panel.getBounds().width,720);
      await f.invoke("logout-all");assert.equal(f.panel.getBounds().width,400);
    }
    assert.equal(f.cfg.panelWidthMode,"auto");
  }
});

test("only native will-resize transitions auto to manual and preserves the chosen size", async () => {
  const f=fixture({panelWidth:860});
  f.panel.setBounds({...f.panel.getBounds(),width:650,height:700});
  assert.equal(f.cfg.panelWidthMode,"auto");assert.equal(f.cfg.panelWidth,860);
  f.panel.emit("will-resize");f.panel.setBounds({...f.panel.getBounds(),width:630,height:710});
  assert.equal(f.cfg.panelWidthMode,"manual");assert.equal(f.cfg.panelWidth,630);assert.equal(f.cfg.panelHeight,710);
  assert.deepEqual(plain(f.sent.filter(([event])=>event==="panel-width-mode-changed")),[["panel-width-mode-changed","manual"]]);
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});assert.equal(f.panel.getBounds().width,630);
  await f.invoke("set-fullscreen",true);await f.invoke("set-fullscreen",false);
  assert.equal(f.panel.getBounds().width,630);assert.equal(f.cfg.panelWidth,630);
});

test("manual mode selection freezes visible size instead of reverting to the old default", async () => {
  const f=fixture({panelWidth:860},{grok:[{entryKey:"grok:a"}]});
  await f.invoke("update-settings",{panelWidthMode:"manual"});
  assert.equal(f.panel.getBounds().width,400);assert.equal(f.cfg.panelWidth,400);assert.equal(f.cfg.panelHeight,680);
  assert.equal(f.sent.filter(([event])=>event==="panel-width-mode-changed").at(-1)[1],"manual");
  await f.invoke("update-settings",{panelWidthMode:"auto"});
  assert.equal(f.sent.filter(([event])=>event==="panel-width-mode-changed").at(-1)[1],"auto");
  await f.invoke("set-fullscreen",true);await f.invoke("update-settings",{panelWidthMode:"manual"});
  assert.equal(f.cfg.panelWidth,400);assert.equal(f.cfg.panelHeight,680);
  await f.invoke("set-fullscreen",false);assert.equal(f.panel.getBounds().width,400);
});

test("fullscreen ignores automatic resizing and restores the newly selected provider on exit", async () => {
  const f=fixture({}, {grok:[{entryKey:"grok:a"}],chatgpt:[{entryKey:"chatgpt:a"},{entryKey:"chatgpt:b"}]});
  await f.invoke("set-fullscreen",true);const fullscreen=f.panel.getBounds();
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});
  assert.deepEqual(f.panel.getBounds(),fullscreen);
  f.panel.emit("will-resize");f.panel.emit("resized");assert.equal(f.cfg.panelWidthMode,"auto");
  await f.invoke("set-fullscreen",false);assert.equal(f.panel.getBounds().width,720);
  assert.equal(f.panel.getBounds().height,680);assert.equal(f.cfg.panelWidthMode,"auto");
});

test("panel auto and manual sizes are constrained to the active display work area", async () => {
  const workArea={x:1920,y:40,width:640,height:600};
  for(const panelWidthMode of ["auto","manual"]) {
    const f=fixture({panelWidthMode,panelWidth:1300,panelHeight:1100},{workArea});
    assert.equal(f.windowOptions.width,624);assert.equal(f.windowOptions.height,584);
    f.panel.emit("ready-to-show");
    let b=f.panel.getBounds();assert.equal(b.x,1928);assert.equal(b.y,48);
    await f.invoke("set-fullscreen",true);await f.invoke("set-fullscreen",false);
    b=f.panel.getBounds();assert.equal(b.width,624);assert.equal(b.height,584);assert.equal(b.x,1928);assert.equal(b.y,48);
  }
});

test("failed vault reads preserve the current window while provider preference is saved", async () => {
  const f=fixture();const before=f.panel.getBounds();
  f.service.list=()=>{throw new Error("mock corrupt vault");};
  await f.invoke("update-settings",{selectedProvider:"chatgpt"});
  assert.deepEqual(f.panel.getBounds(),before);assert.equal(f.cfg.selectedProvider,"chatgpt");
  assert.match(f.errors.at(-1).join(" "),/mock corrupt vault/);
});

test("width mode validation happens before saving any settings", async () => {
  const f=fixture({panelWidth:860});
  for(const value of [null,undefined,"Auto","custom",0,true,{},[]]) {
    await assert.rejects(f.invoke("update-settings",{panelWidthMode:value,selectedProvider:"chatgpt"}),/窗口宽度模式/);
    assert.equal(f.cfg.selectedProvider,"grok");assert.equal(f.cfg.panelWidthMode,"auto");assert.equal(f.cfg.panelWidth,860);
  }
});

test("layout diagnostics contain only provider, mode and dimensions and log only changes", async () => {
  const f=fixture({panelWidth:860});assert.equal(f.layouts.length,1);
  await f.invoke("refresh-usage");await f.invoke("refresh-usage");assert.equal(f.layouts.length,1);
  await f.invoke("update-settings",{panelWidthMode:"manual"});assert.equal(f.layouts.length,2);
  await f.invoke("refresh-usage");assert.equal(f.layouts.length,2);
  f.panel.emit("will-resize");f.panel.setBounds({...f.panel.getBounds(),width:610,height:700});assert.equal(f.layouts.length,3);
  for(const [name,details] of f.layouts) {
    assert.equal(name,"[panel-layout]");assert.deepEqual(Object.keys(details).sort(),["height","mode","provider","width"]);
  }
});
