import * as oauth from "oauth4webapi";
import type { AccountAuthEnv } from "./account-auth";

const ATTEMPT_TTL_MS = 10 * 60_000;
const BROWSER_COOKIE = "nanocodex_oidc";
const RANDOM = /^[A-Za-z0-9_-]{43}$/;
export const OIDC_SESSION_SECONDS = 8 * 60 * 60;

export type OidcLoginAttempt = {
  browserHash: string;
  verifier: string;
  nonce: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  returnTo: string;
  expiresAt: number;
};

export interface OidcEnv {
  NANOCODEX_OIDC_ISSUER?: string;
  NANOCODEX_OIDC_CLIENT_ID?: string;
  NANOCODEX_OIDC_CLIENT_SECRET?: string;
  NANOCODEX_OIDC_REDIRECT_URI?: string;
  NANOCODEX_OIDC_LABEL?: string;
  NANOCODEX_OIDC_ONLY?: string;
  NANOCODEX_SELF_HOSTED?: string;
}

export const oidcOnly = (env: OidcEnv) => env.NANOCODEX_OIDC_ONLY === "true";

function configuration(env: AccountAuthEnv) {
  const values = [env.NANOCODEX_OIDC_ISSUER, env.NANOCODEX_OIDC_CLIENT_ID,
    env.NANOCODEX_OIDC_CLIENT_SECRET, env.NANOCODEX_OIDC_REDIRECT_URI];
  if (!values.some(Boolean) && !oidcOnly(env)) return undefined;
  if (values.some(value => !value || value.trim() !== value)) throw new Error("incomplete OIDC configuration");
  const issuer = new URL(values[0]!);
  const redirect = new URL(values[3]!);
  for (const url of [issuer, redirect]) {
    const local = env.ENVIRONMENT === "test" || env.ENVIRONMENT === "development";
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:"
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) throw new Error("invalid OIDC URL");
  }
  if (redirect.pathname !== "/v1/auth/oidc/callback") throw new Error("invalid OIDC callback");
  const label = env.NANOCODEX_OIDC_LABEL ?? "your organization";
  if (!label.trim() || label.length > 64) throw new Error("invalid OIDC label");
  return { issuer, issuerId: values[0]!, redirect, clientId: values[1]!, secret: values[2]!, label };
}

export function oidcSessionAllowed(env: AccountAuthEnv, issuer?: string, clientId?: string): boolean {
  try {
    const config = configuration(env);
    return !!config && issuer === config.issuerId && clientId === config.clientId;
  } catch { return false; }
}

function cookie(value: string, seconds: number, secure: boolean) {
  return `${BROWSER_COOKIE}=${value}; Path=/; Max-Age=${seconds}; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`;
}

async function hash(value: string): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
    byte => byte.toString(16).padStart(2, "0")).join("");
}

function returnPath(value: unknown, origin: string): string {
  if (typeof value !== "string" || value.length > 2048 || !value.startsWith("/")
    || value.startsWith("//") || /[\\\x00-\x20]/.test(value)) throw new Error("invalid return path");
  const url = new URL(value, origin);
  if (url.origin !== origin || url.pathname.startsWith("/v1/auth/")) throw new Error("invalid return path");
  return value;
}

