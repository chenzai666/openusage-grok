const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM } = require("jsdom");
const vm = require("node:vm");

async function until(check) {
  for (let i=0;i<100;i++) { if(check())return;await new Promise(r=>setTimeout(r,5)); }
  assert.ok(check(),"等待界面更新超时");
}

async function fixture(t) {
  const root=path.join(__dirname,"..");
  const dom=new JSDOM(fs.readFileSync(path.join(root,"src/index.html"),"utf8"),{runScripts:"outside-only",url:"file:///preview/index.html"});
  // Event handlers continue through several already-resolved IPC promises.
  // Drain their microtasks before destroying the document they still render into.
  t.after(async()=>{await new Promise(setImmediate);dom.window.close();});
  const win=dom.window,doc=win.document,events={},calls=[];
  const config={theme:"dark",refreshMinutes:5,proxyMode:"auto",selectedProvider:"grok"};
  const grok={v:1,provider:"grok",refreshedAt:new Date().toISOString(),accounts:[{entryKey:"grok-1",title:"原有 Grok 账号",emailMasked:"gr***@example.com",status:"正常",labels:[],weeklyPercent:7,planName:"SuperGrok",enabled:true}]};
  const chat={v:1,provider:"chatgpt",refreshedAt:new Date().toISOString(),accounts:[{provider:"chatgpt",entryKey:"chatgpt:local",title:"本机 Codex",emailMasked:"te***@example.com",source:"本机 Codex（只读）",status:"正常",planName:"Plus",weeklyPercent:24,resetCount:1,metrics:[{label:"会话限额",percent:16},{label:"周限额",percent:24}],enabled:true}]};
  const base={
    getSettings:async()=>({...config}),getStatus:async()=>({version:"0.1.19",encrypted:true,dark:true,cliAuth:{exists:false},lastUsage:grok,chatgptLastUsage:chat}),
    updateSettings:async(p)=>Object.assign(config,p),getProxyStatus:async()=>({source:"system",mode:"system"}),
    listAccounts:async()=>grok.accounts,chatgptList:async()=>chat.accounts,
    refreshUsage:async()=>{events.onUsageResult?.(grok);return grok;},
    chatgptRefresh:async()=>{events.onUsageResult?.(chat);return chat;},
    softImportCli:async()=>({exists:false}),chatgptImport:async(...args)=>{calls.push(["import",...args]);return {added:1,total:1,scanned:1};},
    chatgptRemove:async(key)=>{calls.push(["remove",key]);chat.accounts=chat.accounts.filter(a=>a.entryKey!==key);events.onUsageResult?.(chat);},
    chatgptReset:async(key)=>{calls.push(["reset",key]);return {outcome:"reset",message:"额度重置成功"};},
    chatgptActive:async(key)=>calls.push(["active",key]),setActiveAccount:async(key)=>calls.push(["grok-active",key]),
    chatgptClear:async()=>{},logoutAll:async()=>{},cliproxyDiscover:async()=>({discovered:[]}),
    cliproxyScanDefault:async()=>{calls.push(["grok-scan"]);return {added:1,total:1,scanned:1};},
    cliproxyPickImport:async()=>({cancelled:true}),cliproxyPickFolder:async()=>({cancelled:true}),cliproxyImportText:async()=>({added:1}),
    getFullscreen:async()=>false,parseRenewal:async()=>null,
  };
  for(const name of ["onUsageResult","onLoginState","onThemeChanged","onAccountsChanged","onFullscreenChanged","onPanelShown","onNavigate"])base[name]=(fn)=>{events[name]=fn;};
  for(const name of ["testAccountApi","testAllApis","removeAccount","setAccountLabels","setAccountSubscription","reorderAccounts","startBrowserLogin","cancelLogin","copyText","openExternal","openPath","hidePanel","setFullscreen","toggleFullscreen","applyProxy","testProxy"])base[name]||=(async()=>({}));
  win.openusage=base;win.alert=(message)=>calls.push(["alert",message]);win.confirm=()=>true;
  win.eval(fs.readFileSync(path.join(root,"src/renderer.js"),"utf8"));
  await until(()=>doc.querySelector(".card-title")?.textContent==="原有 Grok 账号");
  await new Promise(setImmediate);
  return {win,doc,base,events,calls,chat,config,click:(id)=>doc.getElementById(id).click()};
}

