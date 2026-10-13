# Managed login and hosted connections

This document covers the legacy Nanocodex Connect installation ceremony and
current first-party browser login. The current native CLI uses direct SMS or
an imported API key, not the browser ceremony below. Agents changing login,
Nanocodex Connect, Accounts device authorization, hosted-agent grants, or
connection onboarding must read it before editing those surfaces.

## Product contract

The commands are:

```text
nanocodex login
nanocodex connect <chatgpt|github|gmail|gdrive|x>...
```

"Login" means creating or signing into a Nanocodex account and authorizing this
Nanocodex installation. It does not mean logging directly into ChatGPT.
It requests the base hosted-agent, history, and memory capabilities only.

"Connect" means connecting one or more named hosted services and attaching them
to this installation. It may reuse an existing browser account session, but it
still uses an explicit installation authorization: selecting an account in the
browser does not itself grant the CLI access. Each request grants exactly the connectors
named on that command line; it never inherits hidden connector requirements from
an earlier account or installation grant.

The Account page is the persistent catalog for connecting, disconnecting, and
inspecting services independently of a CLI request. A CLI connect page is the
focused form of the same UI and shows only the connector named by the signed
request.

Figma is available in the account catalog as an **Add connection** preset for
`https://mcp.figma.com/mcp`. Add it, then choose **Connect** on the new Figma row
to authorize through the existing remote MCP OAuth flow. Connected rows support
**Revoke**; expired authorization uses **Reconnect**. Adding a connection does
not grant an installation access automatically. Use `nanocodex connect figma`
(or `nanocodex connect mcp.figma.com`) to authorize Figma for an installation.
Creation and OAuth failures leave the existing retry controls available.

