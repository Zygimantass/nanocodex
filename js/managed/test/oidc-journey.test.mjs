import assert from "node:assert/strict";
import { test } from "node:test";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { build } from "esbuild";
import { Miniflare } from "miniflare";

// Public HTTP routes and real SQLite DOs; only the external OIDC provider and
// wallet broker are synthetic. RS256 tokens, nonce, S256 PKCE and client checks
// deliberately match TSIDP. curl retains every request and response for review.
const run = promisify(execFile);
const issuer = "https://idp.synthetic-tailnet.ts.net";
const client = "synthetic-nanocodex";
const secret = "synthetic-client-secret";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "RS256", use: "sig" };
const encode = value => Buffer.from(JSON.stringify(value)).toString("base64url");

test("OIDC browser sign-in binds identity, survives restart, rejects invalid tokens and has no SMS bypass", { timeout: 120_000 }, async t => {
  const output = new URL("../../../output/oidc/", import.meta.url);
  await mkdir(output, { recursive: true });
  const persistence = await mkdtemp(join(tmpdir(), "nanocodex-oidc-"));
  const trace = [], codes = new Map();
  let exchangeCount = 0, sequence = 0, passed = false, gate, failWallet = false;
  const wallets = new Map();
  const bundle = await build({
    stdin: { contents: `
import { routeAccountRequest } from "./src/account-auth.ts";
export { UserAccount, Organization, ApiKeyRecord, NonceStorage } from "./src/account-auth.ts";
export default { async fetch(request, env) {
 return await routeAccountRequest(request, env, new URL(request.url)) ?? new Response(null, {status:404});
}};`, resolveDir: fileURLToPath(new URL("..", import.meta.url)) },
    bundle: true, write: false, format: "esm", target: "es2022", platform: "browser",
    external: ["cloudflare:workers", "node:*"],
    alias: { "node-rsa": "./node_modules/nanocodex/tools/browser/unsupportedNodeRsa.mjs" },
  });
  const options = {
    durableObjectsPersist: persistence, modules: true, script: bundle.outputFiles[0].text,
    compatibilityDate: "2026-07-29", compatibilityFlags: ["nodejs_compat"],
    bindings: { ENVIRONMENT: "test", NANOCODEX_OIDC_ISSUER: issuer,
      NANOCODEX_OIDC_CLIENT_ID: client, NANOCODEX_OIDC_CLIENT_SECRET: secret,
      NANOCODEX_OIDC_REDIRECT_URI: "http://127.0.0.1/v1/auth/oidc/callback",
      NANOCODEX_OIDC_LABEL: "Tailscale", NANOCODEX_OIDC_ONLY: "true" },
    serviceBindings: { NANOCODEX: async request => {
      const userId = new URL(request.url).pathname.split("/")[2];
      if (request.method === "PUT") {
        if (failWallet) return new Response(null, { status: 503 });
        if (!wallets.has(userId)) wallets.set(userId, { address: `0x${(wallets.size + 1).toString(16).padStart(40, "0")}`, created_at: 1 });
      }
      return Response.json(wallets.get(userId) ?? {}, { status: wallets.has(userId) ? 200 : 404 });
    } },
    durableObjects: Object.fromEntries(Object.entries({ NANOCODEX_AUTH: "NonceStorage",
      NANOCODEX_USERS: "UserAccount", NANOCODEX_ORGANIZATIONS: "Organization", NANOCODEX_API_KEYS: "ApiKeyRecord" })
      .map(([name, className]) => [name, { className, useSQLite: true }])),
    outboundService: async request => {
      const url = new URL(request.url);
      assert.equal(url.origin, issuer, "no live external service calls");
      if (url.pathname === "/.well-known/openid-configuration") return Response.json({
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/.well-known/jwks.json`, response_types_supported: ["code"],
        subject_types_supported: ["public"], id_token_signing_alg_values_supported: ["RS256"],
        token_endpoint_auth_methods_supported: ["client_secret_basic"], code_challenge_methods_supported: ["S256"],
      });
      if (url.pathname === "/.well-known/jwks.json") return Response.json({ keys: [jwk] });
      assert.equal(url.pathname, "/token");
      const basic = request.headers.get("authorization");
      assert.ok(basic?.startsWith("Basic "));
      assert.deepEqual(Buffer.from(basic.slice(6), "base64").toString().split(":").map(decodeURIComponent), [client, secret]);
      const form = new URLSearchParams(await request.text());
      const attempt = codes.get(form.get("code"));
      assert.ok(attempt, "authorization codes are one-use");
      codes.delete(form.get("code"));
      exchangeCount++;
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("redirect_uri"), options.bindings.NANOCODEX_OIDC_REDIRECT_URI);
      assert.equal(createHash("sha256").update(form.get("code_verifier")).digest("base64url"), attempt.challenge);
      if (gate) { const held = gate; gate = undefined; held.enter(); await held.wait; }
      if (attempt.mode === "unavailable") return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      const now = Math.floor(Date.now() / 1000);
      const claims = { iss: issuer, sub: attempt.subject, aud: client, iat: now, exp: now + 300,
        nonce: attempt.nonce, email: attempt.email, ...attempt.claims };
      const data = `${encode({ alg: "RS256", kid: "fixture" })}.${encode(claims)}`;
      let signature = sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
      if (attempt.mode === "signature") signature = (signature[0] === "A" ? "B" : "A") + signature.slice(1);
      return Response.json({ access_token: "synthetic-access", token_type: "Bearer", expires_in: 300,
        id_token: `${data}.${signature}` });
    },
  };
  let mf = new Miniflare(options), base;
  async function http(label, path, { body, cookie, origin, expected = 200, method, token } = {}) {
    const name = String(++sequence).padStart(3, "0") + "-" + label.replace(/[^a-z0-9]+/gi, "-");
    const headersPath = fileURLToPath(new URL(`${name}.headers`, output));
    const bodyPath = fileURLToPath(new URL(`${name}.response`, output));
    const args = ["--silent", "--show-error", "--max-time", "20", "--dump-header", headersPath,
      "--output", bodyPath, "--write-out", "%{http_code}", "--request", method ?? (body === undefined ? "GET" : "POST"),
      "--header", `Origin: ${origin ?? base.origin}`];
    if (cookie) args.push("--header", `Cookie: ${cookie}`);
    if (token) args.push("--header", `Authorization: Bearer ${token}`);
    if (body !== undefined) args.push("--header", "Content-Type: application/json", "--data-binary", JSON.stringify(body));
    args.push(new URL(path, base).href);
    await writeFile(new URL(`${name}.request.json`, output), JSON.stringify({ method: method ?? (body === undefined ? "GET" : "POST"), path, body, cookie, origin, token }, null, 2));
    const { stdout } = await run("curl", args);
    const headers = await readFile(headersPath, "utf8"), text = await readFile(bodyPath, "utf8");
    const status = Number(stdout);
    trace.push({ label, expected, observed: status });
    assert.equal(status, expected, `${label}: ${text}`);
    return { headers, value: text ? JSON.parse(text) : undefined,
      location: headers.match(/^location: (.+)\r?$/mi)?.[1].trim(),
      cookie: headers.match(/^set-cookie: (nanocodex_account=[^;]+)/mi)?.[1],
      browser: headers.match(/^set-cookie: (nanocodex_oidc=[^;]+)/mi)?.[1] };
  }
  async function start(label, changes = {}) {
    const result = await http(label, "/v1/auth/oidc/start", { body: { return_to: "/account?tab=keys#token" } });
    const authorization = new URL(result.value.authorization_url);
    assert.equal(authorization.origin, issuer);
    assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
    assert.equal(authorization.searchParams.get("scope"), "openid email profile");
    const code = `synthetic-code-${sequence}`;
    codes.set(code, { nonce: authorization.searchParams.get("nonce"), challenge: authorization.searchParams.get("code_challenge"),
      subject: "tailscale-user-101", email: "first@example.test", ...changes });
    return { ...result, callback: `/v1/auth/oidc/callback?code=${code}&state=${authorization.searchParams.get("state")}` };
  }
  const complete = (label, attempt, cookie = attempt.browser) => http(label, attempt.callback, { cookie, expected: 303 });
  async function success(label, attempt) {
    const result = await complete(label, attempt);
    assert.equal(result.location, new URL("/account?tab=keys#token", base).href);
    assert.match(result.cookie, /^nanocodex_account=o_/);
    assert.match(result.headers, /Max-Age=28800; HttpOnly; SameSite=Lax/i);
    const me = await http(`${label} usable account`, "/v1/me", { cookie: result.cookie });
    assert.equal(me.value.user.persistent, true);
    assert.equal(me.value.user.address, wallets.get(me.value.user.id).address);
    return { ...result, user: me.value.user.id };
  }
  async function restart() {
    await mf.dispose(); mf = new Miniflare(options); base = await mf.ready;
  }
  try {
    base = await mf.ready;
    options.port = Number(base.port);
    options.bindings.NANOCODEX_OIDC_REDIRECT_URI = `${base.origin}/v1/auth/oidc/callback`;
    await mf.setOptions(options); base = await mf.ready;
    assert.deepEqual((await http("discover OIDC-only", "/v1/auth/methods")).value, { sms: false, oidc: { label: "Tailscale" } });
    await http("anonymous is disabled", "/v1/me", { expected: 401 });
    await http("SMS start cannot bypass OIDC", "/v1/auth/sms/start", { body: { phone: "+12025550161" }, expected: 403 });
    await http("SMS verify cannot bypass OIDC", "/v1/auth/sms/verify", { body: {}, expected: 403 });
    await http("passkey login cannot bypass OIDC", "/webauthn/login/options", { body: {}, expected: 403 });
    await http("cross-origin start blocked", "/v1/auth/oidc/start", { body: {}, origin: "https://evil.example", expected: 403 });
    for (const return_to of ["//evil.example/", "/\\evil.example", "/v1/auth/logout"]) {
      await http("unsafe return blocked", "/v1/auth/oidc/start", { body: { return_to }, expected: 400 });
    }
    const first = await start("begin browser login");
    await restart();
    assert.equal((await complete("different browser rejected", first, "nanocodex_oidc=" + "A".repeat(43))).cookie, undefined);
    const loggedIn = await success("complete after restart", first);
    const calls = exchangeCount;
    assert.equal((await complete("callback replay rejected", first)).cookie, undefined);
    assert.equal(exchangeCount, calls);
    const repeated = await success("email change retains stable subject", await start("returning login", { email: "renamed@example.test" }));
    assert.equal(repeated.user, loggedIn.user);
    const other = await success("different subject stays separate", await start("other subject", { subject: "tailscale-user-202" }));
    assert.notEqual(other.user, loggedIn.user);
    const key = await http("create explicit API key", "/v1/api-keys", { body: { label: "Synthetic CLI" }, cookie: loggedIn.cookie, expected: 201 });
    await http("API key works in OIDC-only mode", "/v1/me", { token: key.value.api_key });
    await http("logout", "/v1/auth/logout", { body: {}, cookie: loggedIn.cookie, expected: 204 });
    assert.equal((await http("logged-out cookie rejected", "/v1/me", { cookie: loggedIn.cookie, expected: 401 })).value.error, "reauthentication_required");
    for (const [name, changes] of [
      ["bad signature", { mode: "signature" }], ["wrong nonce", { claims: { nonce: "wrong" } }],
      ["wrong audience", { claims: { aud: "other-client" } }], ["wrong issuer", { claims: { iss: "https://evil.example" } }],
      ["expired token", { claims: { exp: 1 } }], ["provider failure", { mode: "unavailable" }],
    ]) {
      const attempt = await start(`start ${name}`, changes), failure = await complete(name, attempt);
      assert.equal(failure.cookie, undefined);
      assert.match(failure.location, /auth_error=oidc_login_failed/);
      assert.equal((await complete(`${name} cannot be replayed`, attempt)).cookie, undefined);
    }
    const concurrent = await start("concurrent callback");
    let enter, release;
    const entered = new Promise(resolve => { enter = resolve; });
    gate = { enter, wait: new Promise(resolve => { release = resolve; }) };
    const winning = success("first callback wins", concurrent);
    await entered;
    assert.equal((await complete("second callback rejected during exchange", concurrent)).cookie, undefined);
    release(); await winning;
    await success("subsequent login recovers", await start("fresh login after failures"));
    failWallet = true;
    const failedProvision = await start("new user before wallet failure", { subject: "tailscale-user-303" });
    assert.equal((await complete("wallet failure creates no session", failedProvision)).cookie, undefined);
    failWallet = false;
    await restart();
    const recoveredProvision = await success("fresh authorization recovers wallet provisioning", await start("retry wallet provisioning", { subject: "tailscale-user-303" }));
    assert.notEqual(recoveredProvision.user, loggedIn.user);
    options.bindings.NANOCODEX_OIDC_CLIENT_ID = "changed-client";
    await restart();
    await http("configuration change invalidates old sessions", "/v1/me", { cookie: repeated.cookie, expected: 401 });
    options.bindings.NANOCODEX_OIDC_CLIENT_ID = client;
    options.bindings.NANOCODEX_OIDC_ONLY = "false";
    options.bindings.ENVIRONMENT = "development";
    options.bindings.NANOCODEX_OTP_HMAC_KEY = "synthetic-oidc-sms-control-hmac-key";
    options.bindings.NANOCODEX_MOCK_TWILIO_VERIFY_CODE = "123456";
    await restart();
    assert.deepEqual((await http("mixed login methods", "/v1/auth/methods")).value, { sms: true, oidc: { label: "Tailscale" } });
    const anonymous = await http("mixed mode permits anonymous", "/v1/me");
    const challenge = await http("mixed mode SMS start", "/v1/auth/sms/start", { body: { phone: "+12025550161" }, expected: 202 });
    const sms = await http("mixed mode SMS login", "/v1/auth/sms/verify", { body: {
      phone: "+12025550161", challenge_id: challenge.value.challenge_id, code: "123456",
    } });
    options.bindings.NANOCODEX_OIDC_ONLY = "true";
    await restart();
    await http("existing anonymous cookie cannot bypass OIDC-only", "/v1/me", { cookie: anonymous.cookie, expected: 401 });
    await http("existing SMS cookie cannot bypass OIDC-only", "/v1/me", { cookie: sms.cookie, expected: 401 });
    await http("existing OIDC cookie remains valid", "/v1/me", { cookie: repeated.cookie });
    delete options.bindings.NANOCODEX_OIDC_CLIENT_SECRET;
    await restart();
    await http("incomplete config fails closed", "/v1/auth/methods", { expected: 503 });
    await http("incomplete config cannot create anonymous", "/v1/me", { expected: 401 });
    passed = true;
    t.diagnostic(`${trace.length} curl exchanges retained in output/oidc; real workerd/SQLite, synthetic IdP and wallet broker`);
  } finally {
    await writeFile(new URL("trace.json", output), JSON.stringify({ command: "pnpm --filter nanocodex-managed-service test:oidc", passed, trace }, null, 2));
    await mf.dispose();
    await rm(persistence, { recursive: true, force: true });
  }
});
