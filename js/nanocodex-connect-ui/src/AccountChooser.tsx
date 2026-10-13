import { useEffect, useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { RequestIdentity } from "./RequestIdentity.js";
import { normalizeSmsPhone } from "./smsPhone.js";

const OTP_REQUEST_TIMEOUT_MS = 25_000;
const AUTH_METHODS_TIMEOUT_MS = 15_000;
const OIDC_LOGIN_FAILED = "oidc_login_failed";

export const OIDC_LOGIN_FAILURE_MESSAGE = "Sign-in didn’t complete. Try again.";

/** Public sign-in methods advertised by `GET /v1/auth/methods`. */
export type AuthMethods = Readonly<{
  sms: boolean;
  selfHosted?: boolean;
  oidc?: Readonly<{ label: string }> | undefined;
}>;

type AuthMethodsState =
  | Readonly<{ status: "loading" }>
  | Readonly<{ status: "ready"; methods: AuthMethods }>
  | Readonly<{ status: "error"; message: string }>;

const resolvedAuthMethods = new Map<string, AuthMethods>();
const pendingAuthMethods = new Map<string, Promise<AuthMethods>>();

/**
 * Reads the account service's configured sign-in methods. Successful results
 * are cached for the page lifetime; failures are retried on the next call.
 */
export function readAuthMethods(authOrigin = ""): Promise<AuthMethods> {
  const resolved = resolvedAuthMethods.get(authOrigin);
  if (resolved) return Promise.resolve(resolved);
  let pending = pendingAuthMethods.get(authOrigin);
  if (!pending) {
    pending = fetchAuthMethods(authOrigin).then((methods) => {
      resolvedAuthMethods.set(authOrigin, methods);
      return methods;
    }).finally(() => {
      pendingAuthMethods.delete(authOrigin);
    });
    pendingAuthMethods.set(authOrigin, pending);
  }
  return pending;
}

async function fetchAuthMethods(authOrigin: string): Promise<AuthMethods> {
  const response = await fetch(`${authOrigin}/v1/auth/methods`, {
    cache: "no-store",
    credentials: "include",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(AUTH_METHODS_TIMEOUT_MS),
  });
  // Account services that predate the methods route only offer SMS.
  if (response.status === 404) {
    await response.body?.cancel();
    return { sms: true };
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error("Couldn’t load sign-in options. Try again.");
  if (!isRecord(body) || typeof body.sms !== "boolean"
    || (body.selfHosted !== undefined && typeof body.selfHosted !== "boolean")) {
    throw new Error("The account service returned invalid sign-in options.");
  }
  const methods: AuthMethods = {
    sms: body.sms,
    ...(body.selfHosted !== undefined ? { selfHosted: body.selfHosted } : {}),
  };
  if (body.oidc === undefined || body.oidc === null) return methods;
  const label = isRecord(body.oidc) && typeof body.oidc.label === "string" ? body.oidc.label.trim() : "";
  if (!label || label.length > 64) {
    throw new Error("The account service returned invalid sign-in options.");
  }
  return { ...methods, oidc: { label } };
}

let oidcLoginFailure: boolean | undefined;
const oidcLoginFailureListeners = new Set<() => void>();

/**
 * Reports whether this page load returned from a failed OIDC sign-in. The
 * first call removes `auth_error=oidc_login_failed` from the current history
 * entry while preserving the rest of the path, query and hash.
 */
export function readOidcLoginFailure(): boolean {
  oidcLoginFailure ??= consumeOidcLoginFailureParameter();
  return oidcLoginFailure;
}

/** Dismisses a reported OIDC failure once the user starts another attempt. */
export function clearOidcLoginFailure(): void {
  if (!readOidcLoginFailure()) return;
  oidcLoginFailure = false;
  for (const listener of oidcLoginFailureListeners) listener();
}

/** Subscribes a component to the OIDC return failure until it is dismissed. */
export function useOidcLoginFailure(): boolean {
  return useSyncExternalStore(subscribeOidcLoginFailure, readOidcLoginFailure, () => false);
}

function subscribeOidcLoginFailure(listener: () => void): () => void {
  oidcLoginFailureListeners.add(listener);
  return () => {
    oidcLoginFailureListeners.delete(listener);
  };
}

function consumeOidcLoginFailureParameter(): boolean {
  if (typeof window === "undefined") return false;
  const { hash, pathname, search } = window.location;
  if (!search) return false;
  let failed = false;
  const kept = search.slice(1).split("&").filter((part) => {
    const separator = part.indexOf("=");
    const name = decodeQueryComponent(separator < 0 ? part : part.slice(0, separator));
    const value = separator < 0 ? "" : decodeQueryComponent(part.slice(separator + 1));
    if (name === "auth_error" && value === OIDC_LOGIN_FAILED) {
      failed = true;
      return false;
    }
    return true;
  });
  if (!failed) return false;
  const nextSearch = kept.length > 0 ? `?${kept.join("&")}` : "";
  try {
    window.history.replaceState(window.history.state, "", `${pathname}${nextSearch}${hash}`);
  } catch {
    // The failure message still renders when history cannot be rewritten.
  }
  return true;
}

function decodeQueryComponent(value: string): string {
  try {
    return decodeURIComponent(value.replaceAll("+", " "));
  } catch {
    return value;
  }
}

function currentReturnPath(): string {
  readOidcLoginFailure();
  const { hash, pathname, search } = window.location;
  return `${pathname}${search}${hash}`;
}

function oidcAuthorizationUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  if (url.protocol === "https:") return url.href;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return url.href;
  return undefined;
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost"
    || hostname.endsWith(".localhost")
    || hostname === "[::1]"
    || /^127(?:\.\d{1,3}){3}$/.test(hostname);
}

export type StoredPasskey = Readonly<{
  address: `0x${string}`;
  credentialId: string;
  current?: boolean | undefined;
  label?: string | undefined;
}>;

export type AccountSelection = Readonly<{
  address?: `0x${string}` | undefined;
  authentication?: "sms_otp" | undefined;
  current?: boolean | undefined;
  mode: "login" | "register";
  label: string;
  credentialId?: string | undefined;
  discoverCredential?: boolean | undefined;
}>;

type OtpChallenge = Readonly<{
  challengeId: string;
  expiresAt: number;
  phone: string;
}>;

export function AccountChooser({
  confirmationCode,
  appName,
  appOrigin,
  description,
  disabled,
  failure,
  requestContext,
  onCancel,
  onChooseAccount,
  authOrigin = "",
}: Readonly<{
  appName?: string;
  appOrigin?: string;
  authOrigin?: string | undefined;
  confirmationCode?: string | undefined;
  description?: string | undefined;
  disabled: boolean;
  failure?: string | null | undefined;
  requestContext?: ReactNode;
  newAccountDetail?: string | undefined;
  onCancel?: (() => void) | undefined;
  onChooseAccount(account: AccountSelection): void;
  storedPasskeys?: readonly StoredPasskey[] | undefined;
}>) {
  const phoneId = useId();
  const codeId = useId();
  const formId = useId();
  const codeHintId = useId();
  const failureId = useId();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge>();
  const [operation, setOperation] = useState<"send" | "verify" | "oidc">();
  const [localFailure, setLocalFailure] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const oidcFailure = useOidcLoginFailure();
  const [methodsAttempt, setMethodsAttempt] = useState(0);
  const [methodsState, setMethodsState] = useState<AuthMethodsState>(() => {
    const methods = resolvedAuthMethods.get(authOrigin);
    return methods ? { status: "ready", methods } : { status: "loading" };
  });

  useEffect(() => {
    let current = true;
    const methods = resolvedAuthMethods.get(authOrigin);
    if (methods) {
      setMethodsState({ status: "ready", methods });
      return;
    }
    setMethodsState({ status: "loading" });
    readAuthMethods(authOrigin).then((next) => {
      if (current) setMethodsState({ status: "ready", methods: next });
    }, (cause: unknown) => {
      if (current) setMethodsState({ status: "error", message: methodsErrorMessage(cause) });
    });
    return () => {
      current = false;
    };
  }, [authOrigin, methodsAttempt]);

  useEffect(() => {
    // A page restored from the back/forward cache after leaving for the
    // identity provider must not stay stuck in its redirecting state.
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setOperation(undefined);
    };
    window.addEventListener("pageshow", restore);
    return () => window.removeEventListener("pageshow", restore);
  }, []);

  async function startOidc() {
    if (disabled || operation || methodsState.status !== "ready" || !methodsState.methods.oidc) return;
    const label = methodsState.methods.oidc.label;
    setOperation("oidc");
    setLocalFailure(undefined);
    setNotice(undefined);
    clearOidcLoginFailure();
    try {
      const response = await fetch(`${authOrigin}/v1/auth/oidc/start`, {
        method: "POST",
        credentials: "include",
        headers: { accept: "application/json", "content-type": "application/json" },
        body: JSON.stringify({ return_to: currentReturnPath() }),
        signal: AbortSignal.timeout(OTP_REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(`Couldn’t start sign-in with ${label}. Try again.`);
      const authorizationUrl = isRecord(body) ? oidcAuthorizationUrl(body.authorization_url) : undefined;
      if (!authorizationUrl) throw new Error("The account service returned an invalid sign-in address.");
      window.location.assign(authorizationUrl);
    } catch (cause) {
      setLocalFailure(cause instanceof TypeError
        ? "Couldn’t reach the account service. Try again."
        : errorMessage(cause));
      setOperation(undefined);
    }
  }

  async function sendCode() {
    if (disabled || operation) return;
    clearOidcLoginFailure();
    const normalized = normalizeSmsPhone(phone);
    if (!normalized) {
      setLocalFailure(/^\d{6}$/.test(phone.trim())
        ? "That looks like a verification code. First enter your mobile number; we’ll ask for the code next."
        : "Enter a valid mobile number with its country code, like +30 697 123 4567.");
      return;
    }
    setPhone(normalized);
    setOperation("send");
    setLocalFailure(undefined);
    setNotice(undefined);
    try {
      const response = await fetch(`${authOrigin}/v1/auth/sms/start`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone: normalized }),
        signal: AbortSignal.timeout(OTP_REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(otpError(body, "Couldn’t send the code."));
      if (!isRecord(body)
        || typeof body.challenge_id !== "string"
        || typeof body.expires_in !== "number") {
        throw new Error("The account service returned an invalid challenge.");
      }
      setChallenge({
        challengeId: body.challenge_id,
        expiresAt: Date.now() + body.expires_in * 1_000,
        phone: normalized,
      });
      setCode("");
      if (challenge) setNotice("Another code was sent. Check your messages.");
    } catch (cause) {
      setLocalFailure(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function verifyCode() {
    if (!challenge || disabled || operation) return;
    if (!/^\d{6}$/.test(code)) {
      setLocalFailure("Enter the six-digit code from the message.");
      return;
    }
    setOperation("verify");
    setLocalFailure(undefined);
    try {
      const response = await fetch(`${authOrigin}/v1/auth/sms/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge_id: challenge.challengeId,
          code,
          phone: challenge.phone,
        }),
        signal: AbortSignal.timeout(OTP_REQUEST_TIMEOUT_MS),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(otpError(body, "That code didn’t work."));
      if (!isRecord(body) || !isRecord(body.user)
        || typeof body.user.id !== "string"
        || (body.user.address !== undefined
          && (typeof body.user.address !== "string"
            || !/^0x[0-9a-f]{40}$/.test(body.user.address)))) {
        throw new Error("The account service returned an invalid session.");
      }
      onChooseAccount({
        ...(body.user.address ? { address: body.user.address as `0x${string}` } : {}),
        authentication: "sms_otp",
        current: true,
        label: maskedPhone(challenge.phone),
        mode: "login",
      });
    } catch (cause) {
      setLocalFailure(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  const unavailable = disabled || operation !== undefined;
  const visibleFailure = localFailure ?? (failure || (oidcFailure ? OIDC_LOGIN_FAILURE_MESSAGE : undefined));
  const methods = methodsState.status === "ready" ? methodsState.methods : undefined;
  const smsEnabled = methods?.sms === true;
  const oidc = methods?.oidc;
  const oidcButtonLabel = operation === "oidc" ? "Redirecting…" : oidc ? `Sign in with ${oidc.label}` : "";
  return (
    <div className="wizard-page wizard-account-page">
      <section className="sms-auth-panel" aria-labelledby={`${phoneId}-heading`}>
        <div className="sms-auth-content">
        <header className="wizard-intro">
          <RequestIdentity name={appName ?? "Nanocodex"} origin={appOrigin} />
          <div className="wizard-app">
            <h1 id={`${phoneId}-heading`}>{challenge ? "Check your messages" : `Sign in to ${appName ?? "Nanocodex"}`}</h1>
            {challenge ? <p>Enter the code sent to {maskedPhone(challenge.phone)}.</p> : description ? <p>{description}</p> : null}
          </div>
          {confirmationCode ? (
            <div className="wizard-terminal-code" role="status">
              <span>Terminal code</span>
              <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
            </div>
          ) : null}
        </header>

        {visibleFailure ? (
          <div className="account-failure" id={failureId} role="alert"><p>{visibleFailure}</p></div>
        ) : null}
        {requestContext ? <div className="wizard-sections">{requestContext}</div> : null}

        {methodsState.status === "loading" ? (
          <p className="session-check-status" role="status">Loading sign-in options…</p>
        ) : methodsState.status === "error" ? (
          <div className="account-failure" role="alert"><p>{methodsState.message}</p></div>
        ) : !smsEnabled && !oidc ? (
          <div className="account-failure" role="alert"><p>Sign-in is unavailable right now. Try again later.</p></div>
        ) : null}

        {!smsEnabled ? null : !challenge ? (
          <form id={formId} key="phone" className="sms-otp-form" aria-busy={operation === "send"} noValidate onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}>
          <label htmlFor={phoneId}>Mobile number</label>
          <div className="sms-otp-input-row">
            <input
              aria-describedby={visibleFailure ? failureId : undefined}
              aria-invalid={localFailure ? true : undefined}
              autoComplete="tel"
              autoFocus
              disabled={unavailable}
              id={phoneId}
              inputMode="tel"
              onChange={(event) => {
                setPhone(event.target.value);
                setLocalFailure(undefined);
              }}
              placeholder="+1 202 555 0100"
              required
              type="tel"
              value={phone}
            />
          </div>
        </form>
      ) : (
        <form id={formId} key="code" className="sms-otp-form" aria-busy={operation !== undefined} noValidate onSubmit={(event) => {
          event.preventDefault();
          void verifyCode();
        }}>
          <label htmlFor={codeId}>6-digit code</label>
          <p id={codeHintId}>Code expires at {new Date(challenge.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
          <div className="sms-otp-input-row">
            <input
              aria-describedby={`${codeHintId}${visibleFailure ? ` ${failureId}` : ""}`}
              aria-invalid={localFailure ? true : undefined}
              autoComplete="one-time-code"
              autoFocus
              disabled={unavailable}
              id={codeId}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => {
                setCode(event.target.value.replace(/\D/g, "").slice(0, 6));
                setLocalFailure(undefined);
              }}
              pattern="[0-9]{6}"
              placeholder="000000"
              required
              value={code}
            />
          </div>
          <div className="sms-otp-recovery">
            <button disabled={unavailable} onClick={() => { void sendCode(); }} type="button">
              {operation === "send" ? "Sending…" : "Resend code"}
            </button>
            <button disabled={unavailable} onClick={() => {
              setChallenge(undefined);
              setCode("");
              setLocalFailure(undefined);
              setNotice(undefined);
            }} type="button">Change number</button>
          </div>
          <p role="status">{notice}</p>
        </form>
      )}
        {smsEnabled && oidc && !challenge ? (
          <div className="sms-otp-recovery">
            <button aria-busy={operation === "oidc"} disabled={unavailable} onClick={() => { void startOidc(); }} type="button">
              {oidcButtonLabel}
            </button>
          </div>
        ) : null}
        </div>
        <div className="sms-auth-actions">
          {onCancel ? <button disabled={unavailable} onClick={onCancel} type="button">Cancel</button> : null}
          {methodsState.status === "loading" ? (
            <button disabled type="button">Loading…</button>
          ) : methodsState.status === "error" ? (
            <button disabled={unavailable} onClick={() => setMethodsAttempt((attempt) => attempt + 1)} type="button">Try again</button>
          ) : smsEnabled ? (
            <button disabled={unavailable} form={formId} type="submit">
              {operation === "verify" ? "Checking…" : challenge ? "Continue" : operation === "send" ? "Sending…" : "Text me a code"}
            </button>
          ) : oidc ? (
            <button aria-busy={operation === "oidc"} disabled={unavailable} onClick={() => { void startOidc(); }} type="button">
              {oidcButtonLabel}
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}

export function orderedPasskeys(storedPasskeys: readonly StoredPasskey[]): readonly StoredPasskey[] {
  return storedPasskeys.some((account) => account.current)
    ? [...storedPasskeys].sort((left, right) => Number(right.current === true) - Number(left.current === true))
    : storedPasskeys;
}

function maskedPhone(value: string): string {
  const normalized = value.replace(/\D/g, "");
  return normalized.length > 4 ? `+••• ••${normalized.slice(-4)}` : "your phone";
}

function otpError(value: unknown, fallback: string): string {
  if (!isRecord(value) || typeof value.error !== "string") return fallback;
  if (value.error === "rate_limited") return "Too many codes requested. Wait a minute and try again.";
  if (value.error === "invalid_phone") return "Enter a mobile number with its country code.";
  if (value.error === "invalid_or_expired_otp") return "That code is invalid or expired.";
  if (value.error === "invalid_otp") return "Enter the six-digit code from the message.";
  if (value.error === "sms_delivery_failed") return "The code could not be delivered. Try again.";
  if (value.error === "sms_verification_failed") return "The code could not be checked right now. Try again.";
  if (value.error === "wallet_unavailable") return "Your account key could not be prepared. Try again.";
  if (value.error === "sms_otp_unavailable" || value.error === "sms_identity_unavailable") {
    return "Phone sign-in is temporarily unavailable. Try again.";
  }
  return fallback;
}

function errorMessage(value: unknown): string {
  if (value instanceof DOMException && (value.name === "TimeoutError" || value.name === "AbortError")) {
    return "The account service took too long to respond. Try again.";
  }
  return value instanceof Error ? value.message : "The account service is unavailable.";
}

function methodsErrorMessage(value: unknown): string {
  if (value instanceof DOMException && (value.name === "TimeoutError" || value.name === "AbortError")) {
    return "Loading sign-in options took too long. Try again.";
  }
  if (value instanceof TypeError) return "Couldn’t reach the account service to load sign-in options. Try again.";
  return value instanceof Error ? value.message : "Couldn’t load sign-in options. Try again.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