/** The provider is configured by the operator, never by a request parameter. */
export async function routeOidcRequest(
  request: Request,
  env: AccountAuthEnv,
  createSession: (userId: string, issuer: string, clientId: string) => Promise<string>,
): Promise<Response> {
  const url = new URL(request.url);
  const callback = url.pathname === "/v1/auth/oidc/callback";
  let returnTo = "/";
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
  try {
    const config = configuration(env);
    if (url.pathname === "/v1/auth/methods") {
      if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
      return json({
        sms: !oidcOnly(env),
        selfHosted: !!config || env.NANOCODEX_SELF_HOSTED === "true",
        ...(config ? { oidc: { label: config.label } } : {}),
      });
    }
    if (!config) return json({ error: "not_found" }, 404);
    if (url.origin !== config.redirect.origin) return json({ error: "forbidden_origin" }, 403);
    const client: oauth.Client = { client_id: config.clientId, id_token_signed_response_alg: "RS256" };
    const transport = { signal: () => AbortSignal.timeout(10_000) };

    if (url.pathname === "/v1/auth/oidc/start") {
      if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
      if (request.headers.get("origin") !== url.origin) return json({ error: "forbidden_origin" }, 403);
      if (!request.headers.get("content-type")?.startsWith("application/json")) return json({ error: "expected_json" }, 415);
      const body = await request.text();
      if (body.length > 4096) return json({ error: "payload_too_large" }, 413);
      try { returnTo = returnPath(JSON.parse(body).return_to ?? "/", url.origin); }
      catch { return json({ error: "invalid_return_to" }, 400); }
      const server = await oauth.processDiscoveryResponse(config.issuer,
        await oauth.discoveryRequest(config.issuer, transport));
      if (server.issuer !== config.issuerId) throw new Error("issuer mismatch");
      if (!server.authorization_endpoint || !server.code_challenge_methods_supported?.includes("S256")) {
        throw new Error("OIDC provider must support PKCE S256");
      }
      const authorization = new URL(server.authorization_endpoint);
      if (authorization.protocol !== "https:") throw new Error("invalid authorization endpoint");
      const state = oauth.generateRandomState();
      const browser = oauth.generateRandomState();
      const verifier = oauth.generateRandomCodeVerifier();
      const nonce = oauth.generateRandomNonce();
      const attempt: OidcLoginAttempt = { browserHash: await hash(browser), verifier, nonce,
        issuer: config.issuerId, clientId: config.clientId, redirectUri: config.redirect.href,
        returnTo, expiresAt: Date.now() + ATTEMPT_TTL_MS };
      await env.NANOCODEX_AUTH.getByName(`oidc-attempt:${await hash(state)}`).putOidcAttempt(attempt);
      for (const [key, value] of Object.entries({ response_type: "code", client_id: config.clientId,
        redirect_uri: config.redirect.href, scope: "openid email profile", state, nonce,
        code_challenge: await oauth.calculatePKCECodeChallenge(verifier), code_challenge_method: "S256" })) {
        authorization.searchParams.set(key, value);
      }
      return Response.json({ authorization_url: authorization.href }, { headers: {
        "cache-control": "no-store", "set-cookie": cookie(browser, ATTEMPT_TTL_MS / 1000, url.protocol === "https:"),
      } });
    }

    if (!callback) return json({ error: "not_found" }, 404);
    if (request.method !== "GET") return json({ error: "method_not_allowed" }, 405);
    const state = url.searchParams.get("state");
    const browser = request.headers.get("cookie")?.split(";").map(part => part.trim())
      .find(part => part.startsWith(`${BROWSER_COOKIE}=`))?.slice(BROWSER_COOKIE.length + 1);
    if (!state || !RANDOM.test(state) || !browser || !RANDOM.test(browser)) throw new Error("missing OIDC transaction");
    // Consume before token exchange. An ambiguous exchange is never replayed;
    // retry starts a new authorization rather than reusing an authorization code.
    const attempt = await env.NANOCODEX_AUTH.getByName(`oidc-attempt:${await hash(state)}`)
      .takeOidcAttempt(await hash(browser));
    if (!attempt || attempt.issuer !== config.issuerId || attempt.clientId !== config.clientId
      || attempt.redirectUri !== config.redirect.href) throw new Error("invalid OIDC transaction");
    returnTo = returnPath(attempt.returnTo, url.origin);
    const server = await oauth.processDiscoveryResponse(config.issuer,
      await oauth.discoveryRequest(config.issuer, transport));
    if (server.issuer !== config.issuerId) throw new Error("issuer mismatch");
    const parameters = oauth.validateAuthResponse(server, client, url, state);
    const response = await oauth.authorizationCodeGrantRequest(server, client,
      oauth.ClientSecretBasic(config.secret), parameters, config.redirect.href, attempt.verifier, transport);
    const tokens = await oauth.processAuthorizationCodeResponse(server, client, response,
      { requireIdToken: true, expectedNonce: attempt.nonce });
    await oauth.validateApplicationLevelSignature(server, response, transport);
    const claims = oauth.getValidatedIdTokenClaims(tokens)!;
    const identity = await hash(JSON.stringify([config.issuerId, claims.sub]));
    const userId = await env.NANOCODEX_AUTH.getByName("oidc-identities").resolveOidcUser(identity);
    const sessionCookie = await createSession(userId, config.issuerId, config.clientId);
    const headers = new Headers({ location: new URL(returnTo, url.origin).href,
      "cache-control": "no-store", "referrer-policy": "no-referrer" });
    headers.append("set-cookie", sessionCookie);
    headers.append("set-cookie", cookie("", 0, url.protocol === "https:"));
    return new Response(null, { status: 303, headers });
  } catch {
    // Codes, tokens, client secrets, and upstream error bodies never enter logs,
    // browser error messages, or redirect query parameters.
    if (!callback) return json({ error: "oidc_unavailable" }, 503);
    const target = new URL(returnTo, url.origin);
    target.searchParams.set("auth_error", "oidc_login_failed");
    return new Response(null, { status: 303, headers: { location: target.href,
      "cache-control": "no-store", "referrer-policy": "no-referrer",
      "set-cookie": cookie("", 0, url.protocol === "https:") } });
  }
}