test("preserves old Grok card, proxy settings and CLIProxy controls", async(t)=>{
  const f=await fixture(t);
  assert.ok(f.doc.querySelector(".grok-mark"));
  assert.equal(f.doc.querySelector(".card-title").textContent,"原有 Grok 账号");
  assert.ok(f.doc.getElementById("set-proxy-mode"));assert.ok(f.doc.getElementById("btn-settings-cliproxy-scan"));
  f.click("btn-settings-cliproxy-scan");await until(()=>f.calls.some(c=>c[0]==="grok-scan"));
});

test("adds ChatGPT in the exact existing card classes without xAI-only metrics",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");
  await until(()=>f.doc.querySelector(".card-title")?.textContent==="本机 Codex");
  assert.equal(f.doc.getElementById("provider-chatgpt").getAttribute("aria-selected"),"true");
  const card=f.doc.querySelector(".acc-card");
  assert.match(card.textContent,/OpenAI/);assert.match(card.textContent,/使用重置卡/);assert.match(card.textContent,/周限额/);
  assert.doesNotMatch(card.textContent,/Build 用量|API 月额度|按量付费/);
  assert.ok(card.querySelector('[data-act="delete"]'));
  assert.equal(f.doc.getElementById("btn-start-login").hidden,true);
  assert.equal(f.doc.getElementById("set-proxy-mode").value,"auto");
  assert.equal(f.doc.querySelector('[data-path="cliAuth"]').hidden,true);
  assert.match(f.doc.getElementById("cli-sync-note").textContent,/不使用 refresh token/);
  assert.match(f.doc.getElementById("cli-auth-hint").textContent,/只读同步/);
});

test("switching back restores Grok and ignores delayed results from other provider",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  f.events.onUsageResult({provider:"grok",accounts:[]});assert.ok(f.doc.querySelector(".avatar.chatgpt"));
  f.click("provider-grok");await until(()=>f.doc.querySelector(".card-title")?.textContent==="原有 Grok 账号");
  assert.equal(f.doc.querySelector('[data-path="cliAuth"]').hidden,false);
  assert.match(f.doc.getElementById("cli-sync-note").textContent,/同步会覆盖/);
  assert.match(f.doc.getElementById("cli-auth-hint").textContent,/grok login/);
});

test("ChatGPT scan/file/paste controls route to Codex imports",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  f.click("btn-settings-cliproxy-scan");await until(()=>f.calls.some(c=>c[0]==="import"&&c[1]==="scan"));
  f.doc.getElementById("cliproxy-paste").value='{"type":"codex","access_token":"test"}';
  f.click("btn-cliproxy-paste");await until(()=>f.calls.some(c=>c[0]==="import"&&c[1]==="text"));
  await until(()=>f.doc.getElementById("cliproxy-paste").value==="");
});

test("local card can be removed and native reset action is clickable",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  f.doc.querySelector('[data-act="reset-credit"]').click();await until(()=>f.calls.some(c=>c[0]==="reset"));
  await until(()=>f.doc.getElementById("operation-message").textContent==="额度重置成功");
  f.doc.querySelector('[data-act="delete"]').click();await until(()=>f.calls.some(c=>c[0]==="remove"));
  assert.equal(f.calls.find(c=>c[0]==="remove")[1],"chatgpt:local");
  await until(()=>f.doc.querySelectorAll(".acc-card").length===0);
});

test("account data is escaped, not inserted as executable HTML",async(t)=>{
  const f=await fixture(t);f.chat.accounts[0].title='<img src=x onerror="attack()">';
  f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.doc.querySelector(".card-title").textContent,'<img src=x onerror="attack()">');
  assert.equal(f.doc.querySelector(".card-title img"),null);
});

