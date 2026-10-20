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

async function fixture(t, settings = {}, overrides = {}) {
  const root=path.join(__dirname,"..");
  const dom=new JSDOM(fs.readFileSync(path.join(root,"src/index.html"),"utf8"),{runScripts:"outside-only",url:"file:///preview/index.html"});
  // Event handlers continue through several already-resolved IPC promises.
  // Drain their microtasks before destroying the document they still render into.
  t.after(async()=>{await new Promise(setImmediate);dom.window.close();});
  const win=dom.window,doc=win.document,events={},calls=[];
  const config={theme:"dark",refreshMinutes:5,proxyMode:"auto",selectedProvider:"grok",showFullEmails:false,...settings};
  const grok={v:1,provider:"grok",refreshedAt:new Date().toISOString(),accounts:[{entryKey:"grok-1",title:"原有 Grok 账号",emailMasked:"gr***@example.com",status:"正常",labels:[],weeklyPercent:7,planName:"SuperGrok",enabled:true}]};
  const chat={v:1,provider:"chatgpt",refreshedAt:new Date().toISOString(),accounts:[{provider:"chatgpt",entryKey:"chatgpt:local",title:"本机 Codex",emailMasked:"te***@example.com",source:"本机 Codex（只读）",status:"正常",planName:"Plus",weeklyPercent:24,resetCount:1,metrics:[{label:"5h限额",percent:16},{label:"周限额",percent:24}],enabled:true}]};
  const base={
    getSettings:async()=>({...config}),getStatus:async()=>({version:"0.1.19",encrypted:true,dark:true,cliAuth:{exists:false},lastUsage:grok,chatgptLastUsage:chat}),
    updateSettings:async(p)=>{calls.push(["settings",{...p}]);return Object.assign(config,p);},getProxyStatus:async()=>({source:"system",mode:"system"}),
    listAccounts:async()=>grok.accounts,chatgptList:async()=>chat.accounts,
    refreshUsage:async()=>{events.onUsageResult?.(grok);return grok;},
    chatgptRefresh:async()=>{events.onUsageResult?.(chat);return chat;},
    softImportCli:async()=>({exists:false}),chatgptImport:async(...args)=>{calls.push(["import",...args]);return {added:1,total:1,scanned:1};},
    chatgptRemove:async(key)=>{calls.push(["remove",key]);chat.accounts=chat.accounts.filter(a=>a.entryKey!==key);events.onUsageResult?.(chat);},
    chatgptReset:async(key)=>{calls.push(["reset",key]);return {outcome:"reset",message:"额度重置成功"};},
    chatgptActive:async(key)=>calls.push(["active",key]),setActiveAccount:async(key)=>calls.push(["grok-active",key]),
    chatgptReorder:async(keys)=>{calls.push(["chat-reorder",[...keys]]);config.chatgptAccountOrder=[...keys];return true;},
    reorderAccounts:async(keys)=>{calls.push(["grok-reorder",[...keys]]);config.accountOrder=[...keys];return true;},
    chatgptClear:async()=>{},logoutAll:async()=>{},cliproxyDiscover:async()=>({discovered:[]}),
    cliproxyScanDefault:async()=>{calls.push(["grok-scan"]);return {added:1,total:1,scanned:1};},
    cliproxyPickImport:async()=>({cancelled:true}),cliproxyPickFolder:async()=>({cancelled:true}),cliproxyImportText:async()=>({added:1}),
    getFullscreen:async()=>false,parseRenewal:async()=>null,
  };
  for(const name of ["onUsageResult","onLoginState","onThemeChanged","onAccountsChanged","onFullscreenChanged","onPanelShown","onNavigate"])base[name]=(fn)=>{events[name]=fn;};
  for(const name of ["testAccountApi","testAllApis","removeAccount","setAccountLabels","setAccountSubscription","reorderAccounts","startBrowserLogin","cancelLogin","copyText","openExternal","openPath","hidePanel","setFullscreen","toggleFullscreen","applyProxy","testProxy"])base[name]||=(async()=>({}));
  Object.assign(base,overrides);
  win.openusage=base;win.alert=(message)=>calls.push(["alert",message]);win.confirm=()=>true;
  win.eval(fs.readFileSync(path.join(root,"src/renderer.js"),"utf8"));
  await until(()=>doc.querySelector(".card-title")?.textContent==="原有 Grok 账号");
  await new Promise(setImmediate);
  return {win,doc,base,events,calls,chat,grok,config,click:(id)=>doc.getElementById(id).click()};
}

