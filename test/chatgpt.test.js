const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { createService, parseDocuments, normalize, USAGE_URL, RESET_URL } = require("../lib/chatgpt");

function fixture(t, responder) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openusage-chatgpt-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const key = crypto.randomBytes(32);
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      const iv = crypto.randomBytes(12); const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
      return Buffer.concat([iv, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
    },
    decryptString(bytes) {
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
    },
  };
  const calls = [];
  let handler = responder || (() => ({ status: 200, ok: true, data: { plan_type: "plus", rate_limit: { primary_window: { used_percent: 13 }, secondary_window: { used_percent: 28 } }, rate_limit_reset_credits: { available_count: 1 } } }));
  const options = { root: () => root, safeStorage, localAuthPaths: () => [path.join(root, "native-auth.json")], request: async (url, opts) => { calls.push({url, ...opts}); return handler(url, opts); } };
  return { root, calls, safeStorage, options, service: createService(options), respond: (fn) => {handler = fn;} };
}
const auth = (account = "a", more = {}) => ({ type: "codex", account_id: account, access_token: "private-token-" + account, email: account + "@example.com", refresh_token: "never-copy-refresh", ...more });
const encode = (value) => JSON.stringify(value);

test("accepts CLIProxy, native, arrays and named export wrappers", () => {
  for (const input of [auth(), [auth()], {accounts:[auth()]}, {"codex-a.json":auth()}, {tokens:{access_token:"native",account_id:"n"}}]) {
    assert.equal(parseDocuments([encode(input)]).length, 1);
  }
  assert.equal(parseDocuments(["\uFEFF" + encode(auth())]).length, 1);
});

test("rejects API keys, xAI tokens, invalid JSON, control chars and oversized input", () => {
  for (const input of [encode({OPENAI_API_KEY:"key"}), encode({type:"xai",access_token:"xai"}), "{", "x".repeat(1024*1024+1), encode(auth("a",{access_token:"bad\r\ntoken"}))]) {
    assert.throws(() => parseDocuments([input]));
  }
  const xai = "e30." + Buffer.from(encode({iss:"https://auth.x.ai"})).toString("base64url") + ".x";
  assert.equal(normalize({tokens:{access_token:xai}}), null);
});

test("deduplicates token updates but keeps different team members separate", () => {
  const result = parseDocuments([encode([auth("team"),auth("team",{access_token:"new"}),auth("team",{email:"other@example.com"})])]);
  assert.equal(result.length,2);
  assert.equal(result[0].accessToken,"new");
  assert.ok(!encode(result).includes("never-copy-refresh"));
});

test("encrypts imported credentials and emits display-only cards", async (t) => {
  const f=fixture(t); f.service.importDocuments([encode(auth())]);
  const raw=fs.readFileSync(path.join(f.root,"chatgpt-accounts.json"),"utf8");
  assert.ok(!raw.includes("private-token")); assert.ok(!raw.includes("never-copy-refresh"));
  assert.ok(!encode(f.service.list()).includes("private-token"));
  const result=await f.service.refresh();
  assert.equal(result.accounts[0].weeklyPercent,28);
  assert.equal(result.accounts[0].provider,"chatgpt");
  assert.ok(!encode(result).includes("private-token"));
  assert.equal(f.calls[0].url,USAGE_URL); assert.equal(f.calls[0].redirect,"error");
  assert.equal(f.calls[0].headers["ChatGPT-Account-Id"],"a");
});

test("rejects plaintext fallback and preserves corrupt vaults", (t) => {
  const f=fixture(t); f.safeStorage.isEncryptionAvailable=()=>false;
  assert.throws(()=>f.service.importDocuments([encode(auth())]),/DPAPI/);
  assert.ok(!fs.existsSync(path.join(f.root,"chatgpt-accounts.json")));
  f.safeStorage.isEncryptionAvailable=()=>true;
  fs.writeFileSync(path.join(f.root,"chatgpt-accounts.json"),"broken");
  assert.throws(()=>f.service.list(),/保留原文件/);
  assert.equal(fs.readFileSync(path.join(f.root,"chatgpt-accounts.json"),"utf8"),"broken");
});

test("invalid import is transactional and leaves existing accounts intact", (t) => {
  const f=fixture(t);f.service.importDocuments([encode(auth())]);
  assert.throws(()=>f.service.importDocuments([encode(auth("b")),"bad-json"]));
  assert.equal(f.service.list().length,1);
});

