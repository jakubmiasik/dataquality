# Fabric Reconciliation

Rayfin-hosted React app for comparing records across Microsoft Fabric Lakehouses
and Warehouses. It inventories artifacts in accessible workspaces, reads tables,
views, and columns through SQL endpoints, and stores rules, runs, findings, and
exception history in the Rayfin data service.

## Fabric API setup

Create an Entra SPA app registration and grant delegated Fabric
`Workspace.Read.All`, `Lakehouse.Read.All`, and `Warehouse.Read.All`, plus SQL
`https://database.windows.net//user_impersonation`. Add
`http://localhost:5175/auth-redirect.html` and the deployed Rayfin app URL
followed by `/auth-redirect.html` as SPA redirect URIs.

Enter the client and tenant IDs in the app's **Configuration** tab. They are
stored in the Rayfin data service and shared with everyone in the workspace, so
no rebuild or redeploy is needed to change them. These are public SPA
identifiers, not secrets.

Setting `RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID` and
`RAYFIN_PUBLIC_FABRIC_ENTRA_TENANT_ID` in `rayfin/.env` still works and acts as
the fallback when the Configuration tab leaves a value empty. Rayfin generates
the Vite names in `.env.local`.

Fabric REST and SQL endpoint calls use separate delegated tokens for the same
signed-in user. The gateway binds both tokens to the same Entra identity; SQL
object and row-level permissions are therefore applied as that user. Only
generated read-only SQL projections are executed.

The app includes MSAL's redirect bridge and popup relay pages. They are required
for popup authentication to complete when the app runs in a Fabric iframe.

## Getting started

```bash
# Start the Rayfin backend and frontend
npm run dev

# In a second terminal, start the Azure Functions SQL gateway
npm start --prefix gateway
```

