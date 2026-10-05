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
followed by `/auth-redirect.html` as SPA redirect URIs. Set
`RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID` and
`RAYFIN_PUBLIC_FABRIC_ENTRA_TENANT_ID` in `rayfin/.env`; Rayfin generates the
Vite names in `.env.local`. These are public SPA identifiers, not secrets.

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
│       ├── reconciliationEngine.ts     # Pure comparison engine (shared with the gateway)
│       ├── reconciliationRepository.ts # Rayfin persistence
│       ├── reconciliationSchedule.ts   # Cadence maths
│       ├── reconciliationScheduler.ts  # Due-schedule sweep
│       └── bootstrap.ts           # Reads env, picks the right auth service
└── package.json
```

## Data model and access

Rules, runs, findings, exceptions, audit events, and schedules are
**workspace-shared**: every signed-in user sees and can act on all of them, which
matches the governance tool this app replaces. Records still carry the creating
user so history and audit events stay attributable.

Rayfin caps every `@text()` column at 4000 characters, so large payloads
(row snapshots, summaries, comments) are clamped on write rather than rejected.

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
| `npm run build:fabric` | Build for Fabric deployment (entrypoint for `rayfin up staticapp deploy`) |
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

Note the Function App's HTTPS origin from the `azd up` output.

### 2. Point the app at the gateway

Set `RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL` in `rayfin/.env` to that origin.

### 3. Apply the data schema

```bash
npx rayfin up db apply
```

Required after pulling these changes: it creates the `ReconciliationSchedule`
table and adds the `caseInsensitive` and `trimValues` columns to the rule-field
tables.

### 4. Deploy the app to Fabric

```bash
npm run rayfin:up
```

Add the deployed app URL followed by `/auth-redirect.html` to the Entra SPA
redirect URIs, and the app origin to `allowedRedirectUris` in `rayfin/rayfin.yml`.

### 5. Continuous deployment

`.github/workflows/deploy-fabric.yml` builds, lints and tests on every pull
request, then deploys to Fabric when a PR merges to `main`. Deploys run in the
`fabric` GitHub environment, so attach required reviewers there if you want a
manual approval gate.

The workflow authenticates with `rayfin login --service-principal`, so create an
Entra app registration, give it access to the target Fabric workspace, and
configure:

| Kind | Name | Value |
|------|------|-------|
| Secret | `RAYFIN_CLIENT_ID` | Service principal application (client) ID |
| Secret | `RAYFIN_CLIENT_SECRET` | Service principal client secret |
| Secret | `RAYFIN_TENANT_ID` | Entra tenant ID |
| Secret | `RAYFIN_DEPLOYMENTS_JSON` | Contents of `rayfin/.deployments.json` after a successful local `rayfin up` |
| Variable | `RAYFIN_PUBLIC_FABRIC_ENTRA_CLIENT_ID` | SPA app registration client ID |
| Variable | `RAYFIN_PUBLIC_FABRIC_ENTRA_TENANT_ID` | SPA app registration tenant ID |
| Variable | `RAYFIN_PUBLIC_RECONCILIATION_GATEWAY_URL` | Deployed gateway HTTPS origin |

`RAYFIN_DEPLOYMENTS_JSON` matters: `rayfin/.deployments.json` is gitignored, and
without it `rayfin up` has no record of the existing AppBackend and provisions a
new one on every run. Deploy once locally, then copy that file into the secret.

`rayfin up` applies the database schema as part of the deploy. It refuses
destructive migrations rather than dropping data, so a schema change that would
lose data fails the job and needs a deliberate local `rayfin up db apply --force`.

The Azure gateway is not deployed by this workflow; run `azd up` from `gateway/`
when it changes.

### Hardening before production

- `services.auth.password` in `rayfin/rayfin.yml` is enabled for local dev. Since
  the data is workspace-shared, disable it in production so access is governed by
  Entra/Fabric sign-in alone.
- The gateway's HTTP functions use `authLevel: 'anonymous'` and decode, but do not
  cryptographically verify, the delegated tokens they forward. Fabric REST and SQL
  both verify the tokens themselves, so a forged token gains no data access, but
  adding signature, issuer, audience, and expiry validation in the gateway is a
  worthwhile defence-in-depth follow-up.