test("local OAuth removal persists across restart without changing native auth", async (t) => {
  const f=fixture(t);const file=path.join(f.root,"native-auth.json");
  const before=encode({tokens:{access_token:"native",account_id:"native-a"}}); fs.writeFileSync(file,before);
  assert.equal(f.service.list()[0].entryKey,"chatgpt:local");
  f.service.remove("chatgpt:local");
  const reopened=createService(f.options);assert.equal(reopened.list().length,0);
  assert.equal(fs.readFileSync(file,"utf8"),before);
  reopened.syncLocal({force:true});assert.equal(reopened.list().length,1);
  assert.equal((await reopened.refresh()).accounts[0].source,"本机 Codex（只读）");
});

test("API-key-only local login does not create an unremovable card", (t) => {
  const f=fixture(t); fs.writeFileSync(path.join(f.root,"native-auth.json"),encode({OPENAI_API_KEY:"secret"}));
  assert.equal(f.service.list().length,0);
  assert.throws(()=>f.service.syncLocal({force:true}),/API Key/);
});

test("directory import filters provider formats and never modifies input files", (t) => {
  const f=fixture(t);const dir=path.join(f.root,"auths");fs.mkdirSync(dir);
  const file=path.join(dir,"codex-a.json"),before=encode(auth());fs.writeFileSync(file,before);
  fs.writeFileSync(path.join(dir,"xai.json"),encode({type:"xai",access_token:"other-provider"}));
  const result=f.service.importPaths([dir]);assert.equal(result.total,1);
  assert.equal(fs.readFileSync(file,"utf8"),before);
});

test("one failed account does not erase healthy cards; selected account drives tray", async (t) => {
  const f=fixture(t,(url,opts)=>opts.headers["ChatGPT-Account-Id"]==="bad" ? {status:401,ok:false} : {status:200,ok:true,data:{rate_limit:{secondary_window:{used_percent:47}}}});
  f.service.importDocuments([encode([auth("bad"),auth("good")])]);
  const good=f.service.list().find(a=>a.emailMasked.startsWith("go"));f.service.setActive(good.entryKey);
  const result=await f.service.refresh();assert.ok(result.accounts[0].error);assert.equal(result.trayPercent,47);
  assert.ok(f.calls.every(c=>!c.url.includes("oauth/token")));
});

test("zero credit and cancelled confirmation never POST", async (t) => {
  const f=fixture(t,()=>({status:200,ok:true,data:{available_count:0}}));f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  assert.equal((await f.service.consumeReset(key,()=>{throw new Error("must not confirm");})).outcome,"no_credit");
  f.respond(()=>({status:200,ok:true,data:{available_count:2}}));
  assert.equal((await f.service.consumeReset(key,()=>false)).outcome,"cancelled");
  assert.ok(f.calls.every(c=>c.method==="GET"));
});

test("confirmed reset uses official POST contract once and maps outcomes", async (t) => {
  const f=fixture(t,(url,opts)=>({status:200,ok:true,data:opts.method==="POST"?{code:"reset"}:{available_count:1}}));
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  assert.equal((await f.service.consumeReset(key,async p=>{assert.equal(p.count,1);return true;})).outcome,"reset");
  const post=f.calls.find(c=>c.method==="POST");assert.equal(post.url,RESET_URL+"/consume");
  assert.match(JSON.parse(post.body).redeem_request_id,/^[a-f0-9-]{36}$/);
  assert.equal(f.service.hasPending(key),false);
});

test("ambiguous reset reuses persisted key after restart and last credit is consumed", async (t) => {
  let requestId;
  const f=fixture(t,(url,opts)=>{
    if(opts.method==="GET")return {status:200,ok:true,data:{available_count:1}};
    requestId=JSON.parse(opts.body).redeem_request_id;throw new Error("timeout");
  });
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  await assert.rejects(f.service.consumeReset(key,()=>true),/结果待确认/);
  const reopened=createService(f.options);
  f.respond((url,opts)=>{
    if(opts.method==="GET")return {status:200,ok:true,data:{available_count:0}};
    assert.equal(JSON.parse(opts.body).redeem_request_id,requestId);return {status:200,ok:true,data:{code:"already_redeemed"}};
  });
  assert.equal((await reopened.consumeReset(key,p=>p.pending)).outcome,"already_redeemed");
});

test("reset detects account switch while awaiting confirmation", async (t) => {
  const f=fixture(t,()=>({status:200,ok:true,data:{available_count:1}}));
  const native=path.join(f.root,"native-auth.json");fs.writeFileSync(native,encode({tokens:{access_token:"old",account_id:"old"}}));
  await assert.rejects(f.service.consumeReset("chatgpt:local",()=>{
    fs.writeFileSync(native,encode({tokens:{access_token:"new",account_id:"new"}}));return true;
  }),/身份已变化/);
  assert.ok(!f.calls.some(c=>c.method==="POST"));
});