[Figma's remote server documentation](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/)
requires Figma OAuth and says clients must be approved in its MCP catalog.
Provider approval failures are reported through the existing MCP error flow;
adding this preset does not bypass Figma's client approval policy.

The interactive CLI receives a scoped Nanocodex Connect grant. It must not
silently mint a general-purpose Nanocodex API key. API keys remain an explicit
operation for CI, curl, or another machine.

The device envelope still uses Tempo Accounts/Wata `wallet_connect`; this is an
RPC transport name, not the login mechanism. Nanocodex account login is owned
by the managed Cloudflare Worker. By default it is a first-party SMS OTP flow.
A deployment may also configure
[organization login with OIDC](#organization-login-with-oidc-tsidp), and may
make it the only browser login. For a persistent SMS account, the root signer
is the account's custodial Worker-owned wallet, not a browser wallet. OIDC
accounts use the same Worker-owned wallet provisioning.

## End-to-end flow

1. **Choose one action.** `nanocodex login` requests the base installation
   grant. `nanocodex connect <service>...` requests exactly the named connectors.
   One service is focused and starts automatically; multiple services stay
   explicit so the user chooses each connection action.

2. **Check the existing login.** Login loads its local Nanocodex login record.
   If its base grant is valid, it reports the account, hosted agent, expiry, and
   capabilities instead of starting a redundant ceremony. Connect deliberately
   starts a new ceremony because it changes the installation grant.

3. **Prepare the requested authorization.** A non-MPP request includes
   `urn:nanocodex:authorization:hosted`, allowing Connect to approve hosted
   authority without returning or persisting a key. An explicit MPP request is
   a separate access-key ceremony: it omits this marker, prepares a delegated
   Tempo access key, and requires the Worker-root-signed access-key result. The
   delegated key may be returned to the installation; the root key never is.

4. **Register a device authorization.** The CLI starts a Wata device-code
   exchange containing one `wallet_connect` RPC request. The request declares
   the exact capabilities this installation wants:

   - run a hosted Nanocodex agent;
   - read hosted conversation history;
   - use hosted durable memory;
   - for `connect`, grant exactly the connector services selected in the command;
   - optionally use MPP under an explicit access-key spending policy.

   A connect request also signs a singular connector-focus resource. The focus
   must be part of the exact signed connector set.

5. **Open Nanocodex Connect.** The device-code host returns a user code and
   verification URL. The CLI prints both and opens the verification URL in the
   browser when possible. `--no-open` suppresses only that automatic launch.

6. **Establish the Nanocodex account.** The user enters an E.164 phone number
   and a six-digit code delivered by Twilio Verify over SMS or eligible RCS.
   Verify generates and checks the code. The managed Worker binds only an HMAC
   digest of the phone to the account and provisions the persistent account's
   root wallet through private egress before issuing the same HttpOnly account
   session used by managed agents. Wallet provisioning is idempotent and a
   failure leaves the local challenge retryable. A new phone promotes only the
   current anonymous browser account; a known phone restores its existing
   agents, memory, connections, and wallet address.

   On a deployment with OIDC configured, the user may instead choose the
   organization login, which establishes the same kind of account session
   without a phone number. With `NANOCODEX_OIDC_ONLY=true` it is the only
   browser login. See
   [organization login with OIDC](#organization-login-with-oidc-tsidp).

7. **Run the focused action.** The browser derives its work from the signed
   `wallet_connect` request:

   - login requests installation access and no connector catalog;
   - connect shows only the focused service;
   - an already connected focused service needs no redundant OAuth ceremony;
   - show access-key limits, expiry, scopes, and funding policy when MPP is
     requested;
   - show history and memory access as permissions, without inventing an
     external login step for them.

   The persistent Account page remains available as the complete service
   catalog.

   A focused CLI connection stays in the current browser tab. OAuth services
   navigate that tab to the provider and return through the fixed callback
   relay to a compact connected/not-connected result page. The embedded
   `/connect-dialog` surface may use its own dialog behavior; it is not the CLI
   device flow.

8. **Approve the installation automatically.** Once the SMS-backed account is
   established, the device wizard submits the exact pending hosted
   installation request without a separate account-card or approval click.
   SMS verification, provider OAuth, and MPP policy remain interactive when
   they genuinely require user input. The
   final browser view is the completed installation CTA. The embedded
   `/connect-dialog` approval remains explicit.

9. **Return the explicit Accounts result.** For access-key mode, Nanocodex
   Connect asks the account-authenticated managed Worker to sign the exact
   `wallet_connect` request; egress uses the account root and returns only a
   sanitized result. Nanocodex Connect submits the approved result to the Wata
   device-code host. The CLI polls with PKCE
   and receives exactly one account. The result is either the existing signed
   access-key authorization or a hosted authorization containing a 43-character
   one-time approval identifier and `mode: "hosted"`. The CLI accepts hosted
   mode only for a non-MPP request carrying the hosted resource marker.
   Provider credentials are never returned to the CLI.

10. **Create the Nanocodex Connect grant.** The CLI exchanges the approval with
    the Connect API using an explicit `authorization_mode`. `access_key` sends
    the existing key authorization fields. `hosted` sends the app, account,
    approval, permission, and requested connectors with no access-key material.
    The platform validates the account link, resources, connector readiness,
    and authorization policy; creates or reuses the user's hosted agent and
    private egress subject; and returns a response with the same mode, a scoped
    grant token, agent identifier, exact capabilities, and bounded expiry.

11. **Persist the login locally.** Owner-only `connect.json` retains the scoped
    grant token, account and agent identifiers, expiry, approved capabilities,
    and an access-key identifier only for access-key mode. Hosted mode writes no
    Tempo key. Rotation and logout retire a local Tempo key only when the stored
    mode has one. Neither mode retains ChatGPT, OpenAI, or connector credentials
    received from the platform.

12. **Report the resulting state.** The command ends with a stable summary, for
    example:

    ```text
    Logged in to Nanocodex

    Account       c884e3c5…480e
    Hosted agent  agent_…
    ChatGPT       connected
    History       enabled
    Memory        enabled
    GitHub        not requested
    Grant expires Sep 25, 2026
    ```

## Capability and storage boundaries

- The managed Cloudflare Worker owns HMAC phone identity,
  browser-bound challenges, account sessions, and the one-time hosted
  authorization. Twilio Verify owns OTP generation, delivery, attempt limits,
  expiry, and checking. Tempo Accounts/Wata owns the device-code transport and
  PKCE exchange. The private egress broker owns persistent SMS-account root
  wallets and signs only bounded `wallet_connect` access-key authorizations and
  `wallet_revokeAccessKey` operations.
- When OIDC is configured, the same Worker owns the pending `state`, `nonce`,
  and PKCE verifier, the (`iss`, `sub`) account identity, and the OIDC client
  secret. TSIDP owns user authentication; Nanocodex persists no IdP refresh
  token.
- The Worker retains each browser challenge for five minutes. SMS starts have no
  local resend delay or per-phone/IP request caps; `resend_after` is zero.
  The Verify Service must use six-digit codes with a validity window compatible
  with that local lifetime. The Worker stores only keyed HMAC phone digests and
  opaque Verify identifiers; it never stores an OTP.
- Nanocodex Connect owns the application identity, requested Nanocodex
  resources, account linking, connector onboarding, consent UI, and scoped
  grant.
- The private egress broker exclusively owns hosted ChatGPT, OpenAI, and other
  provider credentials and persistent account root private keys. Agent actors
  and CLI clients retain only opaque subjects, scoped grants, and delegated
  access keys. Root keys and their encrypted envelopes never leave egress.
- Root wallets use the existing `CREDENTIAL_ENCRYPTION_KEY` envelope in the
  account's per-user Durable Object. This is custodial server-side encryption,
  not user-held end-to-end encryption. Configurable-account migration is future
  work; see [the custody contract](WALLET_CUSTODY.md).
- A local ChatGPT credential is never uploaded implicitly. In local
  development, `nanocodex connect chatgpt` is the explicit user-approved action
  that claims an available local Codex/ChatGPT credential into the broker when
  that account does not already have ChatGPT connected. The credential remains
  broker-owned and is never returned to the browser or CLI grant.
- Durable memory is always hosted and account/team scoped. There is no local
  durable-memory store to merge with it.
- Hosted history is account/team scoped. A consumer may separately search local
  session history, but that is a retrieval concern after login, not part of the
  account or credential ceremony.
- Interactive logout revokes or discards the scoped grant and removes local
  installation secrets. It must not disconnect the user's hosted connectors or
  delete their Nanocodex account unless explicitly requested.
- A connector is an account credential boundary, not automatically an MCP
  server. MCP-native services may attach a concrete MCP transport. ChatGPT,
  GitHub, Gmail, Drive, and X continue to use their native broker/API adapters
  unless the product deliberately assigns an MCP endpoint to one of them.
- A remote OAuth MCP is represented by a broker-generated opaque connection ID.
  `nanocodex connect mcp.linear.app` authorizes that exact ID, while the endpoint,
  OAuth registration, PKCE material, and provider tokens remain broker-private.
  Native agents attach the ID through the grant-scoped Connect proxy and expose
  its tools through the existing deferred `tool_search` path.

## Browser behavior

The browser should compute steps from requested capabilities and current
account state. Examples:

| Entry point | Browser work |
| --- | --- |
| Account page | Show the complete connector and API-key catalog |
| `nanocodex login` | Select/create an account and authorize the installation |
| `nanocodex connect chatgpt` | Show only the ChatGPT connection action |
| `nanocodex connect github` | Show only the GitHub connection action |
| `nanocodex connect chatgpt github ...` | Show every requested connector with no automatic selection |
| `nanocodex connect mcp.linear.app` | Authorize the focused remote MCP in the same tab, then settle when connected |
| `nanocodex connect mcp.linear.app github ...` | Show every requested connector/MCP with no automatic selection |
| Other single `connect` services | Show only the corresponding connector action |
| Any request with MPP | Show the local access-key expiry, scopes, and limits |

Once account identity, connector readiness, and policy review are satisfied,
the browser settles immediately. It must not add a second generic Continue
step.

### Explicit ChatGPT credential import

`nanocodex connect chatgpt` imports the currently configured Codex ChatGPT
login only as part of that explicit approval ceremony. `--auth-file` may
override the source for a request that includes ChatGPT; otherwise the CLI uses
`NANOCODEX_AUTH_FILE`, `$CODEX_HOME/auth.json`, or `~/.codex/auth.json` in that
order. Plain `nanocodex login` and every connect request that omits ChatGPT must
not resolve or open the Codex auth file.

Before device registration, the CLI opens the file once without following its
final symlink where the platform supports that protection. It accepts only a
regular file owned by the current user, inaccessible to group and other Unix
users, and no larger than 64 KiB. The document must be a ChatGPT-mode Codex
login with bounded ID and access JWTs and a bounded refresh token. The ID and
access JWT account and FedRAMP claims must agree with the stored account ID. The
refresh token is an opaque value: it must be nonblank and control-free, but is
not decoded as a JWT. The access expiry must be more than five minutes in the
future.

The signed `wallet_connect` resources contain exactly one import commitment:

```text
urn:nanocodex:credential-import:chatgpt:codex-auth-v1:sha256:<base64url-sha256>
```

The digest input is the bytes
`nanocodex/chatgpt-credential-import/v1\0`, followed in order by the access
token, refresh token, and account ID, each encoded as a big-endian `u32` UTF-8
byte length and the UTF-8 bytes, then the expiry in Unix epoch milliseconds as
a big-endian `u64`, then one FedRAMP byte (`0` or `1`). After the wallet result
has been validated, `/v1/connections` receives `chatgpt_credential_import` with
exactly `access_token`, `refresh_token`, `account_id`, `expires_at`, and
`fedramp`. These credentials are ephemeral request material and are never
written to `connect.json` or returned in CLI diagnostics.

### Explicit SSH private-key import

The legacy CLI can import one existing SSH identity into the account Vault:

```sh
nanocodex connect ssh --key-file /path/to/key.pem --reference my-server \
  --hostname server.example.com --port 22 --username deploy \
  --host-key-sha256 'SHA256:<unpadded-base64-fingerprint>'
```

All six SSH options require the `ssh` target; port defaults to 22. The CLI
validates the reference, canonical public lowercase DNS/IPv4 host, username,
port, and host-key fingerprint before reading the file. References start with
an alphanumeric character, contain at most 64 letters, digits, dots,
underscores or hyphens, and cannot use reserved object-property names. Pins
use the canonical unpadded `SHA256:` form. Encoded target resources must fit
within 512 bytes. Private, loopback, link-local and local-only targets are
rejected under the same destination policy as the Connect API.

The key file must be a regular non-symlink file no larger than 64 KiB. The CLI
opens and reads it once, with final-component no-follow protection on Unix
and Windows. It checks the PEM envelope and DER structure for unencrypted RSA
PKCS1, NIST P-256/P-384/P-521 EC SEC1, or RSA/EC PKCS8 keys. OpenSSH,
encrypted, malformed and other key formats are rejected locally. Extra
whitespace around the PEM envelope is rejected. These local checks validate
the supported encoding; the broker performs cryptographic key import.

The approval displays the SSH reference, host, port, username and host-key pin.
Its signed resources contain one commitment and one target descriptor:

```text
urn:nanocodex:credential-import:ssh:pem-v1:sha256:<base64url-sha256>
urn:nanocodex:ssh-target:<reference>:<hostname>:<port>:<username>:<host-key-sha256>
```

Each text component in the target uses JavaScript `encodeURIComponent`
encoding. The commitment hashes UTF-8 `nanocodex/ssh-credential-import/v1\0`,
then reference, hostname, username, host-key fingerprint and exact PEM, each
with a big-endian `u32` UTF-8 length followed by its bytes, then the port as a
big-endian `u32`. Only after approval does the CLI post the six-field
`ssh_credential_import` object to the pinned Connect origin. The PEM never
enters browser resources, prompts, local grant storage or diagnostics.

Existing connector/MCP grants are preserved. SSH is a separate Connect target,
not a service connector or generic API-key update. Fresh SSH and ChatGPT
imports require separate commands. An ambiguous or rejected SSH connection
POST is never automatically repeated, including transport retries; check the
account's saved identity status before starting another import.

The executable regression journey is
`node bin/nanocodex/tests/ssh_import_cli_e2e.mjs /absolute/path/to/nanocodex`.
It generates synthetic keys and uses only a local HTTP approval fixture.

## Organization login with OIDC (TSIDP)

A deployment can sign users in through a first-party OpenID Connect relying
party in the managed Worker (`nanocodex-durable-agent`). The public app Worker
(`nanocodex`) forwards `/v1/*` to it, so every login endpoint is served from
the app's own origin. The supported identity provider is
[TSIDP](https://tailscale.com/docs/features/tsidp), Tailscale's OIDC server.
This keeps the existing Cloudflare deployment: no separate login service is
involved. See [self-hosting](SELF_HOSTING.md) for the rest of the deployment.

### Identity chain

```text
Okta ──> Tailscale ──> TSIDP ──> Nanocodex
(workforce   (device and     (OIDC issuer on    (OIDC relying party in
 directory)   user identity)  the tailnet)       the managed Worker)
```

1. Okta authenticates the person when they sign in to Tailscale. Configure
   that integration with
   [Tailscale's Okta guide](https://tailscale.com/docs/integrations/identity/okta).
2. Tailscale attaches that user identity to the device on the tailnet.
3. TSIDP identifies the browser's device through Tailscale's `whois` lookup.
   It shows no password prompt and issues an ID token for that Tailscale user.
4. Nanocodex validates the ID token and signs the user in to the app.

Nanocodex never talks to Okta. Okta policy applies only through what
Tailscale admits to the tailnet. **The browser must be on the tailnet** when
it opens the TSIDP authorization URL. Otherwise login fails at TSIDP before any
Nanocodex session exists.

### Configuration

Set these values on the managed Worker. Without them, the deployment keeps its
existing SMS behavior unchanged.

| Name | Required | Value |
| --- | --- | --- |
| `NANOCODEX_OIDC_ISSUER` | Yes | The exact issuer URL, byte for byte as published in TSIDP's discovery document |
| `NANOCODEX_OIDC_CLIENT_ID` | Yes | The client ID TSIDP issued for this deployment |
| `NANOCODEX_OIDC_CLIENT_SECRET` | Yes | The client secret TSIDP issued. Store it only as a Worker secret |
| `NANOCODEX_OIDC_REDIRECT_URI` | Yes | The exact HTTPS app origin followed by `/v1/auth/oidc/callback` |
| `NANOCODEX_OIDC_LABEL` | No | The name shown on the login button. Defaults to `your organization`. Set `Tailscale` for TSIDP |
| `NANOCODEX_OIDC_ONLY` | No | `true` makes OIDC the only accepted browser login. See [OIDC-only mode](#oidc-only-mode) |

Configure all four required values together. The client secret must never
appear in source, a checked-in Wrangler manifest, Vite or browser
configuration, logs, or the redirect URI. The managed Wrangler manifest does
not keep dashboard-only plaintext variables across deploys. Set every value
as a Worker secret so the checked-in manifest stays unchanged:

```bash
cd js/managed
pnpm exec wrangler secret put NANOCODEX_OIDC_ISSUER --config wrangler.jsonc
pnpm exec wrangler secret put NANOCODEX_OIDC_CLIENT_ID --config wrangler.jsonc
pnpm exec wrangler secret put NANOCODEX_OIDC_CLIENT_SECRET --config wrangler.jsonc
pnpm exec wrangler secret put NANOCODEX_OIDC_REDIRECT_URI --config wrangler.jsonc
pnpm exec wrangler secret put NANOCODEX_OIDC_LABEL --config wrangler.jsonc
# Optional, after OIDC login has been verified:
pnpm exec wrangler secret put NANOCODEX_OIDC_ONLY --config wrangler.jsonc
```

Synthetic values for an app served at `https://nanocodex.example.com` with a
TSIDP node named `idp` on the tailnet `example-tailnet.ts.net`:

```text
NANOCODEX_OIDC_ISSUER=https://idp.example-tailnet.ts.net
NANOCODEX_OIDC_CLIENT_ID=<client-id-from-tsidp>
NANOCODEX_OIDC_CLIENT_SECRET=<client-secret-from-tsidp>
NANOCODEX_OIDC_REDIRECT_URI=https://nanocodex.example.com/v1/auth/oidc/callback
NANOCODEX_OIDC_LABEL=Tailscale
NANOCODEX_OIDC_ONLY=true
```

Copy the issuer from the `issuer` field of
`<issuer>/.well-known/openid-configuration` rather than typing it. A trailing
slash or a different hostname is a different issuer. Changing the TSIDP
hostname or tailnet name changes the issuer, and therefore every user's
identity (see [identity and accounts](#identity-and-accounts)).

For local Wrangler development, put the same names in the ignored
`js/managed/.dev.vars` file. The redirect URI must still be an HTTPS origin
that is registered with TSIDP, and the local browser must be on the tailnet.

### TSIDP deployment

Follow [Tailscale's TSIDP guide](https://tailscale.com/docs/features/tsidp)
for MagicDNS, HTTPS certificates, tags, and auth keys. For Nanocodex:

- **Enable Funnel** (`-funnel` or `TSIDP_USE_FUNNEL=1`). Cloudflare Workers
  are not on the tailnet. Funnel publishes TSIDP's discovery, token, and JWKS
  endpoints so the managed Worker can fetch them. TSIDP rejects its
  authorization endpoint and admin UI over Funnel, so a user still has to be on
  the tailnet to sign in. Funnel does not make login public. The TSIDP node
  needs the `funnel` node attribute in the tailnet policy.
- **Persist state.** Keep TSIDP's state directory (`-dir` or `TS_STATE_DIR`)
  on a durable volume. It holds the node identity, signing keys, and registered
  clients. Losing it invalidates the client registration and the signing keys.
- **Pin the version.** TSIDP is experimental and may change incompatibly.
  Deploy a pinned image tag or digest rather than `latest`, and test upgrades
  before rolling them out.
- **Restrict admin grants.** The `tailscale.com/cap/tsidp` capability with
  `allow_admin_ui` lets its holders create, edit, and delete clients and
  regenerate secrets. Grant it only to a small administrator group. Nanocodex
  uses no TSIDP token exchange (STS), so it does not need `users` or
  `resources` entries in that capability.

A synthetic Compose service with Funnel and persistent state:

```yaml
services:
  tsidp:
    image: ghcr.io/tailscale/tsidp:<pinned-version-or-digest>
    volumes:
      - tsidp-data:/data
    environment:
      - TAILSCALE_USE_WIP_CODE=1
      - TS_STATE_DIR=/data
      - TS_HOSTNAME=idp
      - TSIDP_USE_FUNNEL=1
      - TS_ADVERTISE_TAGS=tag:tsidp
      - TS_AUTHKEY # supplied from the operator's environment
volumes:
  tsidp-data:
```

A synthetic tailnet policy fragment. Members can reach TSIDP, only
`group:idp-admins` gets the admin UI, and the node may use Funnel:

```json
{
  "tagOwners": { "tag:tsidp": ["group:idp-admins"] },
  "grants": [
    { "src": ["autogroup:member"], "dst": ["tag:tsidp"], "ip": ["tcp:443"] },
    {
      "src": ["group:idp-admins"],
      "dst": ["tag:tsidp"],
      "app": { "tailscale.com/cap/tsidp": [{ "allow_admin_ui": true }] }
    }
  ],
  "nodeAttrs": [{ "target": ["tag:tsidp"], "attr": ["funnel"] }]
}
```

### Client registration

Register Nanocodex as a client in the TSIDP admin UI, from a device on the
tailnet with the admin grant. Select **Create Client**, enter a client name, and
enter exactly the `NANOCODEX_OIDC_REDIRECT_URI` value as the redirect URI. Each
app origin needs its own exact redirect URI. Nanocodex uses this client as
follows:

| Setting | Value |
| --- | --- |
| Token endpoint authentication | `client_secret_basic` |
| Requested scopes | `openid email profile` |
| ID token signing algorithm | `RS256` |

TSIDP shows the client secret once. Store it with `wrangler secret put` and
nowhere else. To rotate it, regenerate the secret in TSIDP and then update the
Worker secret. Token exchanges fail until both sides match.

TSIDP issues no group claims by default. It adds custom claims only when the
capability grant sets `extraClaims`. Nanocodex does not rely on group claims
or on `email_verified`.

### Login endpoints

All endpoints are on the app origin.

| Method and path | Behavior |
| --- | --- |
| `GET /v1/auth/methods` | Reports which browser login methods this deployment accepts and the OIDC label |
| `POST /v1/auth/oidc/start` | Same-origin JSON request `{"return_to": "/relative/path"}`. Starts an authorization request and returns the TSIDP authorization target for the browser to navigate to |
| `GET /v1/auth/oidc/callback` | TSIDP's redirect target. Completes login and redirects to the saved `return_to` |
| `POST /v1/auth/logout` | The existing logout. Clears the Nanocodex session for every login method |

`return_to` must be a relative path on the app origin. Absolute and
protocol-relative URLs are rejected, which prevents open redirects. The start
request must come from the app origin, like the SMS endpoints.

Each start creates single-use `state`, `nonce`, and PKCE values. The flow is
the authorization code flow with `S256` PKCE. The callback:

1. requires the exact pending `state` and rejects missing, expired, replayed, or
   mismatched values;
2. exchanges the code at TSIDP's token endpoint with the PKCE verifier, using
   `client_secret_basic` client authentication;
3. verifies the RS256 ID token signature against TSIDP's JWKS, and checks the
   exact issuer, the client ID as audience, the expiry, and the `nonce`;
4. finds or creates the account for the token's identity and issues the
   HttpOnly account session.

An error from TSIDP, a failed exchange, or any failed check creates no session.
The user can start login again.

### Identity and accounts

An OIDC account is keyed by the pair (`iss`, `sub`). Email and profile claims
do not determine identity or authorization:

- there is no linking by email address to an SMS account or another OIDC
  identity;
- there is no automatic admin, organization, or team assignment from claims or
  groups. Operator and organization roles are granted through their existing
  mechanisms.

The first login creates a normal persistent user and provisions its custodial
wallet through the private egress service, just like SMS login. The user has
the usual agents, history, memory, and connections. Login does not grant a CLI
or app any access by itself; installation approval and payment authorization
remain separate actions. If provisioning fails, no session is issued. Start a
fresh OIDC login to retry; the same identity retains its user ID and wallet
provisioning is idempotent.

The current native CLI account login still uses direct SMS. It has no OIDC
browser handoff. In OIDC-only deployments, sign in on the web, create an API
key, then use `nanocodex login --with-api-key` with the deployment's managed
origin. The legacy Connect ceremony described above can reuse the browser
session, but a self-hosted fork must also replace its pinned production
origins. See [self-hosting](SELF_HOSTING.md).

Agents and live threads stay owned by the individual user. Organization-owned
live threads are not supported yet.

### Session lifetime and logout

- An OIDC application session lasts at most 8 hours from login. It is not
  extended by activity. After it expires, the user signs in through TSIDP
  again.
- Nanocodex stores no refresh token and receives no back-channel logout from
  TSIDP.
- `POST /v1/auth/logout` ends only the Nanocodex session. It does not log the
  device out of Tailscale. While the device stays on the tailnet, the next
  login completes without a prompt.
- Removing access in Okta must propagate through Tailscale before it prevents
  new logins. Nanocodex does not check that propagation, and an existing
  Nanocodex session stays valid until its 8-hour expiry. API keys and
  installation grants the user created are independent of the browser
  session. They are not revoked by IdP removal or by session expiry.

### OIDC-only mode

`NANOCODEX_OIDC_ONLY=true` makes OIDC the only accepted browser login. The
managed Worker then rejects:

- SMS OTP start and verification;
- anonymous browser accounts;
- existing account session cookies not created by OIDC login, including
  long-lived SMS sessions.

Separately authorized API keys keep working with their own scopes, revocation,
and expiry, because they are not browser login sessions. Existing SMS users are
signed out and are not linked to their OIDC identity. Their data stays with the
SMS account.

Enable this mode only after verifying OIDC login end to end. If OIDC is
misconfigured while this mode is on, nobody can sign in through the browser.

## Regional API-key authorization

With `NANOCODEX_REGIONAL_API_KEY_AUTHORITY=true`, direct live-session and run
admission and retained-session key refresh use an authority replica named by
primary key object and trusted ingress region. Existing primary objects are
preserved. A cold replica or expired 60-second lease checks the primary, account,
and organization; warm leases avoid that remote authorization round trip.
Replica failure falls back to the primary, while an authorization denial remains
final. This does not relocate credential brokers or change other account APIs.

Each authority registers the replica before reading its state. Key deletion
invalidates all registered replicas before acknowledging success; unreachable
replicas cause failure and require retry. Revocation never assumes a replica
expired based on wall-clock time. Replica restart drops its volatile lease, and
revocation invalidates grants already in flight.

Any future authority-reducing account, organization, team, or membership mutation
must commit its change, call that object's `revokeApiKeyAuthorityLeases` RPC, and
await `true` before acknowledging success. The same contract applies to operator
storage edits; raw storage changes alone do not invalidate warm leases. Current
organization HTTP mutations only change display names. Disabling the regional
flag on ingress and managed Workers restores primary authorization reads.