Open [http://localhost:5173](http://localhost:5173). The Vite proxy forwards
`/gateway-api` to the local Functions host at `http://localhost:7071`.

## Project structure

```text
├── rayfin/
│   └── rayfin.yml          # Fabric service configuration (auth + static hosting)
├── src/
│   ├── main.tsx            # Entry point + Rayfin client bootstrap
│   ├── App.tsx             # Routes and auth gate
│   ├── hooks/
│   │   └── AuthContext.tsx # React context wrapping the auth helpers
│   ├── components/
│   │   └── AuthPage.tsx    # Sign-in UI
│   ├── pages/
│   │   ├── HomePage.tsx    # Authenticated app route
│   │   └── ReconciliationPage.tsx # Inventory, rules, runs, findings, schedules
│   ├── hooks/
│   │   └── useScheduleSweeper.ts  # Browser-driven scheduled runs
│   └── services/
│       ├── IAuthService.ts        # Auth service contract + AuthUser type
│       ├── MockAuthService.ts     # Local-dev impl (email/password)
│       ├── RayfinAuthService.ts   # Production impl (Fabric brokered auth)
│       ├── rayfinClient.ts        # Typed Rayfin client singleton
│       ├── appSettings.ts         # Runtime config (Entra IDs, gateway URL)
│       ├── reconciliationEngine.ts     # Re-export of gateway/src/reconciliationEngine.ts
│       ├── reconciliationRepository.ts # Rayfin persistence
│       ├── reconciliationSchedule.ts   # Cadence maths
│       ├── reconciliationScheduler.ts  # Due-schedule sweep
│       └── bootstrap.ts           # Reads env, picks the right auth service
├── gateway/                # Azure Functions SQL gateway (deployed with azd)
│   ├── infra/              # Bicep for the Function App, storage, and monitoring
│   └── src/
│       ├── reconciliationEngine.ts  # Pure comparison engine (single source of truth)
│       ├── reconciliation.ts        # Request validation + bounded SQL execution
│       └── functions/               # HTTP triggers
└── package.json
```

The comparison engine lives under `gateway/` and the app re-exports it. azd
uploads only the `gateway` folder when it deploys, so anything the Function App
imports has to live inside that folder — keeping the engine there lets the
gateway build standalone while both sides still share one implementation.

## Data model and access

Rules, runs, findings, exceptions, audit events, and schedules are
**workspace-shared**: every signed-in user sees and can act on all of them, which
matches the governance tool this app replaces. Records still carry the creating
user so history and audit events stay attributable.

Rayfin caps every `@text()` column at 4000 characters, so large payloads
(row snapshots, summaries, comments) are clamped on write rather than rejected.

## Configuration

The **Configuration** tab holds the Entra client ID, Entra tenant ID, and
reconciliation gateway URL. They live in the `AppSetting` table, so an operator
can correct them from the running app and every user picks the change up on
their next load — no rebuild, redeploy, or restart.

Each value falls back to its build-time `RAYFIN_PUBLIC_*` variable when left
empty, so deployments that already configure `rayfin/.env` keep working
unchanged. A value entered in the tab wins over the build-time one.

## Scheduling

Rules can be scheduled hourly, daily, or weekly from the **Schedules** tab. Times
are UTC.

Rayfin only supports the `anonymous` and `authenticated` roles, and an
authenticated session can only be created by an interactive Entra/Fabric sign-in.
There is therefore no supported way for a background service to read schedules or
write run outcomes. Scheduled runs are instead swept by the app itself: every
signed-in browser with the app open checks once a minute for due schedules and
runs them. Claiming a schedule advances its next due time before the run starts,
so several open tabs cannot run the same slot twice.

In practice this means **a schedule only fires while at least one person has the
app open**. A missed slot runs on the next sweep rather than being skipped.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Provision or reuse the Fabric backend and start local frontend/Functions code |
| `npm run build` | Production build |
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up staticapp deploy`). Its `prebuild:fabric` hook regenerates `.env.local` from `rayfin/.env` so the deployed bundle always carries the current `RAYFIN_PUBLIC_*` values |
| `npm run lint` | Lint with ESLint |
| `npm run test` | Run unit tests with Vitest |
| `npm run rayfin:up` | Deploy app to Fabric (no local dev server) |
| `npm test --prefix gateway` | Compile and test gateway validation |

## Gateway configuration

For local execution, install Azure Functions Core Tools and run the Functions
host from `gateway/` as shown above. The gateway resolves source endpoints from
Fabric REST APIs and uses the signed-in user's delegated SQL token; it does not
need a SQL password or app secret.

## Deployment

### 1. Deploy the Azure gateway

```bash
cd gateway
azd env new <environment-name>
azd env set CORS_ALLOWED_ORIGINS "https://app.fabric.microsoft.com"
azd env set VNET_ENABLED false
azd up
```

`CORS_ALLOWED_ORIGINS` is a comma-separated list of browser origins allowed to
call the gateway. The Fabric-hosted app is cross-origin, so its origin must be
listed or every call fails preflight. The deployment wires this into the Function
App's CORS settings, so no manual portal step is needed.

Note the Function App's HTTPS origin from the `azd up` output. It is also
written to the azd environment as `RECONCILIATION_GATEWAY_URL`, so you can read
it back at any time:

```bash
azd env get-value RECONCILIATION_GATEWAY_URL
# https://<function-app>.azurewebsites.net
```

### 2. Point the app at the gateway

Enter the Function App origin in the app's **Configuration** tab, or set
`RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL` in `rayfin/.env` as the fallback.

Use the origin only — the app appends `/api/reconciliation/...` itself.

### 3. Apply the data schema

```bash
npx rayfin up db apply
```

Required after pulling these changes: it creates the `AppSetting` and
`ReconciliationSchedule` tables and adds the `caseInsensitive` and `trimValues`
columns to the rule-field tables. Until `AppSetting` exists the Configuration
tab still works, but it saves to the current browser only and says so.

### 4. Deploy the app to Fabric

```bash
npm run rayfin:up
```

Add the deployed app URL followed by `/auth-redirect.html` to the Entra SPA
redirect URIs, and the app origin to `allowedRedirectUris` in `rayfin/rayfin.yml`.
The **Configuration** tab prints the exact redirect URI for the origin you are
currently on, with a copy button, so you can paste it straight into Entra.

### 5. Continuous integration

`.github/workflows/ci.yml` builds, lints, and tests on every pull request and on
pushes to `main`. It does not deploy: run `npm run rayfin:up` when you want to
publish a new revision to Fabric, and `azd up` from `gateway/` when the gateway
changes.

### Troubleshooting

**"… is not set. Open the Configuration tab and enter it."** The Entra client or
tenant ID has not been provided. Open **Configuration** in the app, enter the
IDs, and save — the change applies immediately for you and on the next load for
everyone else in the workspace.

**Configuration says it saved to this browser only.** The `AppSetting` table is
missing. Run `npx rayfin up db apply` to create it, then save again to share the
values with the workspace.

**Checking the gateway is reachable.** An unauthenticated POST should return a
`401` from the gateway's own auth guard. Anything else (a timeout, a 404, or an
Azure error page) means the URL is wrong or the Function App is not running:

```bash
curl -i -X POST -H 'content-type: application/json' -d '{}' \
  https://<function-app>.azurewebsites.net/api/reconciliation/execute
# HTTP/1.1 401 … {"error":"A signed-in Fabric user is required."}
```

**Sign-in fails with `AADSTS50011` (redirect URI mismatch).** The app always
requests `<current origin>/auth-redirect.html`, and that exact value has to be
registered on the Entra app as a **Single-page application** redirect URI. Each
origin needs its own entry, so a Fabric deployment does not inherit the local
`http://localhost:5173/auth-redirect.html` one. Open the **Configuration** tab to
copy the URI the current origin uses, then add it under *Authentication → Single-page
application* on the app registration. Registering it as *Web* instead of *SPA*
produces the same error, because browser-based auth-code flows require the SPA
platform.

**Browser calls to the gateway fail CORS preflight.** The app's origin is not in
the Function App's allowed origins. Re-run `azd env set CORS_ALLOWED_ORIGINS …`
followed by `azd up` from `gateway/`.

### Hardening before production

- `services.auth.password` in `rayfin/rayfin.yml` is enabled for local dev. Since
  the data is workspace-shared, disable it in production so access is governed by
  Entra/Fabric sign-in alone.
- The gateway's HTTP functions use `authLevel: 'anonymous'` and decode, but do not
  cryptographically verify, the delegated tokens they forward. Fabric REST and SQL
  both verify the tokens themselves, so a forged token gains no data access, but
  adding signature, issuer, audience, and expiry validation in the gateway is a
  worthwhile defence-in-depth follow-up.