test("removing during refresh cannot resurrect a card", async (t) => {
  let release;const wait=new Promise(r=>release=r);
  const f=fixture(t,async()=>{await wait;return {status:200,ok:true,data:{}};});
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  const pending=f.service.refresh();f.service.remove(key);release();
  assert.equal(await pending,null);
  assert.equal((await f.service.refresh()).accounts.length,0);
});

test("clear-all only clears the ChatGPT vault and preserves Grok files", (t) => {
  const f=fixture(t);const grok=path.join(f.root,"accounts.json");fs.writeFileSync(grok,"original-grok-data");
  f.service.importDocuments([encode(auth())]);f.service.clearAll();assert.equal(f.service.list().length,0);
  assert.equal(fs.readFileSync(grok,"utf8"),"original-grok-data");
});

test("reimport reports updates without creating duplicate cards", (t) => {
  const f=fixture(t);
  assert.equal(f.service.importDocuments([encode(auth())]).added,1);
  const result=f.service.importDocuments([encode([auth("a",{access_token:"replacement"}),auth("b")])]);
  assert.equal(result.added,1);assert.equal(result.updated,1);assert.equal(result.total,2);
});

test("directory import enforces total bytes before reading over-budget files", (t) => {
  const f=fixture(t);const dir=path.join(f.root,"large-import");fs.mkdirSync(dir);
  const document=encode({...auth(),padding:"x".repeat(950000)});
  for(let i=0;i<9;i++)fs.writeFileSync(path.join(dir,`${i}.json`),document);
  const read=fs.readFileSync;let reads=0;
  t.mock.method(fs,"readFileSync",function(file,...args){if(String(file).startsWith(dir))reads++;return read.call(this,file,...args);});
  assert.throws(()=>f.service.importPaths([dir]),/8 MiB/);
  assert.equal(reads,8);
  assert.ok(!fs.existsSync(path.join(f.root,"chatgpt-accounts.json")));
});

test("reset mutex blocks another click while awaiting confirmation", async (t) => {
  const f=fixture(t,(url,opts)=>({status:200,ok:true,data:opts.method==="POST"?{code:"reset"}:{available_count:1}}));
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  let release,started;const waiting=new Promise(r=>started=r);
  const first=f.service.consumeReset(key,()=>{started();return new Promise(r=>release=r);});
  await waiting;
  await assert.rejects(f.service.consumeReset(key,()=>true),/正在执行/);
  release(true);assert.equal((await first).outcome,"reset");
  assert.equal(f.calls.filter(c=>c.method==="POST").length,1);
});

test("reset refuses to POST unless its idempotency key is safely persisted", async (t) => {
  const f=fixture(t,()=>({status:200,ok:true,data:{available_count:1}}));
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  const encrypt=f.safeStorage.encryptString;
  await assert.rejects(f.service.consumeReset(key,()=>{f.safeStorage.encryptString=()=>{throw new Error("write failed");};return true;}),/write failed/);
  f.safeStorage.encryptString=encrypt;
  assert.equal(f.calls.filter(c=>c.method==="POST").length,0);assert.equal(f.service.hasPending(key),false);
});

test("unrecognized reset result stays pending and cancellation preserves its request id", async (t) => {
  const f=fixture(t,(url,opts)=>({status:200,ok:true,data:opts.method==="POST"?{code:"unexpected"}:{available_count:1}}));
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  await assert.rejects(f.service.consumeReset(key,()=>true),/结果待确认/);
  const original=JSON.parse(f.calls.find(c=>c.method==="POST").body).redeem_request_id;
  assert.equal(f.service.hasPending(key),true);
  assert.equal((await f.service.consumeReset(key,()=>false)).outcome,"cancelled");
  assert.equal(f.service.hasPending(key),true);
  f.respond((url,opts)=>({status:200,ok:true,data:opts.method==="POST"?{code:"already_redeemed"}:{available_count:0}}));
  await f.service.consumeReset(key,()=>true);
  const posts=f.calls.filter(c=>c.method==="POST");
  assert.equal(posts.length,2);assert.equal(JSON.parse(posts[1].body).redeem_request_id,original);
});

test("reset refuses an account removed while its confirmation was open", async (t) => {
  const f=fixture(t,()=>({status:200,ok:true,data:{available_count:1}}));
  f.service.importDocuments([encode(auth())]);const key=f.service.list()[0].entryKey;
  await assert.rejects(f.service.consumeReset(key,()=>{f.service.remove(key);return true;}),/账号不存在/);
  assert.equal(f.calls.filter(c=>c.method==="POST").length,0);
});