test("rapid provider switches keep only the latest provider and persisted selection",async(t)=>{
  const f=await fixture(t);
  f.click("provider-chatgpt");f.click("provider-grok");f.click("provider-chatgpt");
  await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.config.selectedProvider,"chatgpt");
  assert.equal(f.doc.getElementById("provider-chatgpt").getAttribute("aria-selected"),"true");
  f.events.onLoginState({state:"complete",email:"old-grok@example.com"});
  assert.ok(f.doc.querySelector(".avatar.chatgpt"));
});

test("late import completion cannot replace the newly selected provider or clear its form",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  let finish;
  f.base.chatgptImport=()=>new Promise(resolve=>{finish=resolve;});
  f.click("btn-settings-cliproxy-scan");
  f.click("provider-grok");await until(()=>f.doc.querySelector(".card-title")?.textContent==="原有 Grok 账号");
  f.doc.getElementById("cliproxy-paste").value="new Grok form";
  finish({added:1,total:1});await new Promise(setImmediate);
  assert.equal(f.doc.getElementById("cliproxy-paste").value,"new Grok form");
  assert.equal(f.config.selectedProvider,"grok");
  assert.equal(f.calls.filter(c=>c[0]==="alert").length,0);
});

test("reset locks provider switching and only an actual pending request offers reconciliation",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  let finish;
  f.base.chatgptReset=()=>new Promise(resolve=>{finish=resolve;});
  f.doc.querySelector('[data-act="reset-credit"]').click();
  assert.equal(f.doc.getElementById("provider-grok").disabled,true);
  f.click("provider-grok");
  assert.equal(f.doc.getElementById("provider-chatgpt").getAttribute("aria-selected"),"true");
  finish({outcome:"error",message:"查询重置卡失败",pending:false});
  await until(()=>!f.doc.getElementById("provider-grok").disabled);
  assert.equal(f.doc.querySelector('[data-act="reset-credit"]').textContent,"使用重置卡");
  f.doc.querySelector('[data-act="reset-credit"]').click();
  finish({outcome:"error",message:"原请求结果待核对",pending:true});
  await until(()=>f.doc.querySelector('[data-act="reset-credit"]').textContent==="核对重置结果");
});

test("deleted local Codex card is restored through an explicit force-sync action",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  const local=f.chat.accounts[0];
  f.doc.querySelector('[data-act="delete"]').click();await until(()=>!f.doc.querySelector(".acc-card"));
  f.base.chatgptImport=async(mode,opts)=>{
    assert.equal(mode,"local");assert.equal(opts.force,true);
    f.chat.accounts=[local];return {added:1,total:1};
  };
  f.click("btn-settings-import-cli");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.doc.querySelector(".card-title").textContent,"本机 Codex");
});

test("sandboxed preload requires only Electron and exposes named IPC methods",()=>{
  const root=path.join(__dirname,"..");
  const calls=[];let bridge;
  vm.runInNewContext(fs.readFileSync(path.join(root,"electron/preload.js"),"utf8"),{
    require(name){
      assert.equal(name,"electron");
      return {contextBridge:{exposeInMainWorld(name,value){assert.equal(name,"openusage");bridge=value;}},
        ipcRenderer:{invoke:(...args)=>calls.push(args),on(){},removeListener(){}}};
    },
  });
  bridge.chatgptReset("chatgpt:local");bridge.chatgptImport("local",{force:true});
  assert.deepEqual(calls,[["chatgpt-reset","chatgpt:local"],["chatgpt-import","local",{force:true}]]);
  assert.equal(bridge.invoke,undefined);assert.equal(bridge.require,undefined);
  const main=fs.readFileSync(path.join(root,"electron/main.js"),"utf8");
  assert.match(main,/contextIsolation:\s*true/);assert.match(main,/nodeIntegration:\s*false/);assert.match(main,/sandbox:\s*true/);
  const reset=main.slice(main.indexOf('ipcMain.handle("chatgpt-reset"'),main.indexOf('ipcMain.handle("get-status"'));
  assert.match(reset,/withDialog\(\(\) => dialog\.showMessageBox/);
  assert.match(reset,/defaultId:\s*0,\s*cancelId:\s*0/);
  assert.match(reset,/return response\.response === 1/);
});
