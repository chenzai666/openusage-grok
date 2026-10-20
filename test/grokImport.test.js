const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// Electron's npm entry point can auto-download its binary; these parser tests
// need the real Grok parser/decoder, but no Electron runtime or credential API.
const electronPath = require.resolve("electron");
const cachedElectron = require.cache[electronPath];
let importer;
try {
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: {} };
  importer = require("../lib/cliproxyImport");
} finally {
  if (cachedElectron) require.cache[electronPath] = cachedElectron;
  else delete require.cache[electronPath];
}
const { parseText, scanDir, normalizeOne } = importer;

const jwt = (claims) => [
  Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
  Buffer.from(JSON.stringify({ sub: "synthetic-user", email: "synthetic@example.com", ...claims })).toString("base64url"),
  "synthetic-signature",
].join(".");
const xai = () => ({ type: "xai", access_token: jwt({ iss: "https://auth.x.ai" }), refresh_token: "synthetic-xai-refresh", email: "synthetic@example.com" });
const codex = () => ({ type: "codex", access_token: jwt({ iss: "https://auth.openai.com" }), refresh_token: "synthetic-codex-refresh", email: "synthetic@example.com" });
const parse = (value) => parseText(JSON.stringify(value));

test("Grok import rejects explicit non-Grok providers before permissive token fallback", () => {
  for (const label of ["codex", "chatgpt", "openai", "claude", "gemini"]) {
    for (const field of ["type", "provider"]) {
      const raw = { ...xai(), [field]: label };
      assert.equal(normalizeOne(raw), null);
      assert.equal(parse(raw).entries.length, 0);
    }
  }
  assert.equal(parse({ ...xai(), type: "xai", provider: "codex" }).entries.length, 0);
  assert.equal(parse({ ...xai(), type: "codex", provider: "xai" }).entries.length, 0);
});

test("Grok import rejects Codex JWTs with or without type and in every input path", () => {
  const raw = codex();
  const unlabeled = { ...raw };delete unlabeled.type;
  for (const value of [raw, unlabeled, { ...raw, type: "xai" }, [raw], { accounts: [raw] }, { files: [raw] }, { items: [unlabeled] }]) {
    assert.equal(parse(value).entries.length, 0);
  }
  assert.equal(parseText(raw.access_token).entries.length, 0);
  assert.equal(parseText("Bearer " + raw.access_token).entries.length, 0);
  assert.equal(parse([raw.access_token]).entries.length, 0);
});

test("foreign provider envelopes cannot relabel nested issuer-less tokens as Grok", () => {
  const legacy = { access_token: jwt({}), refresh_token: "synthetic-refresh", email: "synthetic@example.com" };
  assert.equal(parse({ type: "codex", accounts: [legacy] }).entries.length, 0);
  assert.equal(parse({ provider: "openai", data: legacy }).entries.length, 0);
});

test("issuer classification checks actual HTTPS x.ai hosts rather than substring matches", () => {
  for (const issuer of ["https://auth.openai.com", "https://auth.x.ai.evil.example", "https://evil.example/x.ai", "https://evil.example/?issuer=auth.x.ai", "http://auth.x.ai", ["https://auth.x.ai", "evil.example"].join("@"), ["https://evil.example", "auth.x.ai"].join("@"), "not-a-url"]) {
    assert.equal(parse({ ...xai(), access_token: jwt({ iss: issuer }) }).entries.length, 0, issuer);
  }
  for (const issuer of ["https://x.ai", "https://auth.x.ai", "https://auth.x.ai/", "https://auth.x.ai/oauth2"]) {
    assert.equal(parse({ ...xai(), access_token: jwt({ iss: issuer }) }).entries.length, 1, issuer);
  }
});

test("conflicting ID-token or endpoint issuers cannot override an xAI label", () => {
  assert.equal(parse({ ...xai(), id_token: codex().access_token }).entries.length, 0);
  assert.equal(parse({ ...codex(), id_token: xai().access_token }).entries.length, 0);
  for (const field of ["oidc_issuer", "token_endpoint"]) {
    assert.equal(parse({ ...xai(), [field]: "https://auth.openai.com/oauth/token" }).entries.length, 0);
    assert.equal(parse({ ...xai(), [field]: "https://auth.x.ai/oauth2/token" }).entries.length, 1);
  }
});

test("legacy unlabeled issuer-less Grok exports and known provider aliases still import", () => {
  const token = jwt({});
  for (const type of ["xai", "grok", "xai-oauth", "xai_oauth", " XAI "]) {
    assert.equal(parse({ type, access_token: token, refresh_token: "synthetic-refresh", email: "synthetic@example.com" }).entries.length, 1);
  }
  assert.equal(parse({ access_token: token, refresh_token: "synthetic-refresh", email: "synthetic@example.com" }).entries.length, 1);
  assert.equal(parseText(token).entries.length, 1);
  assert.equal(parse([token]).entries.length, 1);
});

test("mixed directory scan imports only Grok and leaves every source file unchanged", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "grok-import-provider-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const contents = { "xai-synthetic.json": JSON.stringify(xai()), "codex-synthetic.json": JSON.stringify(codex()), "malformed.json": "{", "mixed.json": JSON.stringify({ accounts: [xai(), codex()] }) };
  for (const [name, content] of Object.entries(contents)) fs.writeFileSync(path.join(dir, name), content);
  const result = scanDir(dir);
  assert.equal(result.entries.length, 1);
  assert.ok(result.files.includes("xai-synthetic.json"));assert.ok(result.files.includes("mixed.json"));
  assert.ok(!result.files.includes("codex-synthetic.json"));
  assert.ok(!JSON.stringify(result).includes("synthetic-codex-refresh"));
  assert.ok(!result.entries.some((entry) => entry.access_token === codex().access_token));
  for (const [name, content] of Object.entries(contents)) assert.equal(fs.readFileSync(path.join(dir, name), "utf8"), content);
});

test("rejection errors never echo rejected access or refresh tokens", () => {
  const raw = codex(), result = parse(raw);
  assert.ok(result.error);assert.equal(result.entries.length, 0);
  assert.ok(!JSON.stringify(result).includes(raw.access_token));
  assert.ok(!JSON.stringify(result).includes(raw.refresh_token));
  const malformed = parseText("{\"access_token\":\"synthetic-secret");
  assert.ok(malformed.error);assert.ok(!JSON.stringify(malformed).includes("synthetic-secret"));
});