test("refresh bounds concurrency and errors never echo bearer credentials", async (t) => {
  let concurrent=0,max=0;
  const f=fixture(t,async()=>{
    concurrent++;max=Math.max(max,concurrent);
    await new Promise(r=>setTimeout(r,5));concurrent--;
    throw new Error("private-token-a");
  });
  f.service.importDocuments([encode(Array.from({length:8},(_,i)=>auth(String(i))))]);
  const result=await f.service.refresh();
  assert.equal(max,3);assert.equal(result.accounts.length,8);
  assert.ok(result.accounts.every(a=>a.error));assert.ok(!encode(result).includes("private-token"));
});

test("primary limit uses its duration, defaults to 5h, and keeps weekly labeling", async (t) => {
  const f=fixture(t);f.service.importDocuments([encode(auth())]);
  for (const [seconds,label] of [[undefined,"5h限额"],[18000,"5h限额"],[10800,"3h限额"],[5400,"1h30min限额"],[1800,"30min限额"],[90,"1.5min限额"],[0,"5h限额"],[-1,"5h限额"],["1800","5h限额"]]) {
    f.respond(()=>({status:200,ok:true,data:{rate_limit:{primary_window:{used_percent:20,limit_window_seconds:seconds},secondary_window:{used_percent:30}}}}));
    const result=await f.service.refresh();
    assert.deepEqual(result.accounts[0].metrics.map(metric=>metric.label),[label,"周限额"]);
    assert.equal(result.accounts[0].weeklyPercent,30);
  }
});

test("plan display normalizes known names and preserves unknown subscriptions", async (t) => {
  const f=fixture(t);f.service.importDocuments([encode(auth("a",{plan_type:"team"}))]);
  for(const [value,expected] of [["team","Team"],[" PLUS ","Plus"],["pro","Pro"],["free","Free"],["enterprise","Enterprise"],["business","Business"],["edu","Edu"],["go","Go"],["Future Custom","Future Custom"],["","Team"],[undefined,"Team"]]) {
    f.respond(()=>({status:200,ok:true,data:{plan_type:value}}));
    assert.equal((await f.service.refresh()).accounts[0].planName,expected);
  }
});

test("full-email setting updates list, refreshed cards and cached cards without exposing credentials", async (t) => {
  const f=fixture(t);let show=false;
  const service=createService({...f.options,getShowFullEmails:()=>show});
  service.importDocuments([encode(auth("display"))]);
  let card=(await service.refresh()).accounts[0];
  assert.equal(card.title,"di***@example.com");assert.equal(card.emailDisplay,card.title);
  assert.equal(service.list()[0].emailDisplay,card.title);
  show=true;
  assert.equal(service.list()[0].title,"display@example.com");
  assert.equal(service.list()[0].emailMasked,"di***@example.com");
  assert.equal(service.getLastUsage().accounts[0].emailDisplay,"display@example.com");
  assert.equal(service.getLastUsage().accounts[0].title,"display@example.com");
  assert.equal(f.calls.length,1);
  card=(await service.refresh()).accounts[0];assert.equal(card.title,"display@example.com");
  assert.equal(card.emailMasked,"di***@example.com");
  show=false;
  assert.equal(service.getLastUsage().accounts[0].title,"di***@example.com");
  assert.ok(!encode(service.getLastUsage()).includes("display@example.com"));
  assert.ok(!encode(service.list()).includes("private-token"));
  assert.ok(!encode(card).includes("private-token"));
});

test("local account follows email setting and preserves its existing masked fields", async (t) => {
  const f=fixture(t);let show=false;
  fs.writeFileSync(path.join(f.root,"native-auth.json"),encode({email:"local@example.com",tokens:{access_token:"native",account_id:"native-a"}}));
  const service=createService({...f.options,getShowFullEmails:()=>show});
  assert.equal(service.list()[0].emailMasked,"本机 Codex");
  assert.equal(service.list()[0].emailDisplay,"lo***@example.com");
  const card=(await service.refresh()).accounts[0];
  assert.equal(card.emailMasked,"lo***@example.com");
  show=true;
  assert.equal(service.list()[0].title,"local@example.com");
  assert.equal(service.getLastUsage().accounts[0].title,"local@example.com");
  fs.unlinkSync(path.join(f.root,"native-auth.json"));show=false;
  assert.equal(service.getLastUsage().accounts.length,0);
});

test("email setting changed during an active request applies before refresh returns", async (t) => {
  let release;const wait=new Promise(resolve=>release=resolve);
  const f=fixture(t,async()=>{await wait;return {status:200,ok:true,data:{}};});
  let show=true;const service=createService({...f.options,getShowFullEmails:()=>show});
  service.importDocuments([encode(auth("display"))]);
  const pending=service.refresh();show=false;release();
  assert.equal((await pending).accounts[0].title,"di***@example.com");
});