function dragEvent(f, element, type, transfer = { effectAllowed: "", dropEffect: "", setData() {} }) {
  const event=new f.win.Event(type,{bubbles:true,cancelable:true});
  Object.defineProperty(event,"dataTransfer",{value:transfer});
  element.dispatchEvent(event);return event;
}

const cardKeys=(f)=>[...f.doc.querySelectorAll("#cards .acc-card")].map(n=>n.dataset.key);

test("Grok card handles reorder immediately and survive refresh without changing enabled account",async(t)=>{
  const f=await fixture(t);
  f.grok.accounts.push({...f.grok.accounts[0],entryKey:"grok-2",title:"第二账号",enabled:false});
  f.events.onAccountsChanged();await until(()=>f.doc.querySelectorAll(".acc-row").length===2);
  f.events.onUsageResult(f.grok);
  const first=f.doc.querySelector('[data-key="grok-1"]');
  const invalid=dragEvent(f,first.querySelector('[data-act="delete"]'),"dragstart");
  assert.equal(invalid.defaultPrevented,true);
  dragEvent(f,first.querySelector("[data-drag-handle]"),"dragstart");
  dragEvent(f,f.doc.querySelector('#cards [data-key="grok-2"]'),"drop");
  assert.deepEqual(cardKeys(f),["grok-2","grok-1"]);
  await until(()=>f.calls.some(c=>c[0]==="grok-reorder"));
  assert.deepEqual(f.config.accountOrder,["grok-2","grok-1"]);
  f.events.onUsageResult(f.grok);
  assert.deepEqual(cardKeys(f),["grok-2","grok-1"]);
  assert.equal(f.doc.querySelector('#cards [data-key="grok-1"] [data-act="enable"]').checked,true);
  assert.equal(f.calls.some(c=>c[0]==="active"||c[0]==="grok-active"),false);
  assert.equal(f.doc.querySelector("#cards").classList.contains("cols-2"),true);
});

test("ChatGPT settings handles share card order and persist separately from Grok",async(t)=>{
  const f=await fixture(t);f.config.accountOrder=["grok-1"];
  f.chat.accounts.push({...f.chat.accounts[0],entryKey:"chatgpt:second",title:"第二Codex",enabled:false});
  f.click("provider-chatgpt");await until(()=>f.doc.querySelectorAll("#cards .acc-card").length===2);
  dragEvent(f,f.doc.querySelector('#account-list [data-key="chatgpt:local"] [data-drag-handle]'),"dragstart");
  dragEvent(f,f.doc.querySelector('#account-list [data-key="chatgpt:second"]'),"drop");
  assert.deepEqual(cardKeys(f),["chatgpt:second","chatgpt:local"]);
  await until(()=>f.calls.some(c=>c[0]==="chat-reorder"));
  assert.deepEqual(f.config.chatgptAccountOrder,["chatgpt:second","chatgpt:local"]);
  assert.deepEqual(f.config.accountOrder,["grok-1"]);
  f.events.onUsageResult(f.chat);
  assert.deepEqual(cardKeys(f),["chatgpt:second","chatgpt:local"]);
  f.click("provider-grok");await until(()=>f.doc.querySelector(".grok-mark"));
  f.click("provider-chatgpt");
  assert.deepEqual(cardKeys(f),["chatgpt:second","chatgpt:local"]);
});

test("drag started under another provider cannot reorder the destination provider",async(t)=>{
  const f=await fixture(t);
  dragEvent(f,f.doc.querySelector("#cards [data-drag-handle]"),"dragstart");
  f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  dragEvent(f,f.doc.querySelector("#cards .acc-card"),"drop");
  assert.equal(f.calls.some(c=>c[0].endsWith("reorder")),false);
});

