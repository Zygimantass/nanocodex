# Self-hosting the Nanocodex app

This guide covers running your own copy of the hosted Nanocodex app: the web
app, managed agents, accounts, and credential broker. It does not cover the
embeddable SDKs, the CLI, or Hands. They run anywhere and need no hosted
backend; see the [README](../README.md).

## What is supported

| Deployment | Status |
| --- | --- |
| Your own Cloudflare account, using the Workers in this repository | Source deployment requiring a fork, origin changes, and manual bootstrap; not verified as a fresh-account installer |
| The application backend on Docker, Docker Compose, Kubernetes, or another server runtime | Not supported |

The backend is built on Cloudflare primitives: Workers, Service Bindings,
SQLite-backed Durable Objects, Containers, R2, D1, Workers AI, Browser
Rendering, Images, Worker Loaders, rate limiting, Email, and Worker secrets.
There is no portable server build and no Compose file or Helm chart. The
Dockerfiles in the repository build images that Cloudflare Containers run
(sandboxes, phones, the account relay) or native Hand components. They are not
a way to run the backend outside Cloudflare.

The only service an operator runs outside Cloudflare for login is an identity
provider, if one is used. For organization login, that is TSIDP on your
tailnet (see [login](#login)).

Self-hosting is not a one-command deploy. The checked-in manifests and deploy
scripts describe the upstream operator's deployment. A new Cloudflare account
needs a fork with reviewed configuration and a staged first deployment.

## Workers and their sources

Each Worker deploys independently from its own package and manifest.

| Worker | Source | Manifest | Role |
| --- | --- | --- | --- |
| `nanocodex` | `js/account` | `js/account/wrangler.jsonc` (deployed from the Vite build output `dist/nanocodex/wrangler.json`) | Public app origin: web UI, `/v1/*` routing, Git data, evals, account relay container |
| `nanocodex-durable-agent` | `js/managed` | `js/managed/wrangler.jsonc` | Accounts and login, managed agents, sessions, memory, API keys, organizations, sandboxes |
| `nanocodex-egress` | `js/egress` | `js/egress/wrangler.broker.jsonc` | Private credential broker and custodial wallets |
| `nanocodex-x` | `js/x-api` | `js/x-api/wrangler.jsonc` | X browsing for agents |
| `nanocodex-media` | `js/media` | `js/media/wrangler.jsonc` | Media processing |
| `nanocodex-sites` | `js/sites` | `js/sites/wrangler.jsonc` | Static site hosting ([SITES.md](SITES.md)) |
| `nanocodex-email` | `js/email` | `js/email/wrangler.jsonc` | Agent mailbox |
| `nanocodex-connect-dialog` | `js/connect-dialog` | `js/connect-dialog/wrangler.jsonc` | Embeddable Connect dialog |
| `nanocodex-connect-api` | `js/connect-api` | `js/connect-api/wrangler.jsonc` | Connect grant API |
| `nanocodex-chief-of-staff` | `js/chief-of-staff` | `js/chief-of-staff/wrangler.jsonc` | Chief of Staff demo |
| `nanocodex-connect-playground` | `js/connect-playground` | `js/connect-playground/wrangler.jsonc` | Connect example app |
| `nanocodex-astra-mpp-trial` | `examples/astra-mpp-trial` | `examples/astra-mpp-trial/wrangler.jsonc` | MPP trial example |

Each package README documents its own secrets, variables, and operations.
Start with [js/managed](../js/managed/README.md),
[js/egress](../js/egress/README.md), and [js/account](../js/account/README.md).
[`.env.example`](../.env.example) lists the local development variables.

`nanocodex`, `nanocodex-durable-agent`, and the connect-playground require the
Rust SDK WASM build. Use the root scripts, which build each Worker's
dependencies first (`pnpm deploy:managed`, `pnpm deploy:account`, and so on in
[package.json](../package.json)). See the [API release path](../scripts/cloudflare/README.md)
for exactly what each Worker builds.

## Optional features still have declared bindings

Many product features are optional at runtime: X browsing, media, sites, email,
phones, Chief of Staff, and the Connect playground. Their bindings are not
optional at deploy time. The core manifests declare Service Bindings and
Durable Object bindings to those Workers by name, and a fork must either deploy
every bound Worker or remove the binding in its own manifests.

Turning a feature off with a variable does not remove its binding. Before
removing a binding, check the consuming code for a missing-binding path. Some
features handle an absent binding; others assume it exists.

## Binding topology and bootstrap

The Workers bind to each other in cycles:

```text
nanocodex ──► nanocodex-durable-agent ──► nanocodex-egress ──► nanocodex
nanocodex ──► nanocodex-connect-api ──► nanocodex
nanocodex-durable-agent ──► nanocodex-email ──► nanocodex-durable-agent
```

- `nanocodex` binds `nanocodex-durable-agent` as a service and uses its Durable
  Object classes by `script_name`. It also binds egress, X, the Connect dialog,
  the Connect API, and Chief of Staff.
- `nanocodex-durable-agent` binds egress through several entrypoints, plus
  media, email, and X.
- `nanocodex-egress` binds managed entrypoints (`PhoneProvider`,
  `ManagedAgentOwnership`) and a Durable Object class owned by `nanocodex`.
- `nanocodex-connect-api` binds managed, egress, and `nanocodex`.
- Email and Chief of Staff bind managed entrypoints.

The production release order is:

1. `nanocodex-x`, `nanocodex-media`, `nanocodex-sites`
2. `nanocodex-durable-agent`
3. `nanocodex-egress`
4. email, Connect dialog, Connect API, Astra, Chief of Staff, Connect
   playground
5. `nanocodex` (always last)

That order works only when every Worker, entrypoint, and Durable Object class
already exists. In a new Cloudflare account, some bindings point at Workers or
classes that a later phase creates. For example, egress needs a class from
`nanocodex`, which deploys last. The first deployment needs a reviewed
bootstrap sequence: deploy temporary configurations with the not-yet-existing
bindings removed, then redeploy with the full manifests. The managed README
documents one such sequence for the
[ownership entrypoint](../js/managed/README.md). Plan the full bootstrap for
your fork the same way. The documented order does not create it for you.

Deploy `nanocodex` last on every release, after the Workers it binds have
published their entrypoints.

## Operator-specific configuration to replace

The checked-in configuration is the upstream deployment's. Review and replace
at least these values in your fork before deploying. This list names the keys
and files only, not their values.

| File | Operator-specific values |
| --- | --- |
| `js/managed/wrangler.jsonc` | Admin, phone, and email operator user IDs (`NANOCODEX_ADMIN_USER_ID`, `NANOCODEX_PHONE_ADMIN_ID`, `NANOCODEX_EMAIL_ADMIN_ID`, `NANOCODEX_EMAIL_OWNER_ID`), `NANOCODEX_SITES_ORIGIN`, `NANOCODEX_HAND_IMAGE`, R2 bucket names, D1 database name, feature flags |
| `js/account/wrangler.jsonc` | Evals D1 `database_id`, R2 bucket names, rate-limit `namespace_id` values |
| `js/account/production.json` | The public app origin |
| `js/nanocodex-connect-ui/src/App.tsx` | `productionNanocodexOrigin`, used for Connect's browser login destination |
| `js/nanocodex-connect-ui/src/connectPolicy.mts` | `productionConnectApiOrigin`, including the exact-origin checks for Connect and MCP continuations |
| `js/managed/src/account-navigation.ts` | The production account navigation origin |
| `js/egress/wrangler.broker.jsonc` | `PHONE_WEBHOOK_URL` and feature flags |
| `js/email/wrangler.jsonc` | Cloudflare `account_id`, mailbox owner/admin IDs, mailbox and allowed sender addresses |
| `js/chief-of-staff/wrangler.jsonc` | App and public origins |
| `scripts/cloudflare/release-workers.mjs` | Account health check URL |
| `scripts/cloudflare/current-production-release.mjs` | GitHub Actions release guard: deploys only from a `master` push or explicit production dispatch |

Origins in these files use the upstream account's `workers.dev` subdomain, so
they change in a new account. User IDs
in the managed and email manifests refer to accounts in the upstream
deployment; replace them with accounts created in yours, after those accounts
exist.

The root deploy scripts and the CI release pipeline assume the upstream
repository, account, and release ledger. For a fork, run the per-package
scripts deliberately in the order above, or adapt the pipeline. Do not assume
`pnpm deploy:*` alone produces a working deployment in a new account.

Changing `js/account/production.json` alone is insufficient for Connect. Its
production origin pins are security boundaries, not just navigation defaults.
Keep exact-origin validation when adapting them to your deployment; do not
replace them with acceptance of arbitrary HTTPS endpoints. There is not yet a
single supported production-origin override for all these consumers.

## Secrets

Set secrets with `wrangler secret put` against each Worker's manifest; never
commit them or expose them to Vite or browser configuration. Each package README
lists its own secrets. Secrets that cross Workers include:

- `CREDENTIAL_ENCRYPTION_KEY` on `nanocodex-egress`, which encrypts provider
  credentials and custodial root wallets ([WALLET_CUSTODY.md](WALLET_CUSTODY.md));
- `NANOCODEX_ACCESS_SECRET`, which must match on `nanocodex` and
  `nanocodex-durable-agent`;
- login configuration on `nanocodex-durable-agent` (next section).

## Login

The managed Worker owns browser login. Choose one:

- **SMS (default).** Configure Twilio Verify and `NANOCODEX_OTP_HMAC_KEY` as
  described in [SMS OTP delivery](../js/managed/README.md#sms-otp-delivery).
- **Organization OIDC through TSIDP.** Set the `NANOCODEX_OIDC_*` values on
  `nanocodex-durable-agent`. Optionally set `NANOCODEX_OIDC_ONLY=true` to
  disable SMS, anonymous, and other non-OIDC browser sessions. API keys keep
  working.

OIDC-configured installations open `/` on the sign-in page, without the
public marketing page. After sign-in, or when a persistent session already
exists, `/` opens the Agents workspace. Direct account and agent links keep
their destinations. For an SMS-only self-host, set
`NANOCODEX_SELF_HOSTED=true` on `nanocodex-durable-agent` for the same login-first
entry point. This setting only changes the landing page, not authentication
requirements or access policy. The browser reads it from `/v1/auth/methods`;
no frontend build-time flag or OIDC secret is needed in the web app.

Synthetic OIDC values for an app served at `https://nanocodex.example.com`:

```text
NANOCODEX_OIDC_ISSUER=https://idp.example-tailnet.ts.net
NANOCODEX_OIDC_CLIENT_ID=<client-id-from-tsidp>
NANOCODEX_OIDC_CLIENT_SECRET=<client-secret-from-tsidp>
NANOCODEX_OIDC_REDIRECT_URI=https://nanocodex.example.com/v1/auth/oidc/callback
NANOCODEX_OIDC_LABEL=Tailscale
NANOCODEX_OIDC_ONLY=true
```

The identity chain is Tailscale → TSIDP → Nanocodex. Okta is not required;
direct Okta login is a separate alternative to the TSIDP integration.
Users' browsers must be on the tailnet to sign in. TSIDP runs with Funnel so the Worker can
reach its discovery, token, and JWKS endpoints, while its authorization
endpoint stays tailnet-only. Read
[organization login with OIDC](MANAGED_LOGIN.md#organization-login-with-oidc-tsidp)
before enabling it. It covers TSIDP deployment, client registration, the
8-hour session limit, logout, wallet provisioning, and the remaining lack of
organization-owned live threads. See also
[Tailscale's TSIDP guide](https://tailscale.com/docs/features/tsidp).

The native CLI's current account login is direct SMS, not a browser OIDC
handoff. On an OIDC-only deployment, create an API key in the signed-in web app
and import it with:

```sh
nanocodex login --with-api-key --managed-url https://nanocodex.example.com
```

The command reads the key from stdin. Do not put the key in a command
argument. `NANOCODEX_MANAGED_URL` is the equivalent
origin override. Legacy Connect browser flows additionally require the origin
changes above. A native browser/device authorization flow remains future work.