test("failed card order save restores known order and keeps account actions untouched",async(t)=>{
  const f=await fixture(t);
  f.grok.accounts.push({...f.grok.accounts[0],entryKey:"grok-2",title:"第二账号",enabled:false});
  f.events.onAccountsChanged();await until(()=>f.doc.querySelectorAll(".acc-row").length===2);
  f.events.onUsageResult(f.grok);
  f.base.reorderAccounts=async()=>{throw new Error("模拟排序保存失败");};
  // The wrapper routes through the live preload object rather than retaining a stale method.
  dragEvent(f,f.doc.querySelector('#cards [data-key="grok-1"] [data-drag-handle]'),"dragstart");
  dragEvent(f,f.doc.querySelector('#cards [data-key="grok-2"]'),"drop");
  await until(()=>!f.doc.getElementById("operation-message").hidden);
  await until(()=>cardKeys(f)[0]==="grok-1");
  assert.deepEqual(cardKeys(f),["grok-1","grok-2"]);
  assert.equal(f.calls.some(c=>c[0]==="active"||c[0]==="grok-active"),false);
});

test("cards stay two-column on wide panels with a single-column narrow fallback",()=>{
  const css=fs.readFileSync(path.join(__dirname,"..","src/styles.css"),"utf8");
  assert.match(css,/\.cards-grid\.cols-2\s*\{\s*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  assert.match(css,/@media\s*\(max-width:\s*719px\)[\s\S]*?\.cards-grid\.cols-2\s*\{\s*grid-template-columns:\s*1fr/);
  assert.doesNotMatch(css,/cols-3|repeat\(3,|auto-fill/);
});

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
  assert.equal(card.querySelector(".head-row .chatgpt-plan").textContent,"Plus");
  assert.match(card.textContent,/5h限额/);assert.doesNotMatch(card.textContent,/会话限额/);
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

test("provider switch uses loading, not empty state, and cached cards return synchronously",async(t)=>{
  const f=await fixture(t);let finishList,finishRefresh;
  const list=f.base.chatgptList;
  f.base.chatgptList=()=>new Promise(resolve=>{finishList=()=>list().then(resolve);});
  f.base.chatgptRefresh=()=>new Promise(resolve=>{finishRefresh=resolve;});
  f.click("provider-chatgpt");
  assert.equal(f.doc.getElementById("empty-state").hidden,true);
  assert.equal(f.doc.getElementById("accounts-loading").hidden,false);
  await until(()=>finishList);finishList();
  await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.doc.getElementById("empty-state").hidden,true);
  await until(()=>finishRefresh);
  f.click("provider-grok");
  assert.equal(f.doc.querySelector(".card-title").textContent,"原有 Grok 账号");
  f.click("provider-chatgpt");
  assert.ok(f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.doc.getElementById("empty-state").hidden,true);
  f.base.chatgptList=list;
  finishList?.();finishRefresh(f.chat);
});

test("full email preference updates card and settings list, and masks cached cards immediately",async(t)=>{
  const f=await fixture(t);
  const email="long-account-name-for-privacy-test@example.com";
  const display=()=>{
    f.chat.accounts.forEach(a=>{a.emailDisplay=f.config.showFullEmails?email:a.emailMasked;});
    return f.chat.accounts;
  };
  f.base.chatgptList=async()=>display();
  f.base.chatgptRefresh=async()=>{display();f.events.onUsageResult(f.chat);return f.chat;};
  f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  const control=f.doc.getElementById("set-full-emails");
  assert.equal(control.checked,false);
  assert.equal(f.doc.querySelector(".card-title").textContent,"te***@example.com");
  f.click("set-full-emails");
  await until(()=>f.doc.querySelector(".card-title").textContent===email&&!control.disabled);
  assert.equal(f.doc.querySelector(".acc-row .name").textContent,email);
  assert.ok(f.doc.querySelector(".acc-row .name.email-full"));
  f.click("provider-grok");await until(()=>f.doc.querySelector(".grok-mark"));
  f.click("set-full-emails");
  f.click("provider-chatgpt");
  assert.equal(f.doc.querySelector(".card-title").textContent,"te***@example.com");
  assert.doesNotMatch(f.doc.getElementById("cards").textContent,/long-account-name/);
  await until(()=>!control.disabled);
  assert.equal(f.doc.querySelector(".card-title").textContent,"te***@example.com");
  assert.equal(f.doc.querySelector(".acc-row .name").textContent,"te***@example.com");
});

function quotaMetric(f, label) {
  const metric=[...f.doc.querySelectorAll("#cards .metric")].find(n=>n.querySelector(".metric-label")?.textContent===label);
  assert.ok(metric,`缺少额度指标：${label}`);
  return {text:metric.querySelector(".metric-value").textContent,bar:metric.querySelector(".thin-bar i")?.style.width};
}

function setQuotaDisplay(f, value) {
  const control=f.doc.getElementById("set-quota-display");
  assert.ok(control,"设置应提供额度已用/剩余显示选项");
  control.value=value;
  control.dispatchEvent(new f.win.Event("change",{bubbles:true}));
  return control;
}

test("quota display defaults to used and includes an explicit weekly health label",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(f.doc.getElementById("set-quota-display").value,"used");
  assert.deepEqual(quotaMetric(f,"5h限额"),{text:"已用 16%",bar:"16%"});
  assert.deepEqual(quotaMetric(f,"周限额"),{text:"已用 24%",bar:"24%"});
  assert.equal(f.doc.querySelector(".health-pct").textContent,"已用 24%");
});

test("quota preference immediately inverts ChatGPT metrics and restores used without a request",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  f.chat.accounts[0].metrics.push({label:"代码审查限额",percent:30,resetAt:"2026-10-27T08:39:00Z"});
  f.chat.accounts[0].metrics[0].resetAt="2026-10-20T13:39:00Z";
  f.events.onUsageResult(f.chat);
  const original=JSON.stringify(f.chat),status=f.doc.querySelector(".status-ok").textContent;
  const healthDots=f.doc.querySelector(".health-dots").innerHTML;
  const before5h=quotaMetric(f,"5h限额").text,beforeReview=quotaMetric(f,"代码审查限额").text;
  let requests=0;
  f.base.refreshUsage=async()=>{requests++;return f.grok;};
  f.base.chatgptRefresh=async()=>{requests++;return f.chat;};
  setQuotaDisplay(f,"remaining");
  await until(()=>quotaMetric(f,"5h限额").text.startsWith("剩余 84%"));
  assert.equal(f.config.quotaDisplay,"remaining");
  assert.ok(f.calls.some(c=>c[0]==="settings"&&c[1].quotaDisplay==="remaining"));
  assert.equal(quotaMetric(f,"5h限额").text.replace("剩余 84%",""),before5h.replace("已用 16%",""));
  assert.deepEqual(quotaMetric(f,"周限额"),{text:"剩余 76%",bar:"76%"});
  assert.equal(quotaMetric(f,"代码审查限额").bar,"70%");
  assert.equal(quotaMetric(f,"代码审查限额").text.replace("剩余 70%",""),beforeReview.replace("已用 30%",""));
  assert.equal(f.doc.querySelector(".health-pct").textContent,"剩余 76%");
  assert.equal(f.doc.querySelector(".health-dots").innerHTML,healthDots);
  assert.equal(JSON.stringify(f.chat),original);
  assert.equal(f.doc.querySelector(".status-ok").textContent,status);
  setQuotaDisplay(f,"used");
  await until(()=>quotaMetric(f,"5h限额").text===before5h);
  assert.equal(quotaMetric(f,"5h限额").bar,"16%");
  assert.equal(quotaMetric(f,"周限额").text,"已用 24%");
  assert.equal(f.config.quotaDisplay,"used");
  assert.equal(requests,0);
});

test("remaining quota clamps boundaries and keeps missing or invalid usage unknown",async(t)=>{
  const f=await fixture(t);f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  f.chat.accounts[0].metrics=[
    {label:"零用量",percent:0},{label:"耗尽",percent:100},
    {label:"负用量",percent:-7},{label:"超限用量",percent:127},
    {label:"空值",percent:null},{label:"缺失"},{label:"非法数值",percent:NaN},
    {label:"无穷数值",percent:Infinity},{label:"空字符串",percent:""},
  ];
  f.chat.accounts[0].weeklyPercent=null;
  f.events.onUsageResult(f.chat);setQuotaDisplay(f,"remaining");
  await until(()=>quotaMetric(f,"零用量").text==="剩余 100%");
  for(const label of ["零用量","负用量"])assert.deepEqual(quotaMetric(f,label),{text:"剩余 100%",bar:"100%"});
  for(const label of ["耗尽","超限用量"])assert.deepEqual(quotaMetric(f,label),{text:"剩余 0%",bar:"0%"});
  for(const label of ["空值","缺失","非法数值","无穷数值","空字符串"]){
    const metric=quotaMetric(f,label);
    assert.doesNotMatch(metric.text,/\d+%|NaN|Infinity/);
    assert.equal(metric.bar,undefined);
  }
  assert.doesNotMatch(f.doc.querySelector(".health").textContent,/100%|NaN|Infinity/);
});

test("Grok weekly quota shares remaining preference while Build and API usage retain used values",async(t)=>{
  const f=await fixture(t);
  Object.assign(f.grok.accounts[0],{buildPercent:11,apiPercent:20,apiUsed:20,apiLimit:100,onDemandText:"已用 US$3.00"});
  f.events.onUsageResult(f.grok);
  const build=quotaMetric(f,"Build 用量"),api=quotaMetric(f,"API 月额度"),onDemand=quotaMetric(f,"按量已用");
  setQuotaDisplay(f,"remaining");
  await until(()=>quotaMetric(f,"周限额").text.startsWith("剩余 93%"));
  assert.equal(quotaMetric(f,"周限额").bar,"93%");
  assert.match(f.doc.querySelector(".health").textContent,/剩余/);
  assert.match(f.doc.querySelector(".health").textContent,/93%/);
  assert.deepEqual(quotaMetric(f,"Build 用量"),build);
  assert.deepEqual(quotaMetric(f,"API 月额度"),api);
  assert.deepEqual(quotaMetric(f,"按量已用"),onDemand);
  assert.match(build.text,/已用 11%/);assert.match(api.text,/已用 20%/);
  f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.equal(quotaMetric(f,"5h限额").text,"剩余 84%");
  f.click("provider-grok");await until(()=>f.doc.querySelector(".grok-mark"));
  assert.match(quotaMetric(f,"周限额").text,/剩余 93%/);
});

test("saved remaining quota preference is restored at startup",async(t)=>{
  const f=await fixture(t,{quotaDisplay:"remaining"});
  assert.equal(f.doc.getElementById("set-quota-display").value,"remaining");
  assert.match(quotaMetric(f,"周限额").text,/剩余 93%/);
  f.click("provider-chatgpt");await until(()=>f.doc.querySelector(".avatar.chatgpt"));
  assert.deepEqual(quotaMetric(f,"5h限额"),{text:"剩余 84%",bar:"84%"});
});

test("failed quota preference save restores the previous display and reports the error",async(t)=>{
  const f=await fixture(t,{}, {updateSettings:async()=>{throw new Error("模拟设置保存失败");}});
  const control=setQuotaDisplay(f,"remaining");
  assert.match(quotaMetric(f,"周限额").text,/剩余 93%/);
  await until(()=>!f.doc.getElementById("operation-message").hidden);
  assert.match(f.doc.getElementById("operation-message").textContent,/模拟设置保存失败/);
  assert.equal(control.value,"used");
  assert.deepEqual(quotaMetric(f,"周限额"),{text:"已用 7%",bar:"7%"});
  assert.equal(f.doc.querySelector(".health-pct").textContent,"已用 7%");
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
